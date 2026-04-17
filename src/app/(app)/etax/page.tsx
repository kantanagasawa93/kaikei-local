"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatSqliteDate } from "@/lib/date-utils";
import {
  Send,
  Shield,
  CheckCircle,
  AlertTriangle,
  FileCheck,
  Download,
  ExternalLink,
} from "lucide-react";
import type { TaxReturn } from "@/types";

export default function EtaxPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear - 1);
  const [taxReturn, setTaxReturn] = useState<TaxReturn | null>(null);
  const [myNumber, setMyNumber] = useState("");
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    loadTaxReturn();
  }, [year]);

  async function loadTaxReturn() {
    const { data } = await supabase
      .from("tax_returns")
      .select("*")
      .eq("year", year)
      .single();
    setTaxReturn(data);
    setSubmitted(data?.status === "submitted");
  }

  function validateMyNumber(number: string): boolean {
    if (!/^\d{12}$/.test(number)) return false;
    // チェックディジット検証（総務省仕様）
    const digits = number.split("").map(Number);
    const checkDigit = digits[11];
    const weights = [6, 5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const sum = digits.slice(0, 11).reduce((acc, d, i) => acc + d * weights[i], 0);
    const remainder = sum % 11;
    const expected = remainder <= 1 ? 0 : 11 - remainder;
    return checkDigit === expected;
  }

  async function handleSubmit() {
    if (!taxReturn || !validateMyNumber(myNumber)) return;
    setSubmitting(true);

    // マスクして保存（元の番号はDBに保存しない）
    const maskedNumber = "****" + myNumber.slice(-4);

    // e-Tax送信をシミュレート
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const submissionId = `ETAX-${year}-${Date.now().toString(36).toUpperCase()}`;

    await supabase
      .from("tax_returns")
      .update({
        status: "submitted",
        my_number_encrypted: maskedNumber,
        etax_submission_id: submissionId,
        etax_submitted_at: new Date().toISOString(),
      })
      .eq("id", taxReturn.id);

    setSubmitting(false);
    setSubmitted(true);
    setConfirmDialogOpen(false);
    loadTaxReturn();
  }

  function generateXTaxData(): string {
    if (!taxReturn) return "";
    // e-Tax用XMLデータの簡易生成
    return `<?xml version="1.0" encoding="UTF-8"?>
<申告書>
  <年分>${year}</年分>
  <申告種類>${taxReturn.return_type === "blue" ? "青色" : "白色"}</申告種類>
  <収入金額>
    <事業>${taxReturn.revenue_total}</事業>
  </収入金額>
  <所得金額>
    <事業>${taxReturn.income_total}</事業>
  </所得金額>
  <所得控除>
    <基礎控除>${taxReturn.basic_deduction}</基礎控除>
    <社会保険料控除>${taxReturn.social_insurance_deduction}</社会保険料控除>
    <青色申告特別控除>${taxReturn.blue_special_deduction}</青色申告特別控除>
  </所得控除>
  <税額>
    <課税所得>${taxReturn.taxable_income}</課税所得>
    <所得税>${taxReturn.income_tax}</所得税>
    <復興特別所得税>${taxReturn.reconstruction_tax}</復興特別所得税>
    <源泉徴収税額>${taxReturn.withholding_total}</源泉徴収税額>
    <納付税額>${taxReturn.tax_due}</納付税額>
  </税額>
</申告書>`;
  }

  function handleDownloadXml() {
    const xml = generateXTaxData();
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kakuteishinkoku_${year}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(amount);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">e-Tax提出</h1>
        <Select value={year.toString()} onValueChange={(v) => v && setYear(parseInt(v))}>
          <SelectTrigger className="w-32">
            <SelectValue>{year}年分</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: 5 }, (_, i) => currentYear - 1 - i).map((y) => (
              <SelectItem key={y} value={y.toString()}>{y}年分</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {!taxReturn || taxReturn.status === "draft" ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileCheck className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              まず確定申告ページで税額を計算してください
            </p>
          </CardContent>
        </Card>
      ) : submitted ? (
        <>
          <Card className="border-green-200 bg-green-50">
            <CardContent className="py-8 text-center space-y-3">
              <CheckCircle className="h-16 w-16 mx-auto text-green-600" />
              <h2 className="text-xl font-bold text-green-800">提出完了</h2>
              <p className="text-green-700">
                {year}年分の確定申告書がe-Taxに送信されました
              </p>
              {taxReturn.etax_submission_id && (
                <p className="text-sm text-green-600">
                  受付番号: {taxReturn.etax_submission_id}
                </p>
              )}
              {taxReturn.etax_submitted_at && (
                <p className="text-sm text-green-600">
                  送信日時: {formatSqliteDate(taxReturn.etax_submitted_at, { withTime: true })}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">提出済みデータ</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">申告種別: </span>
                  <Badge>{taxReturn.return_type === "blue" ? "青色申告" : "白色申告"}</Badge>
                </div>
                <div>
                  <span className="text-muted-foreground">売上: </span>
                  {formatCurrency(taxReturn.revenue_total)}
                </div>
                <div>
                  <span className="text-muted-foreground">経費: </span>
                  {formatCurrency(taxReturn.expense_total)}
                </div>
                <div>
                  <span className="text-muted-foreground">{taxReturn.tax_due >= 0 ? "納付税額" : "還付税額"}: </span>
                  <span className={taxReturn.tax_due < 0 ? "text-green-600 font-bold" : "text-red-600 font-bold"}>
                    {formatCurrency(Math.abs(taxReturn.tax_due))}
                  </span>
                </div>
              </div>
              <Separator />
              <Button variant="outline" size="sm" onClick={handleDownloadXml}>
                <Download className="h-4 w-4 mr-1" />
                XMLデータをダウンロード
              </Button>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          {/* 提出前の確認 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">提出内容の確認</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">申告種別</p>
                  <p className="font-medium">{taxReturn.return_type === "blue" ? "青色申告" : "白色申告"}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">売上（収入）</p>
                  <p className="font-medium text-green-600">{formatCurrency(taxReturn.revenue_total)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">経費</p>
                  <p className="font-medium">{formatCurrency(taxReturn.expense_total)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">課税所得</p>
                  <p className="font-medium">{formatCurrency(taxReturn.taxable_income)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">所得税 + 復興税</p>
                  <p className="font-medium">{formatCurrency(taxReturn.income_tax + taxReturn.reconstruction_tax)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{taxReturn.tax_due >= 0 ? "納付税額" : "還付税額"}</p>
                  <p className={`text-lg font-bold ${taxReturn.tax_due < 0 ? "text-green-600" : "text-red-600"}`}>
                    {formatCurrency(Math.abs(taxReturn.tax_due))}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="h-5 w-5" />
                マイナンバー入力
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5" />
                  <div className="text-sm text-amber-800">
                    <p className="font-medium">セキュリティについて</p>
                    <p>マイナンバーは送信時のみ使用し、端末に保存しません。通信は暗号化されます。</p>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label>マイナンバー（12桁）</Label>
                <Input
                  type="password"
                  value={myNumber}
                  onChange={(e) => setMyNumber(e.target.value.replace(/\D/g, "").slice(0, 12))}
                  placeholder="123456789012"
                  maxLength={12}
                />
                {myNumber && !validateMyNumber(myNumber) && (
                  <p className="text-xs text-destructive">12桁の数字を入力してください</p>
                )}
              </div>

              <div className="flex gap-2">
                <Button variant="outline" onClick={handleDownloadXml}>
                  <Download className="h-4 w-4 mr-1" />
                  XMLダウンロード
                </Button>

                <Dialog open={confirmDialogOpen} onOpenChange={setConfirmDialogOpen}>
                  <DialogTrigger
                    className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-9 px-4 py-2 cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
                    disabled={!validateMyNumber(myNumber)}
                  >
                    <Send className="h-4 w-4" />
                    e-Taxに送信
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>送信確認</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4">
                      <p className="text-sm">
                        {year}年分の確定申告書をe-Taxに送信します。送信後の取り消しはできません。
                      </p>
                      <div className="bg-muted p-3 rounded-lg text-sm space-y-1">
                        <p>申告種別: {taxReturn.return_type === "blue" ? "青色" : "白色"}</p>
                        <p>売上: {formatCurrency(taxReturn.revenue_total)}</p>
                        <p>{taxReturn.tax_due >= 0 ? "納付" : "還付"}: {formatCurrency(Math.abs(taxReturn.tax_due))}</p>
                      </div>
                      <div className="flex gap-2 justify-end">
                        <Button variant="outline" onClick={() => setConfirmDialogOpen(false)}>
                          キャンセル
                        </Button>
                        <Button onClick={handleSubmit} disabled={submitting}>
                          <Send className="h-4 w-4 mr-1" />
                          {submitting ? "送信中..." : "送信する"}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>

              <p className="text-xs text-muted-foreground">
                ※ 本アプリのe-Tax送信はデモ機能です。実際の申告には
                <a href="https://www.e-tax.nta.go.jp/" target="_blank" rel="noopener noreferrer" className="underline text-primary inline-flex items-center gap-0.5">
                  国税庁e-Tax <ExternalLink className="h-3 w-3" />
                </a>
                をご利用ください。XMLデータをダウンロードしてe-Taxにインポートできます。
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
