/**
 * 証憑（領収書画像・請求書PDF）一括インポート + 既存仕訳とのマッチング。
 *
 * 主なフロー:
 *  1. ZIPファイルを展開
 *  2. 画像/PDF抽出 → receipts/ フォルダに配置、DB登録
 *  3. ファイル名から日付・金額を推測（可能なら）
 *  4. 既存仕訳とマッチング（日付±3日 + 金額一致）
 *  5. マッチしたら journals.receipt_id を更新
 */

import { db } from "@/lib/localDb";
import JSZip from "jszip";
import type { Receipt, Journal } from "@/types";

const SUPPORTED_EXTS = ["jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "pdf", "tiff"];
const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  heic: "image/heic", heif: "image/heif", webp: "image/webp",
  gif: "image/gif", tiff: "image/tiff", pdf: "application/pdf",
};

export interface ImportedReceipt {
  id: string;
  image_url: string;
  file_hash: string;
  source_filename: string;
  inferred_date: string | null;
  inferred_amount: number | null;
}

export interface BulkImportResult {
  imported: number;
  skipped: number;  // 重複スキップ
  errors: string[];
  receipts: ImportedReceipt[];
}

/**
 * freee ファイルボックスの ZIP ダウンロード時のファイル名 `file_XXXX.jpg` から
 * ファイル番号を抽出する。該当しない場合は null。
 */
function extractFreeeFileNo(filename: string): string | null {
  const base = filename.split("/").pop() || filename;
  const m = base.match(/^file_(\d+)\.[a-zA-Z]+$/);
  return m ? m[1] : null;
}

/**
 * ファイル名から日付を推測する（freee ダウンロード名パターンに対応）。
 *   "20250315_receipt_xxx.jpg" → 2025-03-15
 *   "2025-03-15_receipt.pdf" → 2025-03-15
 *   "2025_03_15 ..." → 2025-03-15
 */
function inferDateFromFilename(filename: string): string | null {
  // YYYYMMDD
  const m1 = filename.match(/(\d{4})(\d{2})(\d{2})/);
  if (m1) {
    const y = parseInt(m1[1], 10);
    const mo = parseInt(m1[2], 10);
    const d = parseInt(m1[3], 10);
    if (y >= 2000 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${m1[1]}-${m1[2]}-${m1[3]}`;
    }
  }
  // YYYY-MM-DD or YYYY/MM/DD or YYYY_MM_DD
  const m2 = filename.match(/(\d{4})[-_/](\d{1,2})[-_/](\d{1,2})/);
  if (m2) {
    const y = parseInt(m2[1], 10);
    const mo = parseInt(m2[2], 10);
    const d = parseInt(m2[3], 10);
    if (y >= 2000 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${m2[1]}-${m2[2].padStart(2, "0")}-${m2[3].padStart(2, "0")}`;
    }
  }
  return null;
}

/**
 * ファイル名から金額を推測（数値として含まれているケース）。
 *   "foo_1500円.jpg" → 1500
 *   "3,500_yen.pdf" → 3500
 *   "receipt_500.jpg" → 500（3桁以上の純粋な数字）
 */
function inferAmountFromFilename(filename: string): number | null {
  // まず "円" / "yen" 付きの明示的な金額
  const m1 = filename.match(/([\d,]+)\s*(?:円|yen|JPY)/i);
  if (m1) {
    const n = parseInt(m1[1].replace(/,/g, ""), 10);
    if (!isNaN(n) && n >= 10 && n <= 99999999) return n;
  }
  return null;
}

