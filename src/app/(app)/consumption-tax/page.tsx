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
  calculateSimplifiedConsumptionTax,
  calculateStandardConsumptionTax,
} from "@/lib/tax-calculator";
import { Calculator, Info } from "lucide-react";
import type { TaxReturn, JournalLine } from "@/types";
import { TAX_CLASSES } from "@/lib/tax-classes";

type TaxBreakdown = Record<string, { sales: number; salesTax: number; purchase: number; purchaseTax: number }>;

type TaxType = "exempt" | "simplified" | "standard" | "invoice";

export default function ConsumptionTaxPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear - 1);
  const [taxReturn, setTaxReturn] = useState<TaxReturn | null>(null);
  const [taxType, setTaxType] = useState<TaxType>("exempt");
  const [businessType, setBusinessType] = useState("service");
  const [taxableRevenue, setTaxableRevenue] = useState(0);
  const [taxablePurchases, setTaxablePurchases] = useState(0);
  const [consumptionTax, setConsumptionTax] = useState(0);
  const [saving, setSaving] = useState(false);
  const [taxBreakdown, setTaxBreakdown] = useState<TaxBreakdown>({});

  useEffect(() => {
    loadData();
  }, [year]);

  async function loadData() {
    // 確定申告データ取得
    const { data: tr } = await supabase
      .from("tax_returns")
      .select("*")
      .eq("year", year)
      .single();

    if (tr) {
      setTaxReturn(tr);
      setTaxType(tr.consumption_tax_type as TaxType);
      setTaxableRevenue(tr.revenue_total);
      setTaxablePurchases(tr.expense_total);
    } else {
      // 仕訳から直接集計
      await loadFromJournals();
    }
  }

  async function loadFromJournals() {
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const { data: journals } = await supabase
      .from("journals")
      .select("id")
      .gte("date", startDate)
      .lte("date", endDate);

    const journalIds: string[] = journals?.map((j: { id: string }) => j.id) || [];
    if (journalIds.length === 0) {
      setTaxableRevenue(0);
      setTaxablePurchases(0);
      setTaxBreakdown({});
      return;
    }

    const { data: lines } = await supabase
      .from("journal_lines")
      .select("*")
      .in("journal_id", journalIds);

    if (!lines) return;

    // 税区分ベースで集計
    type Bucket = { sales: number; salesTax: number; purchase: number; purchaseTax: number };
    const breakdown: Record<string, Bucket> = {};
    let taxableSalesTotal = 0;
    let taxablePurchaseTotal = 0;

    for (const line of lines as JournalLine[]) {
      const code = line.tax_code || "OUT";
      const tc = TAX_CLASSES.find((t) => t.code === code);
      if (!tc) continue;

      if (!breakdown[code]) {
        breakdown[code] = { sales: 0, salesTax: 0, purchase: 0, purchaseTax: 0 };
      }

      // 売上側（貸方に計上されるもの）
      if (tc.kind === "taxable_sales" || tc.kind === "export") {
        const net = line.credit_amount - line.debit_amount;
        breakdown[code].sales += net;
        breakdown[code].salesTax += line.tax_amount || 0;
        taxableSalesTotal += net;
      }
      // 仕入・経費側（借方に計上されるもの）
      if (tc.kind === "taxable_purchase") {
        const net = line.debit_amount - line.credit_amount;
        breakdown[code].purchase += net;
        breakdown[code].purchaseTax += line.tax_amount || 0;
        taxablePurchaseTotal += net;
      }
    }

    setTaxBreakdown(breakdown);
    setTaxableRevenue(taxableSalesTotal);
    setTaxablePurchases(taxablePurchaseTotal);
  }

  function calculate() {
    if (taxType === "exempt") {
      setConsumptionTax(0);
      return;
    }

    if (taxType === "simplified") {
      setConsumptionTax(calculateSimplifiedConsumptionTax(taxableRevenue, businessType));
    } else {
      setConsumptionTax(calculateStandardConsumptionTax(taxableRevenue, taxablePurchases));
    }
  }

  async function handleSave() {
    if (!taxReturn) return;
    setSaving(true);

    await supabase
      .from("tax_returns")
      .update({
        consumption_tax_type: taxType,
        consumption_tax_amount: consumptionTax,
      })
      .eq("id", taxReturn.id);

    setSaving(false);
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(amount);

  const taxTypeLabels: Record<TaxType, { name: string; description: string }> = {
    exempt: { name: "免税事業者", description: "課税売上高が1,000万円以下の場合、消費税の納税義務なし" },
    simplified: { name: "簡易課税", description: "課税売上高5,000万円以下で選択可能。みなし仕入率で計算" },
    standard: { name: "本則課税", description: "実際の課税仕入額をもとに計算" },
    invoice: { name: "インボイス登録事業者", description: "適格請求書発行事業者。2割特例の適用可能" },
  };

  const businessTypes = [
    { value: "wholesale", label: "第一種（卸売業）- みなし仕入率90%" },
    { value: "retail", label: "第二種（小売業）- みなし仕入率80%" },
    { value: "manufacturing", label: "第三種（製造業等）- みなし仕入率70%" },
    { value: "other", label: "第四種（その他）- みなし仕入率60%" },
    { value: "service", label: "第五種（サービス業等）- みなし仕入率50%" },
    { value: "real_estate", label: "第六種（不動産業）- みなし仕入率40%" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">消費税</h1>
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

      {/* 課税方式の選択 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">課税方式</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Select value={taxType} onValueChange={(v) => v && setTaxType(v as TaxType)}>
            <SelectTrigger>
              <SelectValue placeholder="課税方式を選択">
                {taxTypeLabels[taxType].name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(taxTypeLabels).map(([key, { name }]) => (
                <SelectItem key={key} value={key}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="bg-muted p-3 rounded-lg">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5" />
              <p className="text-sm text-muted-foreground">
                {taxTypeLabels[taxType].description}
              </p>
            </div>
          </div>

          {taxType === "exempt" && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
              <p className="text-green-800 font-medium">消費税の納税義務はありません</p>
              <p className="text-sm text-green-600 mt-1">
                課税売上高が1,000万円以下のため免税事業者に該当します
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 税区分別の集計 */}
      {Object.keys(taxBreakdown).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">税区分別の集計（仕訳から自動算出）</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3">税区分</th>
                  <th className="text-right p-3">売上（税込）</th>
                  <th className="text-right p-3">うち消費税</th>
                  <th className="text-right p-3">仕入/経費（税込）</th>
                  <th className="text-right p-3">うち消費税</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(taxBreakdown)
                  .sort((a, b) => {
                    const ta = TAX_CLASSES.find((t) => t.code === a[0])?.sort_order ?? 999;
                    const tb = TAX_CLASSES.find((t) => t.code === b[0])?.sort_order ?? 999;
                    return ta - tb;
                  })
                  .map(([code, b]) => {
                    const tc = TAX_CLASSES.find((t) => t.code === code);
                    return (
                      <tr key={code} className="border-t">
                        <td className="p-3">
                          <Badge variant="outline" className="text-xs">
                            {tc?.name || code}
                          </Badge>
                        </td>
                        <td className="text-right p-3">
                          {b.sales > 0 ? b.sales.toLocaleString() : "-"}
                        </td>
                        <td className="text-right p-3 text-muted-foreground">
                          {b.salesTax > 0 ? b.salesTax.toLocaleString() : "-"}
                        </td>
                        <td className="text-right p-3">
                          {b.purchase > 0 ? b.purchase.toLocaleString() : "-"}
                        </td>
                        <td className="text-right p-3 text-muted-foreground">
                          {b.purchaseTax > 0 ? b.purchaseTax.toLocaleString() : "-"}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {taxType !== "exempt" && (
        <>
          {/* 計算入力 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">消費税計算</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>課税売上高（税込）</Label>
                  <Input
                    type="number"
                    value={taxableRevenue || ""}
                    onChange={(e) => setTaxableRevenue(parseInt(e.target.value) || 0)}
                    placeholder="0"
                  />
                </div>

                {(taxType === "standard" || taxType === "invoice") && (
                  <div className="space-y-1">
                    <Label>課税仕入高（税込）</Label>
                    <Input
                      type="number"
                      value={taxablePurchases || ""}
                      onChange={(e) => setTaxablePurchases(parseInt(e.target.value) || 0)}
                      placeholder="0"
                    />
                  </div>
                )}

                {taxType === "simplified" && (
                  <div className="space-y-1">
                    <Label>事業区分</Label>
                    <Select value={businessType} onValueChange={(v) => v && setBusinessType(v)}>
                      <SelectTrigger>
                        <SelectValue>
                          {businessTypes.find((bt) => bt.value === businessType)?.label || businessType}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {businessTypes.map((bt) => (
                          <SelectItem key={bt.value} value={bt.value}>{bt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>

              {taxType === "invoice" && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <p className="text-sm text-blue-800">
                    <strong>2割特例</strong>: インボイス制度を機に免税事業者から課税事業者になった場合、
                    納付税額を売上税額の2割にできる特例措置があります（2026年9月30日まで）。
                  </p>
                </div>
              )}

              <Button onClick={calculate}>
                <Calculator className="h-4 w-4 mr-1" />
                計算する
              </Button>
            </CardContent>
          </Card>

          {/* 計算結果 */}
          {consumptionTax > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">計算結果</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span>課税売上高（税込）</span>
                    <span>{formatCurrency(taxableRevenue)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>課税売上高（税抜）</span>
                    <span>{formatCurrency(Math.floor(taxableRevenue / 1.1))}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>売上に対する消費税額</span>
                    <span>{formatCurrency(Math.floor(taxableRevenue / 1.1 * 0.1))}</span>
                  </div>
                  {(taxType === "standard" || taxType === "invoice") && (
                    <div className="flex justify-between">
                      <span>仕入税額控除</span>
                      <span className="text-green-600">-{formatCurrency(Math.floor(taxablePurchases / 1.1 * 0.1))}</span>
                    </div>
                  )}
                  {taxType === "simplified" && (
                    <div className="flex justify-between">
                      <span>みなし仕入税額控除</span>
                      <span className="text-muted-foreground">
                        {businessTypes.find((bt) => bt.value === businessType)?.label.split("-")[1]}
                      </span>
                    </div>
                  )}
                  <Separator />
                  <div className="flex justify-between text-lg font-bold">
                    <span>納付すべき消費税額</span>
                    <span className="text-red-600">{formatCurrency(consumptionTax)}</span>
                  </div>
                </div>

                {taxReturn && (
                  <Button onClick={handleSave} disabled={saving} variant="outline" className="w-full">
                    {saving ? "保存中..." : "確定申告データに反映"}
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
