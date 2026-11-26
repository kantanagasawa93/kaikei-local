"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  calculateIncomeTax,
  calculateReconstructionTax,
  calculateBasicDeduction,
  calculateTaxableIncome,
  calculateTaxDue,
  capBlueDeduction,
  getTaxBracketInfo,
} from "@/lib/tax-calculator";
import { classifyAccountCode, loadAccountCategoryMap } from "@/lib/accounts";
import { toast } from "@/lib/toast";
import { FileCheck, Calculator, ArrowRight, FileDown } from "lucide-react";
import type { TaxReturn, TaxReturnExpense, JournalLine, WithholdingSlip } from "@/types";
import { exportTaxReturnPdf, downloadBlob } from "@/lib/pdf-export";

export default function TaxReturnPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear - 1);
  const [taxReturn, setTaxReturn] = useState<TaxReturn | null>(null);
  const [expenses, setExpenses] = useState<TaxReturnExpense[]>([]);
  const [returnType, setReturnType] = useState<"blue" | "white">("blue");
  const [saving, setSaving] = useState(false);

  // 控除入力
  const [socialInsurance, setSocialInsurance] = useState(0);
  const [lifeInsurance, setLifeInsurance] = useState(0);
  const [earthquakeInsurance, setEarthquakeInsurance] = useState(0);
  const [spouseDeduction, setSpouseDeduction] = useState(0);
  const [dependentsDeduction, setDependentsDeduction] = useState(0);
  const [medicalDeduction, setMedicalDeduction] = useState(0);
  const [smallBusinessDeduction, setSmallBusinessDeduction] = useState(0);
  const [withholdingTotal, setWithholdingTotal] = useState(0);
  // 集計に入れられなかった明細 (科目が未分類) と、未対応の給与収入についての注意
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    loadTaxReturn();
  }, [year]);

  async function loadTaxReturn() {
    const { data } = await supabase
      .from("tax_returns")
      .select("*")
      .eq("year", year)
      .single();

    if (data) {
      setTaxReturn(data);
      setReturnType(data.return_type);
      setSocialInsurance(data.social_insurance_deduction);
      setLifeInsurance(data.life_insurance_deduction);
      setEarthquakeInsurance(data.earthquake_insurance_deduction);
      setSpouseDeduction(data.spouse_deduction);
      setDependentsDeduction(data.dependents_deduction);
      setMedicalDeduction(data.medical_deduction);
      setSmallBusinessDeduction(data.small_business_deduction);
      setWithholdingTotal(data.withholding_total);

      // 経費内訳を読み込み
      const { data: expData } = await supabase
        .from("tax_return_expenses")
        .select("*")
        .eq("tax_return_id", data.id);
      if (expData) setExpenses(expData);
    } else {
      setTaxReturn(null);
      setExpenses([]);
      // 別の年の控除額・源泉徴収額を引き継がない。引き継いだまま「計算」を押すと、
      // 前の年の数字がこの年の申告として保存されてしまう。
      setSocialInsurance(0);
      setLifeInsurance(0);
      setEarthquakeInsurance(0);
      setSpouseDeduction(0);
      setDependentsDeduction(0);
      setMedicalDeduction(0);
      setSmallBusinessDeduction(0);
      setWithholdingTotal(0);
    }
    setWarnings([]);
  }

  async function handleCalculate() {
    if (saving) return;
    setSaving(true);
    try {
      await calculateAndSave();
    } catch (e) {
      console.error("確定申告の計算に失敗:", e);
      toast.error(`計算に失敗しました: ${(e as Error)?.message ?? String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function calculateAndSave() {
    // 仕訳から売上と経費を集計
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    // 読み込みに失敗したまま進むと「売上 0・経費 0」で既存の計算結果を上書きして
    // しまうので、エラーは必ずここで止める。
    const { data: journals, error: journalsError } = await supabase
      .from("journals")
      .select("id")
      .gte("date", startDate)
      .lte("date", endDate);
    if (journalsError) throw journalsError;

    const journalIds: string[] = journals?.map((j: { id: string }) => j.id) || [];

    let revenueTotal = 0;
    let expenseTotal = 0;
    const expenseByAccount: Record<string, { code: string; name: string; amount: number }> = {};
    // 科目表に無いコード (取込時に解決できなかった 999 = 未分類 など) の明細。
    // 売上にも経費にも入れられないので、黙って捨てずに利用者へ知らせる。
    const unclassified = new Map<string, { count: number; debit: number; credit: number }>();

    const categories = await loadAccountCategoryMap();
    for (let i = 0; i < journalIds.length; i += 400) {
      const { data: lines, error: linesError } = await supabase
        .from("journal_lines")
        .select("*")
        .in("journal_id", journalIds.slice(i, i + 400));
      if (linesError) throw linesError;

      for (const line of (lines ?? []) as JournalLine[]) {
        // 区分は科目表から引く (コードの先頭桁では判定しない)
        const kind = classifyAccountCode(line.account_code, categories);
        if (kind === "revenue") {
          revenueTotal += line.credit_amount - line.debit_amount;
        } else if (kind === "cogs" || kind === "expense") {
          const amount = line.debit_amount - line.credit_amount;
          expenseTotal += amount;
          if (!expenseByAccount[line.account_code]) {
            expenseByAccount[line.account_code] = {
              code: line.account_code,
              name: line.account_name,
              amount: 0,
            };
          }
          expenseByAccount[line.account_code].amount += amount;
        } else if (kind === null) {
          const key = line.account_name || line.account_code || "(科目なし)";
          const cur = unclassified.get(key) ?? { count: 0, debit: 0, credit: 0 };
          cur.count++;
          cur.debit += line.debit_amount || 0;
          cur.credit += line.credit_amount || 0;
          unclassified.set(key, cur);
        }
      }
    }

    // 源泉徴収票から金額を取得
    const { data: slips, error: slipsError } = await supabase
      .from("withholding_slips")
      .select("*")
      .eq("year", year);
    if (slipsError) throw slipsError;

    const nextWarnings: string[] = [];
    let wTotal = withholdingTotal;
    // 社会保険料は「いま画面に入っている値」が基準。源泉徴収票に記載があればそちらを使う。
    // (setSocialInsurance は次のレンダーまで反映されないので、計算にはこのローカル変数を使う。
    //  以前は更新前の state を使っていたため、源泉徴収票の社会保険料が計算に入っていなかった)
    let socialInsuranceForCalc = socialInsurance;
    if (slips && slips.length > 0) {
      const slipsList = slips as WithholdingSlip[];
      wTotal = slipsList.reduce((sum, s) => sum + s.withholding_tax, 0);
      setWithholdingTotal(wTotal);
      const sInsurance = slipsList.reduce((sum, s) => sum + s.social_insurance, 0);
      if (sInsurance > 0) {
        socialInsuranceForCalc = sInsurance;
        setSocialInsurance(sInsurance);
      }
      const salary = slipsList.reduce((sum, s) => sum + (s.payment_amount || 0), 0);
      if (salary > 0) {
        nextWarnings.push(
          `源泉徴収票の支払金額（合計 ${salary.toLocaleString()}円）は、この計算の所得に含まれていません。` +
            "給与所得がある場合、実際の税額はここに表示される額より多くなります。" +
            "申告の際は、確定申告書等作成コーナー（e-Tax）で給与所得を合算してください。",
        );
      }
    }

    if (unclassified.size > 0) {
      const total = [...unclassified.values()].reduce((a, v) => a + v.count, 0);
      const names = [...unclassified.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 6)
        .map(([name, v]) => `${name}（${v.count}件・借方 ${v.debit.toLocaleString()}円 / 貸方 ${v.credit.toLocaleString()}円）`)
        .join("、");
      nextWarnings.push(
        `勘定科目が未分類の明細が ${total}件あり、売上にも経費にも集計されていません: ${names}` +
          `${unclassified.size > 6 ? " ほか" : ""}。` +
          "他のソフトから取り込んだ仕訳で科目名が一致しなかったものです。仕訳帳で正しい勘定科目を選び直してから、もう一度計算してください。",
      );
    }

    // 税額計算
    const businessProfit = revenueTotal - expenseTotal;
    // 青色申告特別控除は事業の所得が上限 (赤字・少額黒字の年に所得をマイナスにしない)
    const blueDeduction = returnType === "blue" ? capBlueDeduction(650000, businessProfit) : 0;
    // 基礎控除は「合計所得金額」= 青色申告特別控除 **後** の所得で判定する。
    // 控除前の金額で判定すると階層がずれ、税額が多く出ていた。
    const totalIncome = Math.max(0, businessProfit - blueDeduction);
    const basicDeduction = calculateBasicDeduction(totalIncome, year);

    const taxableIncome = calculateTaxableIncome(revenueTotal, expenseTotal, {
      basic: basicDeduction,
      social_insurance: socialInsuranceForCalc,
      life_insurance: lifeInsurance,
      earthquake_insurance: earthquakeInsurance,
      spouse: spouseDeduction,
      dependents: dependentsDeduction,
      medical: medicalDeduction,
      small_business: smallBusinessDeduction,
      blue_special: blueDeduction,
    });

    const incomeTax = calculateIncomeTax(taxableIncome);
    const reconstructionTax = calculateReconstructionTax(incomeTax);
    const taxDue = calculateTaxDue(incomeTax, reconstructionTax, wTotal);

    // DB保存
    const taxReturnData = {
      year,
      return_type: returnType,
      status: "calculated" as const,
      revenue_total: revenueTotal,
      expense_total: expenseTotal,
      income_total: businessProfit,
      basic_deduction: basicDeduction,
      social_insurance_deduction: socialInsuranceForCalc,
      life_insurance_deduction: lifeInsurance,
      earthquake_insurance_deduction: earthquakeInsurance,
      spouse_deduction: spouseDeduction,
      dependents_deduction: dependentsDeduction,
      medical_deduction: medicalDeduction,
      small_business_deduction: smallBusinessDeduction,
      blue_special_deduction: blueDeduction,
      taxable_income: taxableIncome,
      income_tax: incomeTax,
      reconstruction_tax: reconstructionTax,
      withholding_total: wTotal,
      tax_due: taxDue,
    };

    let taxReturnId: string;
    if (taxReturn) {
      const { error } = await supabase
        .from("tax_returns")
        .update(taxReturnData)
        .eq("id", taxReturn.id);
      if (error) throw error;
      taxReturnId = taxReturn.id;
    } else {
      const { data, error: insertErr } = await supabase
        .from("tax_returns")
        .insert(taxReturnData)
        .select()
        .single();
      if (insertErr || !data) throw insertErr ?? new Error("確定申告データを保存できませんでした");
      taxReturnId = data.id;
    }

    // 経費内訳を保存
    const { error: deleteError } = await supabase
      .from("tax_return_expenses")
      .delete()
      .eq("tax_return_id", taxReturnId);
    if (deleteError) throw deleteError;
    const expenseRecords = Object.values(expenseByAccount).map((e) => ({
      tax_return_id: taxReturnId,
      account_code: e.code,
      account_name: e.name,
      amount: e.amount,
    }));
    if (expenseRecords.length > 0) {
      const { error } = await supabase.from("tax_return_expenses").insert(expenseRecords);
      if (error) throw error;
    }

    await loadTaxReturn();
    setWarnings(nextWarnings); // loadTaxReturn が消すので、その後に出す
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(amount);

  const bracketInfo = taxReturn ? getTaxBracketInfo(taxReturn.taxable_income) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">確定申告</h1>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!taxReturn}
            onClick={async () => {
              if (!taxReturn) return;
              const bytes = await exportTaxReturnPdf(taxReturn, expenses);
              downloadBlob(bytes, `kaikei_tax_return_${taxReturn.year}.pdf`);
            }}
          >
            <FileDown className="h-4 w-4 mr-1" />
            PDF出力
          </Button>
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
      </div>

      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-2">
          <p className="font-semibold">この計算結果は、そのまま申告に使えません</p>
          <ul className="list-disc pl-5 space-y-1">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <Tabs defaultValue="input">
        <TabsList>
          <TabsTrigger value="input">控除入力</TabsTrigger>
          <TabsTrigger value="result">計算結果</TabsTrigger>
          <TabsTrigger value="expenses">経費内訳</TabsTrigger>
        </TabsList>

        <TabsContent value="input" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">申告の種類</CardTitle>
            </CardHeader>
            <CardContent>
              <Select value={returnType} onValueChange={(v) => v && setReturnType(v as "blue" | "white")}>
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="申告種類を選択">
                    {returnType === "blue" ? "青色申告（65万円控除）" : "白色申告"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="blue">青色申告（65万円控除）</SelectItem>
                  <SelectItem value="white">白色申告</SelectItem>
                </SelectContent>
              </Select>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">所得控除</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>社会保険料控除</Label>
                  <Input type="number" min={0} value={socialInsurance || ""} onChange={(e) => setSocialInsurance(Math.max(0, parseInt(e.target.value) || 0))} placeholder="国民年金、国民健康保険等" />
                </div>
                <div className="space-y-1">
                  <Label>生命保険料控除</Label>
                  <Input type="number" min={0} value={lifeInsurance || ""} onChange={(e) => setLifeInsurance(Math.max(0, parseInt(e.target.value) || 0))} />
                </div>
                <div className="space-y-1">
                  <Label>地震保険料控除</Label>
                  <Input type="number" min={0} value={earthquakeInsurance || ""} onChange={(e) => setEarthquakeInsurance(Math.max(0, parseInt(e.target.value) || 0))} />
                </div>
                <div className="space-y-1">
                  <Label>配偶者控除</Label>
                  <Input type="number" min={0} value={spouseDeduction || ""} onChange={(e) => setSpouseDeduction(Math.max(0, parseInt(e.target.value) || 0))} />
                </div>
                <div className="space-y-1">
                  <Label>扶養控除</Label>
                  <Input type="number" min={0} value={dependentsDeduction || ""} onChange={(e) => setDependentsDeduction(Math.max(0, parseInt(e.target.value) || 0))} />
                </div>
                <div className="space-y-1">
                  <Label>医療費控除</Label>
                  <Input type="number" min={0} value={medicalDeduction || ""} onChange={(e) => setMedicalDeduction(Math.max(0, parseInt(e.target.value) || 0))} />
                </div>
                <div className="space-y-1">
                  <Label>小規模企業共済等掛金控除</Label>
                  <Input type="number" min={0} value={smallBusinessDeduction || ""} onChange={(e) => setSmallBusinessDeduction(Math.max(0, parseInt(e.target.value) || 0))} placeholder="iDeCo等" />
                </div>
                <div className="space-y-1">
                  <Label>源泉徴収税額（合計）</Label>
                  <Input type="number" min={0} value={withholdingTotal || ""} onChange={(e) => setWithholdingTotal(Math.max(0, parseInt(e.target.value) || 0))} />
                </div>
              </div>

              <Button onClick={handleCalculate} disabled={saving} className="w-full">
                <Calculator className="h-4 w-4 mr-1" />
                {saving ? "計算中..." : "税額を計算する"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="result" className="space-y-4">
          {!taxReturn || taxReturn.status === "draft" ? (
            <Card>
              <CardContent className="py-12 text-center">
                <FileCheck className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-muted-foreground">
                  まだ計算されていません。控除入力タブで情報を入力して計算してください。
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{year}年分 確定申告</CardTitle>
                    <Badge>{taxReturn.return_type === "blue" ? "青色申告" : "白色申告"}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* 収支 */}
                  <div>
                    <h3 className="font-semibold text-sm text-muted-foreground mb-2">収支</h3>
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <span>売上（収入）</span>
                        <span className="font-medium text-green-600">{formatCurrency(taxReturn.revenue_total)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>経費</span>
                        <span className="font-medium text-red-600">-{formatCurrency(taxReturn.expense_total)}</span>
                      </div>
                      <Separator />
                      <div className="flex justify-between">
                        <span>差引金額（青色申告特別控除前）</span>
                        <span>{formatCurrency(taxReturn.income_total)}</span>
                      </div>
                      {taxReturn.blue_special_deduction > 0 && (
                        <div className="flex justify-between">
                          <span>青色申告特別控除</span>
                          <span className="text-red-600">
                            -{formatCurrency(taxReturn.blue_special_deduction)}
                          </span>
                        </div>
                      )}
                      <div className="flex justify-between font-bold">
                        <span>事業所得</span>
                        <span>
                          {formatCurrency(
                            taxReturn.income_total - taxReturn.blue_special_deduction,
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* 控除 */}
                  <div>
                    <h3 className="font-semibold text-sm text-muted-foreground mb-2">所得控除</h3>
                    <div className="space-y-1 text-sm">
                      <div className="flex justify-between"><span>基礎控除</span><span>{formatCurrency(taxReturn.basic_deduction)}</span></div>
                      {taxReturn.social_insurance_deduction > 0 && <div className="flex justify-between"><span>社会保険料控除</span><span>{formatCurrency(taxReturn.social_insurance_deduction)}</span></div>}
                      {taxReturn.life_insurance_deduction > 0 && <div className="flex justify-between"><span>生命保険料控除</span><span>{formatCurrency(taxReturn.life_insurance_deduction)}</span></div>}
                      {taxReturn.earthquake_insurance_deduction > 0 && <div className="flex justify-between"><span>地震保険料控除</span><span>{formatCurrency(taxReturn.earthquake_insurance_deduction)}</span></div>}
                      {taxReturn.spouse_deduction > 0 && <div className="flex justify-between"><span>配偶者控除</span><span>{formatCurrency(taxReturn.spouse_deduction)}</span></div>}
                      {taxReturn.dependents_deduction > 0 && <div className="flex justify-between"><span>扶養控除</span><span>{formatCurrency(taxReturn.dependents_deduction)}</span></div>}
                      {taxReturn.medical_deduction > 0 && <div className="flex justify-between"><span>医療費控除</span><span>{formatCurrency(taxReturn.medical_deduction)}</span></div>}
                      {taxReturn.small_business_deduction > 0 && <div className="flex justify-between"><span>小規模企業共済等掛金控除</span><span>{formatCurrency(taxReturn.small_business_deduction)}</span></div>}
                    </div>
                  </div>

                  <Separator />

                  {/* 税額 */}
                  <div>
                    <h3 className="font-semibold text-sm text-muted-foreground mb-2">税額計算</h3>
                    <div className="space-y-2">
                      <div className="flex justify-between">
                        <span>課税所得金額</span>
                        <span className="font-medium">{formatCurrency(taxReturn.taxable_income)}</span>
                      </div>
                      {bracketInfo && (
                        <p className="text-xs text-muted-foreground">
                          適用税率: {bracketInfo.rate}%（{bracketInfo.bracket}）
                        </p>
                      )}
                      <div className="flex justify-between">
                        <span>所得税額</span>
                        <span>{formatCurrency(taxReturn.income_tax)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>復興特別所得税</span>
                        <span>{formatCurrency(taxReturn.reconstruction_tax)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>源泉徴収税額</span>
                        <span className="text-green-600">-{formatCurrency(taxReturn.withholding_total)}</span>
                      </div>
                      <Separator />
                      <div className="flex justify-between text-lg font-bold">
                        <span>{taxReturn.tax_due >= 0 ? "納付税額" : "還付税額"}</span>
                        <span className={taxReturn.tax_due < 0 ? "text-green-600" : "text-red-600"}>
                          {formatCurrency(Math.abs(taxReturn.tax_due))}
                        </span>
                      </div>
                      {taxReturn.tax_due < 0 && (
                        <p className="text-sm text-green-600">
                          {formatCurrency(Math.abs(taxReturn.tax_due))} が還付されます
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="expenses">
          {expenses.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-muted-foreground">
                  経費内訳がありません。まず税額を計算してください。
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">経費内訳（{year}年）</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>科目コード</TableHead>
                      <TableHead>勘定科目</TableHead>
                      <TableHead className="text-right">金額</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {expenses
                      .sort((a, b) => a.account_code.localeCompare(b.account_code))
                      .map((e) => (
                        <TableRow key={e.id}>
                          <TableCell className="text-muted-foreground">{e.account_code}</TableCell>
                          <TableCell>{e.account_name}</TableCell>
                          <TableCell className="text-right font-medium">
                            {formatCurrency(e.amount)}
                          </TableCell>
                        </TableRow>
                      ))}
                    <TableRow className="font-bold">
                      <TableCell colSpan={2}>合計</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(expenses.reduce((s, e) => s + e.amount, 0))}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