export async function importEvidenceZip(file: File): Promise<BulkImportResult> {
  const result: BulkImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
    receipts: [],
  };

  const zipBuf = await file.arrayBuffer();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBuf);
  } catch (e) {
    result.errors.push(`ZIP読み込み失敗: ${(e as Error).message}`);
    return result;
  }

  const { writeFile, mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");
  try {
    await mkdir("receipts", { baseDir: BaseDirectory.AppData, recursive: true });
  } catch {}

  const entries = Object.keys(zip.files).filter((name) => {
    const f = zip.files[name];
    if (f.dir) return false;
    const ext = name.split(".").pop()?.toLowerCase() || "";
    return SUPPORTED_EXTS.includes(ext);
  });

  for (const entryName of entries) {
    const zipEntry = zip.files[entryName];
    try {
      const bytes = new Uint8Array(await zipEntry.async("arraybuffer"));

      // SHA-256 ハッシュで重複チェック
      const hashBuf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
      const hashHex = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const { data: existing } = await db
        .from("receipts")
        .select("id")
        .eq("file_hash", hashHex);
      if (existing && (existing as { id: string }[]).length > 0) {
        result.skipped++;
        continue;
      }

      // ベース名からファイル拡張子と推測情報を取得
      const baseName = entryName.split("/").pop() || entryName;
      const ext = (baseName.split(".").pop() || "jpg").toLowerCase();
      const freeeFileNo = extractFreeeFileNo(baseName);
      const inferredDate = inferDateFromFilename(baseName);
      const inferredAmount = inferAmountFromFilename(baseName);

      // ファイル名は衝突しないよう UUID を付ける
      const safeName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
      const relPath = `receipts/${safeName}`;
      await writeFile(relPath, bytes, { baseDir: BaseDirectory.AppData });

      // ocr_text に freee ファイル番号タグを記録（後段のマッチングで使用）
      let ocrText = `(ZIP取込: ${baseName})`;
      if (freeeFileNo) {
        ocrText = `[freee_file_no:${freeeFileNo}]\n${ocrText}`;
      }

      // date: ファイル番号で既存の仕訳が見つかれば、その日付を優先採用
      // これにより 2025年の領収書画像を 2026年として保存する不整合を防ぐ
      let resolvedDate = inferredDate || new Date().toISOString().split("T")[0];
      if (freeeFileNo) {
        try {
          const { data: matching } = await db
            .from("journals")
            .select("date")
            .like("description", `%[freee_file_no:${freeeFileNo}]%`);
          const m = (matching as { date: string }[] | null) || [];
          if (m.length > 0 && m[0].date) resolvedDate = m[0].date;
        } catch {}
      }

      // DB に insert
      const { data: inserted } = await db
        .from("receipts")
        .insert({
          image_url: `local://${relPath}`,
          vendor_name: null,
          amount: inferredAmount,
          date: resolvedDate,
          status: "pending",
          doc_type: ext === "pdf" ? "invoice" : "receipt",
          file_hash: hashHex,
          ocr_text: ocrText,
        })
        .select()
        .single();

      if (inserted) {
        const r = inserted as { id: string };
        result.receipts.push({
          id: r.id,
          image_url: `local://${relPath}`,
          file_hash: hashHex,
          source_filename: baseName,
          inferred_date: inferredDate,
          inferred_amount: inferredAmount,
        });
        result.imported++;
      }
    } catch (e) {
      result.errors.push(`${entryName}: ${(e as Error).message}`);
    }
  }

  return result;
}

// -------------------------------------------------------------
// 既存仕訳と領収書のマッチング
// -------------------------------------------------------------

export interface MatchResult {
  matched: number;             // 新しく紐付けた件数
  alreadyLinked: number;       // 既に紐付いていた件数
  orphanReceipts: number;      // どの仕訳にもマッチしなかった領収書
  unmatchedJournals: number;   // 証憑なしの仕訳
  details: MatchDetail[];
}

export interface MatchDetail {
  journalId: string;
  receiptId: string;
  date: string;
  amount: number;
  dateDiff: number;
  confidence: "file_no" | "exact" | "close";
}

function extractFreeeFileNoTag(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/\[freee_file_no:(\d+)\]/);
  return m ? m[1] : null;
}

/**
 * 証憑なしの仕訳と、ある receipts を 日付±3日 + 金額一致 でマッチング。
 * 同じ receipt は一仕訳にしか紐付けない (1-to-1 原則)。
 *
 * @param opts.onlyThisIds  マッチ対象の receipt.id を絞り込む（直近インポート分だけ処理など）
 */
