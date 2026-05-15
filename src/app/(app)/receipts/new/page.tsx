"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ReceiptUpload } from "@/components/receipt-upload";
import { AccountSelect } from "@/components/account-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { processReceiptImage } from "@/lib/ocr";
import {
  ocrWithClaude,
  ocrWithClaudeStream,
  fileToBase64,
  getApiKey,
  hasAiOcrConsent,
  setAiOcrConsent,
} from "@/lib/ai-ocr";
import { compressImageForOcr } from "@/lib/image-compression";
import { AiOcrConsentDialog } from "@/components/ai-ocr-consent";
import { AiOcrQuotaBanner } from "@/components/ai-ocr-quota-banner";
import { supabase } from "@/lib/supabase";
import { db } from "@/lib/localDb";
import { prefillFromOcr } from "@/lib/receipt-classifier";
import { toast } from "@/lib/toast";
import type { OcrResult } from "@/types";
import { ArrowLeft, Sparkles, Save, Zap, Inbox as InboxIcon } from "lucide-react";
import Link from "next/link";

export default function NewReceiptPage() {
  // Next.js 16: useSearchParams を使う Component は Suspense 境界の中に置く必要がある。
  // 出力は static export のため、ssr 時には searchParams が null になる前提で
  // Suspense fallback で 1 フレーム遅延させる。
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground p-4">読み込み中...</div>}>
      <NewReceiptPageInner />
    </Suspense>
  );
}

function NewReceiptPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const inboxId = searchParams.get("inbox");
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [useAiOcr, setUseAiOcr] = useState(true);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [ocrUsage, setOcrUsage] = useState<{ used: number; limit: number } | null>(null);
  // 同意ダイアログ: pendingFile を保持しておき、同意後に再試行する
  const [consentOpen, setConsentOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  // ㊇ 受信箱から開いた時のソース表示用
  const [inboxSource, setInboxSource] = useState<{
    id: string;
    fromClaudeJson: boolean;
  } | null>(null);

  const [vendorName, setVendorName] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [accountName, setAccountName] = useState("");

  // 初期化: API キーの有無を確認
  useState(() => {
    getApiKey().then((key) => {
      setHasApiKey(!!key);
      if (!key) setUseAiOcr(false);
    });
  });

  // Round 5 ㊇ + ㊉: ?inbox=<id> で開かれたら photo_inbox から読み出して pre-fill
  // - claude_result_json があれば「前回の AI OCR 結果」を再利用 (㊉)
  // - 無ければ ocr_text を classifyReceiptLines で行分類して候補を埋める (㊇)
  // 画像ファイルは Tauri の read_image_file で読んで File 化し、既存の保存
  // フローに乗せる (Storage upload までは現状の handleSave がやってくれる)
  useEffect(() => {
    if (!inboxId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await db
          .from("photo_inbox")
          .select("id, file_path, ocr_text, claude_result_json")
          .eq("id", inboxId)
          .single();
        const row = data as
          | {
              id: string;
              file_path: string | null;
              ocr_text: string | null;
              claude_result_json: string | null;
            }
          | null;
        if (!row || cancelled) return;

        let usedClaude = false;
        // ㊉ claude_result_json があれば優先 (再 OCR せずに同じ結果を再利用)
        if (row.claude_result_json) {
          try {
            const r = JSON.parse(row.claude_result_json);
            if (r.vendor_name) setVendorName(r.vendor_name);
            if (r.amount != null) setAmount(String(r.amount));
            if (r.date) setDate(r.date);
            if (r.suggested_account_code) {
              setAccountCode(r.suggested_account_code);
              setAccountName(r.suggested_account_name ?? "");
            }
            usedClaude = true;
          } catch {
            // 壊れた JSON は無視して classifier に fallback
          }
        }
        // ㊇ Vision OCR テキストから候補抽出 (claude が無い、または取れなかった場合)
        if (!usedClaude && row.ocr_text) {
          const pf = prefillFromOcr(row.ocr_text);
          if (pf.vendor_name) setVendorName(pf.vendor_name);
          if (pf.amount != null) setAmount(String(pf.amount));
          if (pf.date) setDate(pf.date);
        }

        // 画像ファイルを File 化して既存の保存フローに乗せる
        if (row.file_path) {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            const raw = (await invoke("read_image_file", {
              path: row.file_path,
            })) as Uint8Array | number[];
            const u8 = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
            // 簡易 MIME 判定
            let mime = "image/jpeg";
            if (
              u8.length >= 4 &&
              u8[0] === 0x89 &&
              u8[1] === 0x50 &&
              u8[2] === 0x4e &&
              u8[3] === 0x47
            ) {
              mime = "image/png";
            }
            const fileName = row.file_path.split("/").pop() || "inbox.jpg";
            const file = new File([new Uint8Array(u8).buffer], fileName, { type: mime });
            if (!cancelled) setSelectedFile(file);
          } catch (e) {
            console.warn("[receipts/new] inbox 画像の読込に失敗:", e);
          }
        }

        // フォームを表示するため最小限の ocrResult をセット (raw_text だけ詰める)
        if (!cancelled) {
          setOcrResult({
            raw_text: row.ocr_text ?? "",
            vendor_name: null,
            amount: null,
            date: null,
            suggested_account_code: null,
            suggested_account_name: null,
          });
          setInboxSource({ id: row.id, fromClaudeJson: usedClaude });
        }
      } catch (e) {
        console.warn("[receipts/new] inbox= 読込で失敗:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inboxId]);

  const handleFileSelect = async (file: File) => {
    // AI OCR を使う場合、初回のみ同意を取る
    if (useAiOcr && hasApiKey) {
      const consented = await hasAiOcrConsent();
      if (!consented) {
        setPendingFile(file);
        setConsentOpen(true);
        return;
      }
    }
    await runOcr(file);
  };

  const runOcr = async (file: File) => {
    setIsProcessing(true);
    setError(null);

    try {
      // アップロード前に画像を縮小 (長辺 1600px / JPEG q=0.85)。
      // 4MB の iPhone 写真が ~300KB になるため OCR と Storage の両方が高速化する。
      // Storage にも縮小版を保存するので、ここで selectedFile も差し替える。
      const compressed = await compressImageForOcr(file);
      const workFile = compressed.file;
      setSelectedFile(workFile);
      if (compressed.compressed) {
        const before = (compressed.originalBytes / 1024).toFixed(0);
        const after = (compressed.resultBytes / 1024).toFixed(0);
        console.log(`[ocr] image compressed: ${before}KB → ${after}KB`);
      }

      let result: OcrResult;

      if (useAiOcr && hasApiKey) {
        // Claude API で高精度読み取り
        const apiKey = await getApiKey();
        if (apiKey) {
          const { base64, mediaType } = await fileToBase64(workFile);
          // ストリーミングを優先。途中で取れたフィールドはその場でフォームに反映する。
          // ストリームが落ちた場合は非ストリーミングにフォールバック。
          try {
            const r = await ocrWithClaudeStream(
              base64,
              mediaType,
              apiKey,
              (partial) => {
                if (partial.vendor_name !== undefined) setVendorName(partial.vendor_name);
                if (partial.amount !== undefined && partial.amount !== null) {
                  setAmount(String(partial.amount));
                }
                if (partial.date !== undefined) setDate(partial.date);
              }
            );
            if (r.usage) setOcrUsage(r.usage);
            result = r;
          } catch (streamErr) {
            console.warn("[ocr] streaming failed, falling back:", streamErr);
            const r = await ocrWithClaude(base64, mediaType, apiKey);
            if (r.usage) setOcrUsage(r.usage);
            result = r;
          }
        } else {
          result = await processReceiptImage(workFile);
        }
      } else {
        // 従来の Tesseract OCR
        result = await processReceiptImage(workFile);
      }

      setOcrResult(result);

      if (result.vendor_name) setVendorName(result.vendor_name);
      if (result.amount) setAmount(result.amount.toString());
      if (result.date) setDate(result.date);
      if (result.suggested_account_code) {
        setAccountCode(result.suggested_account_code);
        setAccountName(result.suggested_account_name || "");
      }
    } catch (err) {
      console.error("OCR処理に失敗しました:", err);
      setError(`読み取りに失敗しました: ${(err as Error).message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * 楽観的 UI: クリック直後に画面遷移し、Storage アップロード + DB 書込みは
   * バックグラウンドで継続する。完了/失敗は toast で通知する。
   *
   * 体感的に「保存ボタンを押したら一覧に戻ってる」状態を作る。リスト側は
   * 自動再フェッチしないので、トーストで成功を伝えるのが UX 的に重要。
   *
   * 失敗時はトーストにエラー内容を出す。再アップロードは一覧から手動で。
   */
  const handleSave = () => {
    if (!selectedFile) return;
    if (isSaving) return;
    setIsSaving(true);

    // 遷移前にスナップショットを取る (コンポーネント unmount 後でも参照されるため)
    const snapshot = {
      file: selectedFile,
      ocrText: ocrResult?.raw_text || null,
      vendorName: vendorName || null,
      amount: amount ? parseInt(amount, 10) : null,
      date: date || null,
      accountCode: accountCode || null,
      accountName: accountName || null,
    };

    toast.info("領収書を保存中...");
    router.push("/receipts");

    // fire-and-forget. unmount 後も module-level supabase client + window-event toast で完結する。
    void (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("認証が必要です");

        const fileName = `${user.id}/${Date.now()}-${snapshot.file.name}`;
        const { error: uploadError } = await supabase.storage
          .from("receipts")
          .upload(fileName, snapshot.file);
        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from("receipts")
          .getPublicUrl(fileName);

        const { error: insertError } = await supabase.from("receipts").insert({
          user_id: user.id,
          image_url: urlData.publicUrl,
          ocr_text: snapshot.ocrText,
          vendor_name: snapshot.vendorName,
          amount: snapshot.amount,
          date: snapshot.date,
          account_code: snapshot.accountCode,
          account_name: snapshot.accountName,
          status: "processed",
        });
        if (insertError) throw insertError;

        toast.success("領収書を保存しました");
      } catch (error) {
        console.error("保存に失敗しました:", error);
        toast.error(
          `保存に失敗しました: ${(error as Error).message ?? "不明なエラー"}`
        );
      }
    })();
  };

  const handleSaveAndCreateJournal = () => {
    if (!selectedFile) return;
    if (isSaving) return;
    setIsSaving(true);

    const snapshot = {
      file: selectedFile,
      ocrText: ocrResult?.raw_text || null,
      vendorName: vendorName || null,
      amountStr: amount,
      date: date || null,
      accountCode: accountCode || null,
      accountName: accountName || null,
    };

    toast.info("仕訳を作成中...");
    router.push("/journals");

    void (async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("認証が必要です");

        const fileName = `${user.id}/${Date.now()}-${snapshot.file.name}`;
        await supabase.storage.from("receipts").upload(fileName, snapshot.file);

        const { data: urlData } = supabase.storage
          .from("receipts")
          .getPublicUrl(fileName);

        const amountNum = snapshot.amountStr ? parseInt(snapshot.amountStr, 10) : 0;

        const { data: receipt, error: insertError } = await supabase
          .from("receipts")
          .insert({
            user_id: user.id,
            image_url: urlData.publicUrl,
            ocr_text: snapshot.ocrText,
            vendor_name: snapshot.vendorName,
            amount: snapshot.amountStr ? amountNum : null,
            date: snapshot.date,
            account_code: snapshot.accountCode,
            account_name: snapshot.accountName,
            status: "confirmed",
          })
          .select()
          .single();
        if (insertError) throw insertError;

        const journalDate = snapshot.date || new Date().toISOString().split("T")[0];

        const { data: journal, error: journalError } = await supabase
          .from("journals")
          .insert({
            user_id: user.id,
            date: journalDate,
            description: `${snapshot.vendorName || "不明"} - ${snapshot.accountName || "経費"}`,
            receipt_id: receipt.id,
          })
          .select()
          .single();
        if (journalError) throw journalError;

        const taxAmount = Math.floor((amountNum * 10) / 110);
        const { error: linesError } = await supabase.from("journal_lines").insert([
          {
            journal_id: journal.id,
            account_code: snapshot.accountCode || "699",
            account_name: snapshot.accountName || "雑費",
            debit_amount: amountNum,
            credit_amount: 0,
            tax_code: "P10",
            tax_amount: taxAmount,
          },
          {
            journal_id: journal.id,
            account_code: "100",
            account_name: "現金",
            debit_amount: 0,
            credit_amount: amountNum,
            tax_code: "OUT",
            tax_amount: 0,
          },
        ]);
        if (linesError) throw linesError;

        toast.success("仕訳を作成しました");
      } catch (error) {
        console.error("保存に失敗しました:", error);
        toast.error(
          `保存に失敗しました: ${(error as Error).message ?? "不明なエラー"}`
        );
      }
    })();
  };

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Round 28: Gemini Free Tier 上限超過バナー */}
      <AiOcrQuotaBanner />
      <AiOcrConsentDialog
        open={consentOpen}
        onAgree={async () => {
          await setAiOcrConsent(true);
          setConsentOpen(false);
          if (pendingFile) {
            const f = pendingFile;
            setPendingFile(null);
            await runOcr(f);
          }
        }}
        onDecline={() => {
          setConsentOpen(false);
          const f = pendingFile;
          setPendingFile(null);
          setUseAiOcr(false); // 次回からは Tesseract
          if (f) runOcr(f);
        }}
      />

      <div className="flex items-center gap-4 flex-wrap">
        <Link href="/receipts">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">領収書を登録</h1>
        {inboxSource && (
          // ㊇/㊉: 受信箱から開かれた時に source を明示。
          // 「OCR を再実行せず候補が埋まっている」のは怪しく見える可能性があるため
          // バッジでユーザに伝える。
          <Badge variant="secondary" className="gap-1">
            <InboxIcon className="h-3 w-3" />
            受信箱から
            {inboxSource.fromClaudeJson ? " (前回 AI OCR 結果を再利用)" : " (Vision OCR で pre-fill)"}
          </Badge>
        )}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">画像をアップロード</CardTitle>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                <Zap className="h-3.5 w-3.5" />
                AI読み取り
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={useAiOcr && hasApiKey}
                onClick={() => setUseAiOcr(!useAiOcr)}
                disabled={!hasApiKey}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                  useAiOcr && hasApiKey ? "bg-primary" : "bg-muted"
                } ${!hasApiKey ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    useAiOcr && hasApiKey ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
          </div>
          {!hasApiKey && (
            <p className="text-xs text-muted-foreground mt-1">
              AI読み取りを使うには <Link href="/settings" className="underline text-primary">設定</Link> でライセンスキーを登録してください
            </p>
          )}
        </CardHeader>
        <CardContent>
          <ReceiptUpload onFileSelect={handleFileSelect} isProcessing={isProcessing} />
        </CardContent>
      </Card>

      {ocrResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              {useAiOcr && hasApiKey ? (
                <Zap className="h-4 w-4 text-primary" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {useAiOcr && hasApiKey ? "AI 読み取り結果" : "OCR 読み取り結果"}
              <span className="text-xs font-normal text-muted-foreground">（必ず確認してください）</span>
              {ocrUsage && useAiOcr && hasApiKey && (
                <Badge variant="outline" className="ml-auto font-normal text-xs">
                  今月 {ocrUsage.used} / {ocrUsage.limit} 枚
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {ocrResult.suggested_account_name && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary">自動分類</Badge>
                <span className="text-sm">{ocrResult.suggested_account_name}</span>
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1">
                <Label>店名・取引先</Label>
                <Input
                  value={vendorName}
                  onChange={(e) => setVendorName(e.target.value)}
                  placeholder="店名を入力"
                />
              </div>

              <div className="space-y-1">
                <Label>金額</Label>
                <Input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0"
                />
              </div>

              <div className="space-y-1">
                <Label>日付</Label>
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <Label>勘定科目</Label>
                <AccountSelect
                  value={accountCode}
                  onValueChange={(code, name) => {
                    setAccountCode(code);
                    setAccountName(name);
                  }}
                />
              </div>
            </div>

            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                OCR生テキストを表示
              </summary>
              <pre className="mt-2 p-3 bg-muted rounded-lg text-xs whitespace-pre-wrap max-h-40 overflow-y-auto">
                {ocrResult.raw_text}
              </pre>
            </details>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <div className="flex gap-2 pt-2">
              <Button onClick={() => { setError(null); handleSave(); }} disabled={isSaving} variant="outline">
                <Save className="h-4 w-4 mr-1" />
                領収書のみ保存
              </Button>
              <Button onClick={() => { setError(null); handleSaveAndCreateJournal(); }} disabled={isSaving}>
                <Save className="h-4 w-4 mr-1" />
                保存して仕訳も作成
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
