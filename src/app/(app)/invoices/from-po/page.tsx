"use client";

/**
 * Round 28: 発注書 (PO) を AI OCR で読み取って請求書を自動生成するページ.
 *
 * 流れ:
 *   1. ファイル選択 (画像 or PDF)
 *   2. プレビュー + Vision OCR 起動
 *   3. 抽出結果をフォーム風に表示 (ユーザが確認 / 微修正)
 *   4. 「請求書を作成」で invoices + invoice_items に INSERT
 *   5. /invoices/edit?id=<id> に遷移して最終調整
 *
 * AI OCR 同意が無いと使えない (ai-ocr.ts hasAiOcrConsent と同じガード)。
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Upload, Sparkles, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/lib/toast";
import {
  fileToBase64,
  hasAiOcrConsent,
  setAiOcrConsent,
  getLicenseKey,
} from "@/lib/ai-ocr";
import { AiOcrConsentDialog } from "@/components/ai-ocr-consent";
import {
  ocrPurchaseOrder,
  createInvoiceFromPo,
  type PurchaseOrderResult,
} from "@/lib/po-ocr";

export default function FromPoPage() {
  const router = useRouter();
  const [consent, setConsent] = useState<boolean | null>(null);
  const [hasLicense, setHasLicense] = useState<boolean | null>(null);
  const [consentDialogOpen, setConsentDialogOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [result, setResult] = useState<PurchaseOrderResult | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    void (async () => {
      setConsent(await hasAiOcrConsent());
      setHasLicense(Boolean(await getLicenseKey()));
    })();
    return () => {
      // Blob URL 後始末
      if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ファイルを受け取って即 OCR 開始 (D&D / クリック選択どちらからも)
  const acceptFile = (f: File) => {
    if (!f) return;
    // 画像 or PDF のみ
    if (!f.type.startsWith("image/") && f.type !== "application/pdf") {
      toast.error("画像 (JPG/PNG/HEIC) または PDF を選択してください");
      return;
    }
    setFile(f);
    setResult(null);
    if (previewUrl?.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(f));
    // 自動で OCR 起動
    void runOcr(f);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) acceptFile(f);
    // 同じファイルを連続で選んだ時にも change を発火させる
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) acceptFile(f);
  };

  // runOcr は引数で渡された file (or state) を使う。
  // acceptFile から呼ぶ時は state 更新待ち不要にするため引数渡しを優先。
  const runOcr = async (targetFile?: File) => {
    const f = targetFile ?? file;
    if (!f) return;
    setOcrBusy(true);
    try {
      let { base64, mediaType } = await fileToBase64(f);
      // PDF は Tauri 側 (sips) で PNG にラスタライズしてから送る。
      // 一部の日本語 PDF はテキストレイヤが文字化けしていて Gemini が
      // PDF 直読みだと「中身が空っぽ」になるため、画像化して回避する。
      if (mediaType === "application/pdf") {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          const png = (await invoke("pdf_to_png_base64", {
            pdfBase64: base64,
          })) as string;
          base64 = png;
          mediaType = "image/png";
        } catch (e) {
          throw new Error(
            `PDF の変換に失敗しました: ${e instanceof Error ? e.message : String(e)}。` +
              `プレビュー等で PNG / JPEG に書き出してから再アップロードしてみてください。`,
          );
        }
      }
      const r = await ocrPurchaseOrder(base64, mediaType);
      setResult(r);
      toast.success("発注書を読み取りました — 内容を確認してください");
    } catch (e) {
      toast.error(`OCR に失敗: ${(e as Error).message}`);
    } finally {
      setOcrBusy(false);
    }
  };

  const create = async () => {
    if (!result) return;
    setCreating(true);
    try {
      const invoiceId = await createInvoiceFromPo(result);
      toast.success("請求書を作成しました — 編集画面で最終調整できます");
      router.push(`/invoices/edit?id=${invoiceId}`);
    } catch (e) {
      toast.error(`請求書作成に失敗: ${(e as Error).message}`);
      setCreating(false);
    }
  };

  // 結果の単純な編集 (ユーザが OCR 結果を微修正)
  const updateResult = (patch: Partial<PurchaseOrderResult>) => {
    setResult((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  if (consent === null || hasLicense === null) {
    return <p className="text-sm text-muted-foreground">読み込み中…</p>;
  }
  if (!consent || !hasLicense) {
    return (
      <div className="space-y-4 max-w-2xl">
        <div className="flex items-center gap-4">
          <Link href="/invoices">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              戻る
            </Button>
          </Link>
          <h1 className="text-2xl font-bold">発注書から請求書を作成</h1>
        </div>
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="py-6 space-y-4">
            <p className="text-sm font-medium text-amber-900">
              この機能を使うには、以下の 2 ステップを設定画面で完了してください
            </p>

            <div className="space-y-2 text-sm">
              <div className="flex items-start gap-2">
                <span
                  className={
                    consent
                      ? "text-green-600 font-mono w-6 text-center"
                      : "text-red-600 font-mono w-6 text-center"
                  }
                >
                  {consent ? "✓" : "✗"}
                </span>
                <div className="flex-1">
                  <p className="font-medium text-amber-900">
                    1. AI OCR の利用に同意する
                  </p>
                  <p className="text-xs text-amber-800">
                    発注書画像を AI OCR (Gemini 経由) に送って読み取ることへの同意。
                  </p>
                  {!consent && (
                    <Button
                      size="sm"
                      className="mt-1.5 h-7"
                      onClick={() => setConsentDialogOpen(true)}
                    >
                      <Sparkles className="h-3.5 w-3.5 mr-1" />
                      同意する
                    </Button>
                  )}
                </div>
              </div>
              <div className="flex items-start gap-2">
                <span
                  className={
                    hasLicense
                      ? "text-green-600 font-mono w-6 text-center"
                      : "text-red-600 font-mono w-6 text-center"
                  }
                >
                  {hasLicense ? "✓" : "✗"}
                </span>
                <div className="flex-1">
                  <p className="font-medium text-amber-900">
                    2. ライセンスキーを登録する
                  </p>
                  <p className="text-xs text-amber-800">
                    AI OCR API の呼び出し枠を管理するライセンスキー。
                    無料プランでも月 30 枚まで使えます。
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Link href="/settings">
                <Button size="sm">
                  設定画面で AI OCR を有効化する
                </Button>
              </Link>
              <Link href="/invoices/edit/">
                <Button size="sm" variant="outline" title="AI を使わず手入力で請求書を作る">
                  手入力で請求書を作る
                </Button>
              </Link>
            </div>

            <p className="text-[11px] text-amber-700 pt-2 border-t border-amber-200">
              ※ 既存の領収書スキャンの AI OCR と同じ枠を使います。
              すでに使ってる方は同意済み&ライセンス登録済みの可能性があります —
              設定画面で「AI 読み取り」セクションを確認してください。
            </p>
          </CardContent>
        </Card>

        <AiOcrConsentDialog
          open={consentDialogOpen}
          onAgree={async () => {
            await setAiOcrConsent(true);
            setConsent(true);
            setConsentDialogOpen(false);
            toast.success("AI 読み取りに同意しました");
          }}
          onDecline={() => setConsentDialogOpen(false)}
        />
      </div>
    );
  }

  const fmt = (n: number | null | undefined) =>
    n == null ? "-" : new Intl.NumberFormat("ja-JP").format(n);

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Link href="/invoices">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            請求書一覧へ
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileText className="h-5 w-5" />
            発注書から請求書を作成
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            発注書の画像 / PDF を読み取り、請求書のたたき台を自動生成します。
          </p>
        </div>
      </div>

      {/* 1) ファイルをドロップ → 自動 OCR */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="h-4 w-4" />1. 発注書をドロップ
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* D&D ゾーン: ドロップ or クリックでファイル選択 → 自動 OCR */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!ocrBusy && !creating) setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              if (ocrBusy || creating) {
                e.preventDefault();
                return;
              }
              onDrop(e);
            }}
            onClick={() => {
              if (!ocrBusy && !creating) {
                document.getElementById("po-file-input")?.click();
              }
            }}
            className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors select-none ${
              ocrBusy || creating ? "cursor-not-allowed opacity-80" : "cursor-pointer"
            } ${
              dragActive
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-primary/50"
            }`}
          >
            {ocrBusy ? (
              <div className="flex flex-col items-center gap-2 py-4">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm font-medium">AI で読み取り中…</p>
                <p className="text-xs text-muted-foreground">
                  Gemini で発注書を解析しています (10〜20 秒)
                </p>
              </div>
            ) : previewUrl && file ? (
              <div className="flex items-start gap-3 text-left">
                <div className="w-32 h-32 border rounded overflow-hidden bg-muted flex items-center justify-center flex-shrink-0">
                  {file.type.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previewUrl}
                      alt="preview"
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <FileText className="h-10 w-10 text-muted-foreground" />
                  )}
                </div>
                <div className="flex-1 text-sm">
                  <p className="font-medium truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {Math.round(file.size / 1024)} KB · {file.type || "不明な形式"}
                  </p>
                  {result ? (
                    <p className="text-xs text-green-700 mt-2 inline-flex items-center gap-1">
                      <Sparkles className="h-3 w-3" />
                      読み取り完了 — 下の結果を確認してください
                    </p>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7"
                      onClick={(e) => {
                        e.stopPropagation();
                        void runOcr(file);
                      }}
                    >
                      <Sparkles className="h-3 w-3 mr-1" />
                      もう一度読み取る
                    </Button>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-2">
                    別のファイルに差し替えるにはここをクリックまたは新しいファイルをドロップ
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-4">
                <Upload className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm font-medium">
                  発注書をここにドラッグ&ドロップ
                </p>
                <p className="text-xs text-muted-foreground">
                  またはクリックしてファイルを選択 (画像 / PDF) — ドロップ即 AI 解析が走ります
                </p>
              </div>
            )}
          </div>
          {/* 隠し input — D&D ゾーンクリック時に発火 */}
          <input
            id="po-file-input"
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={onFileChange}
            disabled={ocrBusy || creating}
          />
        </CardContent>
      </Card>

      {/* 2) OCR 結果プレビュー */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-purple-600" />
              2. 読み取り結果を確認 (必要なら微修正)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <Label>請求先 (発注元)</Label>
                <Input
                  value={result.partner_name ?? ""}
                  onChange={(e) =>
                    updateResult({ partner_name: e.target.value || null })
                  }
                  placeholder="例: 株式会社サンプル"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  ※ 「請求書を作成」を押すと、この取引先 (住所も含む) は
                  <b>取引先マスタにも自動登録</b> されます (既存なら ID 紐付けのみ)
                </p>
              </div>
              <div>
                <Label>件名・案件名</Label>
                <Input
                  value={result.subject ?? ""}
                  onChange={(e) =>
                    updateResult({ subject: e.target.value || null })
                  }
                  placeholder="(任意)"
                />
              </div>
              <div>
                <Label>発行日</Label>
                <Input
                  type="date"
                  value={result.issue_date ?? ""}
                  onChange={(e) =>
                    updateResult({ issue_date: e.target.value || null })
                  }
                />
              </div>
              <div>
                <Label>支払期限</Label>
                <Input
                  type="date"
                  value={result.due_date ?? ""}
                  onChange={(e) =>
                    updateResult({ due_date: e.target.value || null })
                  }
                />
              </div>
              <div>
                <Label>発注書番号</Label>
                <Input
                  value={result.po_number ?? ""}
                  onChange={(e) =>
                    updateResult({ po_number: e.target.value || null })
                  }
                />
              </div>
              <div>
                <Label>住所</Label>
                <Input
                  value={result.partner_address ?? ""}
                  onChange={(e) =>
                    updateResult({ partner_address: e.target.value || null })
                  }
                />
              </div>
            </div>

            <div className="border rounded-md">
              <div className="grid grid-cols-12 gap-2 px-3 py-2 border-b text-xs font-medium bg-muted/50">
                <div className="col-span-5">品目</div>
                <div className="col-span-2 text-right">単価</div>
                <div className="col-span-2 text-right">数量</div>
                <div className="col-span-3 text-right">金額</div>
              </div>
              {result.items.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  品目が抽出されませんでした。次の編集画面で追加できます。
                </p>
              ) : (
                result.items.map((it, idx) => (
                  <div
                    key={idx}
                    className="grid grid-cols-12 gap-2 px-3 py-1.5 border-b last:border-0 text-sm"
                  >
                    <div className="col-span-5 truncate" title={it.description}>
                      {it.description}
                    </div>
                    <div className="col-span-2 text-right tabular-nums">
                      {fmt(it.unit_price)}
                    </div>
                    <div className="col-span-2 text-right tabular-nums">
                      {it.quantity} {it.unit ?? ""}
                    </div>
                    <div className="col-span-3 text-right tabular-nums">
                      ¥{fmt(it.amount)}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* 源泉徴収税 (個人事業主の報酬) を編集可能に */}
            <div className="flex items-center justify-end gap-3 text-sm pt-2">
              <Label htmlFor="po-withholding" className="text-xs text-muted-foreground">
                源泉徴収税 (10.21% 等):
              </Label>
              <Input
                id="po-withholding"
                type="text"
                inputMode="numeric"
                value={result.withholding_tax != null ? String(result.withholding_tax) : ""}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^0-9]/g, "");
                  updateResult({ withholding_tax: raw === "" ? null : Number(raw) });
                }}
                placeholder="0"
                className="w-32 text-right tabular-nums"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                title="小計 × 10.21% で源泉徴収税を自動計算"
                onClick={() => {
                  const s = result.subtotal ?? 0;
                  updateResult({ withholding_tax: Math.floor(s * 0.1021) });
                }}
              >
                自動計算
              </Button>
            </div>

            <div className="flex justify-end gap-4 text-sm pt-2 border-t pt-3">
              <span>
                小計: <b className="tabular-nums">¥{fmt(result.subtotal)}</b>
              </span>
              <span>
                消費税: <b className="tabular-nums">¥{fmt(result.tax_amount)}</b>
              </span>
              {(result.withholding_tax ?? 0) > 0 && (
                <span className="text-red-700">
                  − 源泉徴収: <b className="tabular-nums">¥{fmt(result.withholding_tax)}</b>
                </span>
              )}
              <span>
                請求金額:{" "}
                <b className="text-base tabular-nums">
                  ¥
                  {fmt(
                    (result.subtotal ?? 0) +
                      (result.tax_amount ?? 0) -
                      (result.withholding_tax ?? 0),
                  )}
                </b>
              </span>
            </div>

            {result.usage && (
              <p className="text-[11px] text-muted-foreground">
                今月の AI OCR 利用: {result.usage.used}/{result.usage.limit} 件
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => setResult(null)}
                disabled={creating}
              >
                やり直す
              </Button>
              <Button onClick={() => void create()} disabled={creating}>
                {creating ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    作成中…
                  </>
                ) : (
                  <>請求書を作成 → 編集画面へ</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 3) ガイド */}
      {!result && !ocrBusy && (
        <Card className="bg-muted/30">
          <CardContent className="py-4 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">使い方</p>
            <ol className="list-decimal pl-5 space-y-0.5">
              <li>発注書 (PDF or 画像) をドロップ — 自動で AI 解析が走ります (~10 秒)</li>
              <li>抽出された請求先 / 品目 / 金額・源泉徴収を確認、必要なら微修正</li>
              <li>「請求書を作成」で <Badge variant="outline" className="text-[10px]">draft</Badge> 状態の請求書ができる</li>
              <li>編集画面で発行 → 送付 (PDF ダウンロード)</li>
            </ol>
            <p className="pt-2">
              ※ AI OCR の利用枠は領収書 OCR と共通カウントです。
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
