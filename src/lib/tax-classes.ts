import type { TaxClass } from "@/types";

// 税区分マスタ（migration 003 と同期）
export const TAX_CLASSES: TaxClass[] = [
  { code: "OUT",  name: "対象外",         rate: 0,  kind: "out_of_scope",     reduced: false, sort_order: 10 },
  { code: "NT",   name: "不課税",         rate: 0,  kind: "non_taxable",      reduced: false, sort_order: 20 },
  { code: "EXM",  name: "非課税",         rate: 0,  kind: "exempt",           reduced: false, sort_order: 30 },
  { code: "EXP",  name: "輸出免税",       rate: 0,  kind: "export",           reduced: false, sort_order: 40 },
  { code: "S10",  name: "課税売上10%",    rate: 10, kind: "taxable_sales",    reduced: false, sort_order: 50 },
  { code: "S08R", name: "課税売上8%(軽)", rate: 8,  kind: "taxable_sales",    reduced: true,  sort_order: 60 },
  { code: "S08",  name: "課税売上8%",     rate: 8,  kind: "taxable_sales",    reduced: false, sort_order: 70 },
  { code: "P10",  name: "課対仕入10%",    rate: 10, kind: "taxable_purchase", reduced: false, sort_order: 80 },
  { code: "P08R", name: "課対仕入8%(軽)", rate: 8,  kind: "taxable_purchase", reduced: true,  sort_order: 90 },
  { code: "P08",  name: "課対仕入8%",     rate: 8,  kind: "taxable_purchase", reduced: false, sort_order: 100 },
];

export function getTaxClass(code: string | null | undefined): TaxClass | undefined {
  if (!code) return undefined;
  return TAX_CLASSES.find((t) => t.code === code);
}

export function getSalesTaxClasses(): TaxClass[] {
  return TAX_CLASSES.filter((t) => t.kind === "taxable_sales" || t.kind === "export");
}

export function getPurchaseTaxClasses(): TaxClass[] {
  return TAX_CLASSES.filter((t) => t.kind === "taxable_purchase");
}

export function getNonTaxableClasses(): TaxClass[] {
  return TAX_CLASSES.filter((t) => ["out_of_scope", "non_taxable", "exempt"].includes(t.kind));
}

/**
 * 税抜金額から税額を算出（内税方式は別途）
 */
export function calculateTax(amount: number, taxCode: string | null | undefined): number {
  const tc = getTaxClass(taxCode);
  if (!tc || tc.rate === 0) return 0;
  return Math.floor((amount * tc.rate) / 100);
}

/**
 * 税込金額から税額を逆算
 */
export function extractTaxFromIncluded(amountIncluded: number, taxCode: string | null | undefined): number {
  const tc = getTaxClass(taxCode);
  if (!tc || tc.rate === 0) return 0;
  return Math.floor((amountIncluded * tc.rate) / (100 + tc.rate));
}

/**
 * 勘定科目からデフォルトの税区分を推測する
 */
export function suggestTaxCodeForAccount(accountCategory: string, accountCode: string): string {
  // 収益系
  if (accountCategory === "revenue") {
    if (accountCode === "400") return "S10"; // 売上高は標準10%
    return "OUT";
  }
  // 費用系
  if (accountCategory === "expense") {
    // 租税公課・保険料・支払手数料は不課税/非課税が多い → 対象外をデフォルト
    if (["650", "610"].includes(accountCode)) return "OUT";
    return "P10"; // 大半は課対仕入10%
  }
  // 資産・負債は対象外
  return "OUT";
}