export async function matchJournalsAndReceipts(
  opts: { onlyThisIds?: string[]; dateTolerance?: number } = {}
): Promise<MatchResult> {
  const tol = opts.dateTolerance ?? 3;

  // 仕訳を読む（証憑未紐付けのみ）
  const { data: allJournals } = await db.from("journals").select("*");
  const journals = ((allJournals as Journal[] | null) || []).filter((j) => !j.receipt_id);

  // 領収書を読む
  const { data: allReceipts } = await db.from("receipts").select("*");
  let receipts = (allReceipts as Receipt[] | null) || [];
  if (opts.onlyThisIds && opts.onlyThisIds.length > 0) {
    const set = new Set(opts.onlyThisIds);
    receipts = receipts.filter((r) => set.has(r.id));
  }

  // 仕訳の借方合計で金額推定
  const { data: allLines } = await db
    .from("journal_lines")
    .select("journal_id,debit_amount,credit_amount");
  const linesByJournal = new Map<string, number>();
  for (const l of (allLines as { journal_id: string; debit_amount: number; credit_amount: number }[]) || []) {
    if (l.debit_amount && l.debit_amount > 0) {
      linesByJournal.set(l.journal_id, (linesByJournal.get(l.journal_id) || 0) + l.debit_amount);
    }
  }

  const result: MatchResult = {
    matched: 0,
    alreadyLinked: 0,
    orphanReceipts: 0,
    unmatchedJournals: 0,
    details: [],
  };

  const usedReceiptIds = new Set<string>();

  // ===== Pass 1: freee_file_no による完全マッチング（100%精度） =====
  // 領収書 ocr_text に [freee_file_no:1556] が埋まっていて、
  // 仕訳 description にも同じタグがあれば紐付ける。
  const receiptByFileNo = new Map<string, Receipt>();
  for (const r of receipts) {
    const fno = extractFreeeFileNoTag(r.ocr_text);
    if (fno && !receiptByFileNo.has(fno)) receiptByFileNo.set(fno, r);
  }

  for (const j of journals) {
    const fno = extractFreeeFileNoTag(j.description);
    if (!fno) continue;
    const r = receiptByFileNo.get(fno);
    if (!r || usedReceiptIds.has(r.id)) continue;
    await db.from("journals").update({ receipt_id: r.id }).eq("id", j.id);
    usedReceiptIds.add(r.id);
    result.matched++;
    result.details.push({
      journalId: j.id,
      receiptId: r.id,
      date: j.date,
      amount: linesByJournal.get(j.id) || 0,
      dateDiff: 0,
      confidence: "file_no",
    });
  }

  // 再計算: ファイル番号で紐付かなかった仕訳のみ次パスへ
  const journalsAfterPass1 = journals.filter(
    (j) => !result.details.some((d) => d.journalId === j.id)
  );

  // ===== Pass 2: 日付±3日 + 金額一致 のヒューリスティック =====
  for (const j of journalsAfterPass1) {
    const jDate = j.date;
    const jAmount = linesByJournal.get(j.id) || 0;
    if (!jDate || !jAmount) {
      result.unmatchedJournals++;
      continue;
    }

    // 候補: まだ未使用で、日付が ±tol 日内、金額一致
    let best: { r: Receipt; diff: number; confidence: "exact" | "close" } | null = null;
    for (const r of receipts) {
      if (usedReceiptIds.has(r.id)) continue;
      if (r.amount !== jAmount) continue;
      if (!r.date) continue;
      const d1 = new Date(jDate).getTime();
      const d2 = new Date(r.date).getTime();
      const diff = Math.abs((d1 - d2) / 86400000);
      if (diff > tol) continue;
      const confidence: "exact" | "close" = diff === 0 ? "exact" : "close";
      if (!best || diff < best.diff) best = { r, diff, confidence };
    }

    if (best) {
      await db.from("journals").update({ receipt_id: best.r.id }).eq("id", j.id);
      usedReceiptIds.add(best.r.id);
      result.matched++;
      result.details.push({
        journalId: j.id,
        receiptId: best.r.id,
        date: jDate,
        amount: jAmount,
        dateDiff: best.diff,
        confidence: best.confidence,
      });
    } else {
      result.unmatchedJournals++;
    }
  }

  result.orphanReceipts = receipts.length - usedReceiptIds.size;
  result.alreadyLinked = ((allJournals as Journal[]) || []).filter((j) => !!j.receipt_id).length
    - result.matched;

  return result;
}

// -------------------------------------------------------------
// 証憑カバー率の算出
// -------------------------------------------------------------

export interface CoverageStats {
  totalJournals: number;
  journalsWithReceipt: number;
  journalsWithoutReceipt: number;
  totalReceipts: number;
  receiptsLinkedToJournal: number;
  receiptsOrphan: number;
  coveragePercent: number;
}

export async function getEvidenceCoverage(): Promise<CoverageStats> {
  const { data: journals } = await db.from("journals").select("id,receipt_id");
  const allJ = (journals as { id: string; receipt_id: string | null }[]) || [];

  const { data: receipts } = await db.from("receipts").select("id");
  const allR = (receipts as { id: string }[]) || [];

  const linkedReceiptIds = new Set(allJ.filter((j) => j.receipt_id).map((j) => j.receipt_id!));
  const linked = allJ.filter((j) => !!j.receipt_id).length;
  const withoutReceipt = allJ.length - linked;
  const coverage = allJ.length > 0 ? Math.round((linked / allJ.length) * 1000) / 10 : 100;

  return {
    totalJournals: allJ.length,
    journalsWithReceipt: linked,
    journalsWithoutReceipt: withoutReceipt,
    totalReceipts: allR.length,
    receiptsLinkedToJournal: linkedReceiptIds.size,
    receiptsOrphan: allR.length - linkedReceiptIds.size,
    coveragePercent: coverage,
  };
}

// MIME_BY_EXT を外から使う場合用に export（必要なら拡張）
export { MIME_BY_EXT };
