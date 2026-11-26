import type { TaxClass } from "@/types";
import { DEFAULT_CATEGORY_MAP } from "@/lib/accounts";

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
 * 税込 (内税) 明細の消費税額合計。税区分ごとに税込額を合算してから 1 回だけ端数処理する。
 *
 * 適格請求書は「1 請求書につき税率ごとに 1 回の端数処理」が要件で、行ごとに
 * 切り捨てた税額を合算するのは不可 (例: 税込 1,000 円 × 3 行 → 行ごとだと
 * 90 × 3 = 270 円、正しくは floor(3,000 × 10/110) = 272 円)。
 */
export function extractTaxFromIncludedLines(
  lines: { amount: number; tax_code: string | null | undefined }[],
): number {
  const byCode = new Map<string, number>();
  for (const l of lines) {
    const code = l.tax_code ?? "";
    byCode.set(code, (byCode.get(code) ?? 0) + l.amount);
  }
  let tax = 0;
  for (const [code, sum] of byCode) tax += extractTaxFromIncluded(sum, code);
  return tax;
}

/**
 * 報酬・料金の源泉徴収税額 (復興特別所得税込み)。
 * 100万円以下: 10.21% / 100万円超の部分: 20.42% (所得税法204条・205条)。
 * base は税抜の報酬額 (請求書で消費税を区分している場合は税抜額が基準)。
 */
export function calcWithholdingTax(base: number): number {
  if (base <= 0) return 0;
  if (base <= 1_000_000) return Math.floor(base * 0.1021);
  return Math.floor(102_100 + (base - 1_000_000) * 0.2042);
}

/**
 * 既定の科目表のうち、消費税が課税仕入にならない費用科目。
 *
 * 以前はここが `["650", "610"]` (科目表の改訂前のコード) のままだった。
 * 650 は存在せず、610 は現在の「消耗品費」なので、
 *   - 消耗品費を選ぶと「対象外・税額 0」になり (課税仕入が漏れる)
 *   - 租税公課・損害保険料・減価償却費・給料賃金・利子割引料を選ぶと
 *     「課対仕入 10%」になって存在しない仕入税額が立つ
 * という逆転が起きていた。コードは必ず src/lib/accounts.ts の科目表と揃えること
 * (tax-classes.test.ts が科目表と突き合わせて検査する)。
 */
const NON_TAXABLE_ACCOUNT_TAX_CODE: Record<string, "OUT" | "EXM"> = {
  "500": "OUT", // 期首商品棚卸高 (仕入時に課税済み)
  "502": "OUT", // 期末商品棚卸高
  "601": "OUT", // 租税公課 (不課税)
  "608": "EXM", // 損害保険料 (非課税)
  "611": "OUT", // 減価償却費 (取得時に課税済み)
  "613": "OUT", // 給料賃金 (不課税)
  "615": "EXM", // 利子割引料 (非課税)
  "617": "OUT", // 貸倒金
};

/**
 * 勘定科目からデフォルトの税区分を推測する。
 * あくまで初期値。8% 軽減 (飲食料品・新聞) や住宅家賃 (非課税) などは利用者が直す。
 */
export function suggestTaxCodeForAccount(accountCategory: string, accountCode: string): string {
  // 収益系
  if (accountCategory === "revenue") {
    if (accountCode === "400") return "S10"; // 売上高は標準10%
    if (accountCode === "420") return "EXM"; // 受取利息は非課税
    return "OUT";
  }
  // 費用系
  if (accountCategory === "expense") {
    return NON_TAXABLE_ACCOUNT_TAX_CODE[accountCode] ?? "P10"; // 大半は課対仕入10%
  }
  // 資産・負債・資本は対象外
  return "OUT";
}

/**
 * 科目コードだけから既定の税区分を引く (既定の科目表を使用)。
 * 科目表に無いコードは「対象外」(勝手に仕入税額を立てない)。
 */
export function defaultTaxCodeForAccountCode(accountCode: string | null | undefined): string {
  if (!accountCode) return "OUT";
  const category = DEFAULT_CATEGORY_MAP.get(accountCode);
  if (!category) return "OUT";
  return suggestTaxCodeForAccount(category, accountCode);
}
