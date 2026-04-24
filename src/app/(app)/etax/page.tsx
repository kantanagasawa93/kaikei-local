"use client";

/**
 * e-Tax 提出ページ（新版）。
 *
 * 機能:
 *   1. 納税者情報 (/settings/etax) と tax_returns から RKO0010 XTX を生成
 *   2. 仕訳帳を集計して青色申告決算書 (KOA210) データを組み込み
 *   3. 消費税申告 XTX (RSH0010/0030) も別ファイルで生成可能
 *   4. ダウンロード → e-Tax Web版 で外部署名・送信を案内
 *   5. 送信履歴を tax_returns.etax_submission_id で管理
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileCheck,
  Download,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Settings,
  FileText,
  ArrowRight,
  Eye,
  EyeOff,
} from "lucide-react";
import type {
  TaxReturn,
  JournalLine,
  WithholdingSlip,
  FixedAsset,
  FixedAssetDepreciation,
} from "@/types";
import {
  buildShotokuShinkokuXtx,
  buildEtaxConfirmationPdf,
  buildConsumptionTaxStandardXtx,
  buildConsumptionTaxSimplifiedFromAggregate,
  buildConsumptionTaxStandardFromAggregate,
  taxReturnToIncomeReturnData,
  aggregateBlueReturnData,
  aggregateBalanceSheet,
  withholdingSlipsToIncomeDetails,
  fixedAssetsToDepreciationItems,
  loadTaxpayerInfo,
  validateTaxpayer,
  splitErrors,
  type EtaxContext,
  type TaxpayerInfo,
  type JournalLike,
} from "@/lib/etax";

type ConsumptionTaxType = "exempt" | "simplified" | "standard" | "invoice";

export default function EtaxPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear - 1);

  const [taxpayer, setTaxpayer] = useState<TaxpayerInfo | null>(null);
  const [taxReturn, setTaxReturn] = useState<TaxReturn | null>(null);
  const [consumptionType, setConsumptionType] = useState<ConsumptionTaxType>("exempt");
  const [kazeiUriage, setKazeiUriage] = useState<number>(0);
  const [shiireZei, setShiireZei] = useState<number>(0);
  const [jigyoKubun, setJigyoKubun] = useState<1 | 2 | 3 | 4 | 5 | 6>(5);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastGenerated, setLastGenerated] = useState<{
    shotoku?: { name: string; bytes: Blob; xml: string };
    shohi?: { name: string; bytes: Blob; xml: string };
    pdf?: { name: string; bytes: Blob; url: string };
  }>({});
  // 「生成済みのXTX/PDFを画面上で見る」プレビュー切替
  const [preview, setPreview] = useState<"none" | "shotoku" | "shohi" | "pdf">(
    "none"
  );

  // ── 初期読み込み ──
  useEffect(() => {
    (async () => {
      const info = await loadTaxpayerInfo();
      setTaxpayer(info);
    })();
  }, []);

  // アンマウント時に PDF Object URL を破棄
  useEffect(() => {
    return () => {
      setLastGenerated((p) => {
        if (p.pdf?.url) URL.revokeObjectURL(p.pdf.url);
        return p;
      });
    };
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("tax_returns")
        .select("*")
        .eq("year", year)
        .single();
      setTaxReturn(data || null);
      if (data) {
        setConsumptionType(data.consumption_tax_type || "exempt");
      }
    })();
  }, [year]);

  // ── バリデーション ──
  const taxpayerValidation = taxpayer
    ? splitErrors(validateTaxpayer(taxpayer))
    : null;
  const canGenerate =
    taxpayer && taxpayerValidation?.errors.length === 0 && !!taxReturn;

  // ── 生成: 所得税申告XTX (RKO0010) ──
  const handleGenerateShotoku = async () => {
    if (!taxpayer || !taxReturn) return;
    setBusy(true);
    setMessage(null);
    try {
      const ctx: EtaxContext = {
        fiscalYear: year,
        sakuseiDay: new Date().toISOString().slice(0, 10),
        softName: "kaikei",
        vendorName: "Personal",
        taxpayer,
      };

      // 仕訳・源泉徴収票・固定資産を全て読み込み、XTX に必要な集計を行う
      const startDate = `${year}-01-01`;
      const endDate = `${year}-12-31`;

      // 期末残高用に、当年+過去全仕訳を取得 (年末BS計算)
      const [{ data: journalsAll }, { data: slips }, { data: assets }, { data: deps }] =
        await Promise.all([
          supabase
            .from("journals")
            .select("id, date")
            .lte("date", endDate),
          supabase.from("withholding_slips").select("*").eq("year", year),
          supabase.from("fixed_assets").select("*"),
          supabase
            .from("fixed_asset_depreciations")
            .select("*")
            .eq("fiscal_year", year),
        ]);

      const journalIdsAll: string[] = (journalsAll || []).map(
        (j: { id: string }) => j.id
      );

      const lineMap: Record<string, JournalLine[]> = {};
      if (journalIdsAll.length > 0) {
        // チャンクに分けて取得 (in() が長過ぎないように)
        const chunkSize = 500;
        for (let i = 0; i < journalIdsAll.length; i += chunkSize) {
          const chunk = journalIdsAll.slice(i, i + chunkSize);
          const { data: lines } = await supabase
            .from("journal_lines")
            .select("journal_id, account_code, debit_amount, credit_amount")
            .in("journal_id", chunk);
          for (const l of (lines as JournalLine[]) || []) {
            if (!lineMap[l.journal_id]) lineMap[l.journal_id] = [];
            lineMap[l.journal_id].push(l);
          }
        }
      }

      const journalsAllWithLines: JournalLike[] = (journalsAll || []).map(
        (j: { id: string; date: string }) => ({
          id: j.id,
          date: j.date,
          lines: (lineMap[j.id] || []).map((l) => ({
            account_code: l.account_code,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
          })),
        })
      );

      // 当年分のみの journals は date フィルタで抽出
      const journalsYear = journalsAllWithLines.filter(
        (j) => j.date >= startDate && j.date <= endDate
      );

      const income = taxReturnToIncomeReturnData(taxReturn);

      // ABD (所得の内訳) を源泉徴収票から
      if (slips && slips.length > 0) {
        income.income_details = withholdingSlipsToIncomeDetails(
          slips as WithholdingSlip[]
        );
      }

      let blue: ReturnType<typeof aggregateBlueReturnData> | undefined;
      if (taxReturn.return_type === "blue") {
        blue = aggregateBlueReturnData(taxReturn, journalsYear);
        // 貸借対照表を全仕訳から集計
        blue.bs = aggregateBalanceSheet(year, journalsAllWithLines);
        // 減価償却明細を固定資産から
        if (assets && deps) {
          blue.depreciation = fixedAssetsToDepreciationItems(
            assets as FixedAsset[],
            deps as FixedAssetDepreciation[],
            year
          );
        }
      }

      const xtx = buildShotokuShinkokuXtx(ctx, { income, blue });
      const blob = new Blob([xtx.xml], { type: "application/xml" });

      // 内容確認用 PDF も一緒に生成 (視認用)
      const pdfBytes = await buildEtaxConfirmationPdf({
        taxpayer,
        year,
        income,
        blue,
      });
      const pdfBlob = new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" });
      const pdfName = `kakutei_shinkoku_${year}_confirm.pdf`;

      // 既存の PDF Object URL があれば破棄
      setLastGenerated((p) => {
        if (p.pdf?.url) URL.revokeObjectURL(p.pdf.url);
        return {
          ...p,
          shotoku: { name: xtx.suggestedFileName, bytes: blob, xml: xtx.xml },
          pdf: {
            name: pdfName,
            bytes: pdfBlob,
            url: URL.createObjectURL(pdfBlob),
          },
        };
      });
      setMessage(
        `所得税申告 XTX 生成完了: ${xtx.suggestedFileName} (${xtx.xml.length.toLocaleString()} bytes)\n内容確認用PDF: ${pdfName}`
      );
    } catch (e) {
      setMessage(`生成失敗: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // ── 生成: 消費税XTX (RSH0010 or RSH0030) ──
  const handleGenerateShohi = async () => {
    if (!taxpayer || !taxReturn) return;
    if (consumptionType !== "standard" && consumptionType !== "simplified") {
      setMessage("免税事業者・インボイス制度のみの方は消費税申告は不要です。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const ctx: EtaxContext = {
        fiscalYear: year,
        sakuseiDay: new Date().toISOString().slice(0, 10),
        softName: "kaikei",
        vendorName: "Personal",
        taxpayer,
      };

      if (consumptionType === "standard") {
        const d = buildConsumptionTaxStandardFromAggregate({
          year,
          kazeiUri: kazeiUriage,
          shiireZei,
        });
        const xtx = buildConsumptionTaxStandardXtx(ctx, d);
        const blob = new Blob([xtx.xml], { type: "application/xml" });
        setLastGenerated((p) => ({
          ...p,
          shohi: { name: xtx.suggestedFileName, bytes: blob, xml: xtx.xml },
        }));
        setMessage(
          `消費税申告 (原則) XTX 生成完了: ${xtx.suggestedFileName}`
        );
      } else {
        // 簡易課税
        const d = buildConsumptionTaxSimplifiedFromAggregate({
          year,
          kazeiUri: kazeiUriage,
          jigyoKubun,
        });
        // 簡易課税XTX は別ビルダー (rsh0030) に渡す
        const { buildConsumptionTaxSimplifiedXtx } = await import(
          "@/lib/etax"
        );
        const xtx = buildConsumptionTaxSimplifiedXtx(ctx, d);
        const blob = new Blob([xtx.xml], { type: "application/xml" });
        setLastGenerated((p) => ({
          ...p,
          shohi: { name: xtx.suggestedFileName, bytes: blob, xml: xtx.xml },
        }));
        setMessage(
          `消費税申告 (簡易) XTX 生成完了: ${xtx.suggestedFileName}`
        );
      }
    } catch (e) {
      setMessage(`生成失敗: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // ── DL ──
  const downloadBlob = (name: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // ── e-Tax Web版を開く ──
  // clientweb.e-tax.nta.go.jp のルートは 403 を返す仕様のため、
  // 公式ログイン画面 (個人) を直接開く。
  const openEtaxWeb = async () => {
    const url = "https://login.e-tax.nta.go.jp/login/reception/loginIndividual";
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  // ── 送信履歴登録 ──
  const markSubmitted = async () => {
    if (!taxReturn) return;
    const submissionId = `ETAX-${year}-${Date.now().toString(36).toUpperCase()}`;
    await supabase
      .from("tax_returns")
      .update({
        status: "submitted",
        etax_submission_id: submissionId,
        etax_submitted_at: new Date().toISOString(),
      })
      .eq("id", taxReturn.id);
    setMessage(`送信履歴を記録しました (ID: ${submissionId})`);
    const { data } = await supabase
      .from("tax_returns")
      .select("*")
      .eq("year", year)
      .single();
    setTaxReturn(data || null);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">e-Tax 提出</h1>
        <Select value={year.toString()} onValueChange={(v) => v && setYear(parseInt(v))}>
          <SelectTrigger className="w-32">
            <SelectValue>{year}年分</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: 5 }, (_, i) => currentYear - 1 - i).map((y) => (
              <SelectItem key={y} value={y.toString()}>
                {y}年分
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {message && (
        <div className="rounded-md border px-4 py-2 text-sm bg-blue-50 border-blue-200 text-blue-800 whitespace-pre-wrap">
          {message}
        </div>
      )}

      {/* ステップ1: 前提確認 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileCheck className="h-4 w-4" />
            準備状況
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* 納税者情報 */}
          <div className="flex items-start gap-3">
            {taxpayer && taxpayerValidation?.errors.length === 0 ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
            )}
            <div className="flex-1">
              <p className="font-medium">納税者情報</p>
              {taxpayer && taxpayerValidation?.errors.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {taxpayer.name} / 税務署: {taxpayer.zeimusho_nm} / 利用者識別番号: **{taxpayer.riyosha_shikibetsu_bango.slice(-4)}
                </p>
              ) : (
                <p className="text-sm text-yellow-700">
                  未登録または未入力項目があります。設定してください。
                </p>
              )}
              <Link href="/settings/etax/">
                <Button variant="outline" size="sm" className="mt-1">
                  <Settings className="h-3.5 w-3.5 mr-1" />
                  納税者情報を編集
                </Button>
              </Link>
            </div>
          </div>

          {/* 確定申告計算 */}
          <div className="flex items-start gap-3">
            {taxReturn ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="h-5 w-5 text-yellow-600 flex-shrink-0 mt-0.5" />
            )}
            <div className="flex-1">
              <p className="font-medium">確定申告 計算</p>
              {taxReturn ? (
                <p className="text-sm text-muted-foreground">
                  {taxReturn.return_type === "blue" ? "青色申告" : "白色申告"} /
                  収入 ¥{taxReturn.revenue_total.toLocaleString()} / 所得 ¥
                  {taxReturn.income_total.toLocaleString()} / 納税額 ¥
                  {taxReturn.tax_due.toLocaleString()}
                </p>
              ) : (
                <p className="text-sm text-yellow-700">
                  {year}年分の計算がまだです。確定申告ページで計算してください。
                </p>
              )}
              <Link href="/tax-return/">
                <Button variant="outline" size="sm" className="mt-1">
                  <FileText className="h-3.5 w-3.5 mr-1" />
                  確定申告ページ
                </Button>
              </Link>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ステップ2: 所得税申告XTX生成 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">① 所得税申告 XTX 生成</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            確定申告書 (KOA020) と{" "}
            {taxReturn?.return_type === "blue" && "青色申告決算書 (KOA210) を"}
            含む 1つの XTX ファイル (RKO0010) を生成します。e-Tax Web版の
            「作成した申告・申請データを表示」メニューから取り込めます。
          </p>
          <div className="flex gap-2 flex-wrap">
            <Button onClick={handleGenerateShotoku} disabled={!canGenerate || busy}>
              <FileText className="h-4 w-4 mr-1" />
              所得税申告 XTX を生成
            </Button>
            {lastGenerated.shotoku && (
              <>
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadBlob(
                      lastGenerated.shotoku!.name,
                      lastGenerated.shotoku!.bytes
                    )
                  }
                >
                  <Download className="h-4 w-4 mr-1" />
                  XTX をダウンロード
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setPreview(preview === "shotoku" ? "none" : "shotoku")
                  }
                >
                  {preview === "shotoku" ? (
                    <EyeOff className="h-4 w-4 mr-1" />
                  ) : (
                    <Eye className="h-4 w-4 mr-1" />
                  )}
                  XTXの中身
                </Button>
              </>
            )}
            {lastGenerated.pdf && (
              <>
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadBlob(
                      lastGenerated.pdf!.name,
                      lastGenerated.pdf!.bytes
                    )
                  }
                >
                  <Download className="h-4 w-4 mr-1" />
                  確認用PDF
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setPreview(preview === "pdf" ? "none" : "pdf")}
                >
                  {preview === "pdf" ? (
                    <EyeOff className="h-4 w-4 mr-1" />
                  ) : (
                    <Eye className="h-4 w-4 mr-1" />
                  )}
                  PDFを画面で見る
                </Button>
              </>
            )}
          </div>
          {lastGenerated.shotoku && (
            <p className="text-xs text-muted-foreground font-mono">
              {lastGenerated.shotoku.name}
              {lastGenerated.pdf && ` / ${lastGenerated.pdf.name}`}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ステップ3: 消費税申告XTX生成 (課税事業者のみ) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">② 消費税申告 XTX 生成 (該当者のみ)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>消費税の申告区分</Label>
            <Select
              value={consumptionType}
              onValueChange={(v) => v && setConsumptionType(v as ConsumptionTaxType)}
            >
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="exempt">免税事業者 (申告不要)</SelectItem>
                <SelectItem value="standard">原則課税</SelectItem>
                <SelectItem value="simplified">簡易課税</SelectItem>
                <SelectItem value="invoice">インボイス 2割特例</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {(consumptionType === "standard" || consumptionType === "simplified") && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>課税売上 (税抜・年間合計)</Label>
                <Input
                  type="number"
                  value={kazeiUriage || ""}
                  onChange={(e) => setKazeiUriage(parseInt(e.target.value || "0", 10))}
                />
              </div>
              {consumptionType === "standard" && (
                <div>
                  <Label>仕入税額控除の合計</Label>
                  <Input
                    type="number"
                    value={shiireZei || ""}
                    onChange={(e) => setShiireZei(parseInt(e.target.value || "0", 10))}
                  />
                </div>
              )}
              {consumptionType === "simplified" && (
                <div>
                  <Label>事業区分</Label>
                  <Select
                    value={String(jigyoKubun)}
                    onValueChange={(v) => v && setJigyoKubun(parseInt(v) as 1|2|3|4|5|6)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">第1種 卸売業 (90%)</SelectItem>
                      <SelectItem value="2">第2種 小売業 (80%)</SelectItem>
                      <SelectItem value="3">第3種 製造業等 (70%)</SelectItem>
                      <SelectItem value="4">第4種 その他 (60%)</SelectItem>
                      <SelectItem value="5">第5種 サービス業等 (50%)</SelectItem>
                      <SelectItem value="6">第6種 不動産業 (40%)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          )}

          {consumptionType === "invoice" && (
            <p className="text-sm text-yellow-700">
              ⚠️ インボイス2割特例は現在の実装でカバーしていません。国税庁「確定申告書等作成コーナー」を利用してください。
            </p>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleGenerateShohi}
              disabled={
                !canGenerate ||
                busy ||
                (consumptionType !== "standard" && consumptionType !== "simplified")
              }
              variant={consumptionType === "exempt" ? "ghost" : "default"}
            >
              <FileText className="h-4 w-4 mr-1" />
              消費税申告 XTX を生成
            </Button>
            {lastGenerated.shohi && (
              <>
                <Button
                  variant="outline"
                  onClick={() =>
                    downloadBlob(
                      lastGenerated.shohi!.name,
                      lastGenerated.shohi!.bytes
                    )
                  }
                >
                  <Download className="h-4 w-4 mr-1" />
                  ダウンロード
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    setPreview(preview === "shohi" ? "none" : "shohi")
                  }
                >
                  {preview === "shohi" ? (
                    <EyeOff className="h-4 w-4 mr-1" />
                  ) : (
                    <Eye className="h-4 w-4 mr-1" />
                  )}
                  XTXの中身
                </Button>
              </>
            )}
          </div>
          {lastGenerated.shohi && (
            <p className="text-xs text-muted-foreground font-mono">
              {lastGenerated.shohi.name}
            </p>
          )}
        </CardContent>
      </Card>

      {/* プレビューパネル (XTX/PDFの中身を画面で確認) */}
      {preview !== "none" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span>
                {preview === "shotoku" && "所得税申告 XTX の中身"}
                {preview === "shohi" && "消費税申告 XTX の中身"}
                {preview === "pdf" && "確認用 PDF プレビュー"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPreview("none")}
              >
                <EyeOff className="h-4 w-4 mr-1" />
                閉じる
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {preview === "shotoku" && lastGenerated.shotoku && (
              <pre className="text-xs font-mono bg-muted/50 border rounded-md p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-all">
                {lastGenerated.shotoku.xml}
              </pre>
            )}
            {preview === "shohi" && lastGenerated.shohi && (
              <pre className="text-xs font-mono bg-muted/50 border rounded-md p-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-all">
                {lastGenerated.shohi.xml}
              </pre>
            )}
            {preview === "pdf" && lastGenerated.pdf && (
              <iframe
                src={lastGenerated.pdf.url}
                className="w-full h-[70vh] border rounded-md bg-white"
                title="確認用PDF"
              />
            )}
            <p className="text-xs text-muted-foreground mt-2">
              ※ アップロード前に中身を目視確認できます。誤りがあれば設定や計算値を直して再生成してください。
            </p>
          </CardContent>
        </Card>
      )}

      {/* ステップ4: 内容確認 → 本送信 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">③ 内容確認 → 本送信</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 space-y-2">
            <p className="font-medium">
              📋 先に「内容確認」でスキーマ検証を通す (推奨)
            </p>
            <ol className="list-decimal pl-5 space-y-1 text-xs">
              <li>
                <a
                  className="underline"
                  href="https://login.e-tax.nta.go.jp/login/reception/loginIndividual"
                  target="_blank"
                  rel="noreferrer"
                >
                  e-Tax マイページ
                </a>
                にログイン (マイナンバーカード + iPhone のマイナポータルアプリ)
              </li>
              <li>
                マイページ下部「その他機能」→「<b>作成した申告・申請データ(拡張子「.xtx」)の表示</b>」
              </li>
              <li>
                上で生成した XTX をアップロード →「次へ」→「全選択」→「帳票表示」
              </li>
              <li>
                PDF をダウンロードし、各帳票の数値・氏名が正しいか確認
              </li>
            </ol>
          </div>

          <div className="rounded-md border p-3 text-sm space-y-2">
            <p className="font-medium">🚀 本送信 (Mac ユーザーの現実解)</p>
            <p className="text-xs text-muted-foreground">
              e-Tax マイページの「内容確認」はスキーマ検証とPDF表示のみで、送信はできません。
              Mac から確定申告を実送信するには以下のどちらか。
            </p>
            <ul className="text-xs space-y-1 list-disc pl-5">
              <li>
                <b>確定申告書等作成コーナー</b>
                (keisan.nta.go.jp) でブラウザから新規入力 → そのまま送信。
                kaikei の確認用PDFと同じ数値を手動転記。Mac/マイナンバーカードで完結
              </li>
              <li>
                <b>e-Taxソフト(ダウンロード版)</b> は <b>Windows専用</b>。
                Mac では Parallels/CrossOver 等で Windows を起動する必要あり
              </li>
              <li>
                kaikei の XTX を直接読み込んで送信できる Mac ネイティブ手段は
                <b>現時点で無し</b>（国税庁側の制約）
              </li>
            </ul>
          </div>

          <div className="flex gap-2 flex-wrap">
            <Button onClick={openEtaxWeb}>
              <ExternalLink className="h-4 w-4 mr-1" />
              e-Tax マイページを開く (内容確認)
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                const url =
                  "https://www.keisan.nta.go.jp/kyoutu/ky/sm/top#bsctrl";
                try {
                  const { open } = await import("@tauri-apps/plugin-shell");
                  await open(url);
                } catch {
                  window.open(url, "_blank");
                }
              }}
            >
              <ExternalLink className="h-4 w-4 mr-1" />
              作成コーナーを開く (本送信)
            </Button>
            {taxReturn && taxReturn.status !== "submitted" && (
              <Button variant="outline" onClick={markSubmitted}>
                <ArrowRight className="h-4 w-4 mr-1" />
                送信完了を記録
              </Button>
            )}
          </div>

          {taxReturn?.status === "submitted" && (
            <div className="rounded-md border px-4 py-3 bg-green-50 border-green-200 text-green-800 flex items-start gap-2">
              <CheckCircle2 className="h-4 w-4 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">提出済み</p>
                <p className="text-xs mt-0.5">
                  送信ID: {taxReturn.etax_submission_id}
                  {taxReturn.etax_submitted_at &&
                    ` / ${new Date(taxReturn.etax_submitted_at).toLocaleString(
                      "ja-JP"
                    )}`}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Separator />

      <div className="rounded-md bg-muted/50 border p-4 text-xs space-y-1 text-muted-foreground">
        <p className="font-medium text-foreground">
          ⚠️ 令和7年分について
        </p>
        <p>
          KOA020 (確定申告書) は令和7年分スキーマ (v23.0) に対応済みです。
          KOA210 (青色申告決算書) と RSH0010/0030 (消費税) は令和5〜6年分安定版を流用しています。
          令和7年分専用スキーマが公開され次第、差分を取り込みます。
        </p>
        <p>
          生成した XTX は e-Tax Web版で読み込める形式です。ただし未署名なので、
          署名と送信は e-Tax Web版 + マイナポータルアプリで行います。
        </p>
      </div>
    </div>
  );
}
