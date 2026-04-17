// 所得税の税率テーブル（2024年現在）
const INCOME_TAX_BRACKETS = [
  { limit: 1950000, rate: 0.05, deduction: 0 },
  { limit: 3300000, rate: 0.10, deduction: 97500 },
  { limit: 6950000, rate: 0.20, deduction: 427500 },
  { limit: 9000000, rate: 0.23, deduction: 636000 },
  { limit: 18000000, rate: 0.33, deduction: 1536000 },
  { limit: 40000000, rate: 0.40, deduction: 2796000 },
  { limit: Infinity, rate: 0.45, deduction: 4796000 },
];

// 所得税を計算
export function calculateIncomeTax(taxableIncome: number): number {
  if (taxableIncome <= 0) return 0;
  for (const bracket of INCOME_TAX_BRACKETS) {
    if (taxableIncome <= bracket.limit) {
      return Math.floor(taxableIncome * bracket.rate - bracket.deduction);
    }
  }
  return 0;
}

// 復興特別所得税（2.1%）
export function calculateReconstructionTax(incomeTax: number): number {
  return Math.floor(incomeTax * 0.021);
}

// 基礎控除の計算
export function calculateBasicDeduction(income: number): number {
  if (income <= 24000000) return 480000;
  if (income <= 24500000) return 320000;
  if (income <= 25000000) return 160000;
  return 0;
}

// 青色申告特別控除
export function getBlueReturnDeduction(isBlue: boolean, isEtax: boolean): number {
  if (!isBlue) return 0;
  return isEtax ? 650000 : 550000;
}

// 課税所得の計算
export function calculateTaxableIncome(
  revenue: number,
  expenses: number,
  deductions: {
    basic: number;
    social_insurance: number;
    life_insurance: number;
    earthquake_insurance: number;
    spouse: number;
    dependents: number;
    medical: number;
    small_business: number;
    blue_special: number;
  }
): number {
  // 防御的に負値をゼロへ正規化する（不正入力対策）
  const safeRevenue = Math.max(0, revenue || 0);
  const safeExpenses = Math.max(0, expenses || 0);
  const income = safeRevenue - safeExpenses;
  const totalDeductions = Object.values(deductions)
    .map((v) => Math.max(0, v || 0))
    .reduce((s, v) => s + v, 0);
  const taxableIncome = income - totalDeductions;
  // 1000円未満切り捨て
  return Math.max(0, Math.floor(taxableIncome / 1000) * 1000);
}

// 納付税額の計算
// 国税通則法第119条に基づき、差引納付税額を最後に 100円未満切り捨てする。
// 還付（負の場合）は切り捨てない。
export function calculateTaxDue(
  incomeTax: number,
  reconstructionTax: number,
  withholdingTotal: number
): number {
  const totalTax = incomeTax + reconstructionTax;
  const netTax = totalTax - withholdingTotal;
  if (netTax >= 0) {
    // 納付: 100円未満切り捨て
    return Math.floor(netTax / 100) * 100;
  }
  // 還付: 円単位のまま
  return netTax;
}

// 生命保険料控除の計算
export function calculateLifeInsuranceDeduction(premium: number): number {
  if (premium <= 20000) return premium;
  if (premium <= 40000) return Math.floor(premium / 2) + 10000;
  if (premium <= 80000) return Math.floor(premium / 4) + 20000;
  return 40000;
}

// 地震保険料控除の計算
export function calculateEarthquakeInsuranceDeduction(premium: number): number {
  return Math.min(premium, 50000);
}

// 医療費控除の計算
export function calculateMedicalDeduction(medicalExpenses: number, income: number): number {
  if (medicalExpenses <= 0 || income <= 0) return 0;
  const threshold = Math.min(Math.floor(income * 0.05), 100000);
  return Math.max(0, Math.min(medicalExpenses - threshold, 2000000));
}

// 消費税の計算（簡易課税）
const SIMPLIFIED_TAX_RATES: Record<string, number> = {
  wholesale: 0.10, // 第一種：卸売業（みなし仕入率90%）
  retail: 0.20, // 第二種：小売業（みなし仕入率80%）
  manufacturing: 0.30, // 第三種：製造業等（みなし仕入率70%）
  other: 0.40, // 第四種：その他（みなし仕入率60%）
  service: 0.50, // 第五種：サービス業等（みなし仕入率50%）
  real_estate: 0.60, // 第六種：不動産業（みなし仕入率40%）
};

export function calculateSimplifiedConsumptionTax(
  taxableRevenue: number,
  businessType: string = "service"
): number {
  const rate = SIMPLIFIED_TAX_RATES[businessType] || 0.50;
  // 税抜売上に対する消費税額 × (1 - みなし仕入率)
  const taxAmount = Math.floor(taxableRevenue / 1.1 * 0.1);
  return Math.floor(taxAmount * rate);
}

export function calculateStandardConsumptionTax(
  taxableRevenue: number,
  taxablePurchases: number
): number {
  const outputTax = Math.floor(taxableRevenue / 1.1 * 0.1);
  const inputTax = Math.floor(taxablePurchases / 1.1 * 0.1);
  return Math.max(0, outputTax - inputTax);
}

// 所得税率の説明を取得
export function getTaxBracketInfo(taxableIncome: number): {
  rate: number;
  bracket: string;
} {
  for (const bracket of INCOME_TAX_BRACKETS) {
    if (taxableIncome <= bracket.limit) {
      return {
        rate: bracket.rate * 100,
        bracket: bracket.limit === Infinity
          ? "4,000万円超"
          : `${(bracket.limit / 10000).toLocaleString()}万円以下`,
      };
    }
  }
  return { rate: 45, bracket: "4,000万円超" };
}
