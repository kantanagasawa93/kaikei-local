import { describe, it, expect } from "vitest";
import {
  aggregateBalanceSheet,
  aggregateBlueReturnData,
  fixedAssetsToDepreciationItems,
  resolveExpenseKey,
  taxReturnToIncomeReturnData,
} from "@/lib/etax/mapping";
import { DEFAULT_ACCOUNTS } from "@/lib/accounts";
import type { FixedAsset, FixedAssetDepreciation, TaxReturn } from "@/types";

const car: FixedAsset = {
  id: "fa-1",
  user_id: "local-user",
  name: "普通自動車",
  asset_account_code: "162",
  acquisition_date: "2026-06-15",
  acquisition_cost: 6000000,
  useful_life_years: 6,
  depreciation_method: "straight_line",
  business_ratio: 80,
  residual_value: 0,
  status: "active",
  disposed_at: null,
  notes: null,
  created_at: "",
};

const depr2026: FixedAssetDepreciation = {
  id: "d-1",
  fixed_asset_id: "fa-1",
  fiscal_year: 2026,
  depreciation_amount: 584500,
  book_value_after: 5415500,
  posted_journal_id: "j-1",
  created_at: "",
};

describe("fixedAssetsToDepreciationItems", () => {
  it("償却率は国税庁の率表、月数は月割り、事業割合は 0-100 のまま", () => {
    const items = fixedAssetsToDepreciationItems([car], [depr2026], 2026);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.rate).toBe(0.167); // 1/6 ではなく率表の 0.167
    expect(it0.months).toBe(7); // 6月取得 → 7ヶ月
    expect(it0.business_use_ratio).toBe(80); // 旧実装は 8000 になっていた
    expect(it0.depreciation_year).toBe(584500);
    expect(it0.expense_amount).toBe(467600); // 584,500 × 80%
    expect(it0.book_value_kimatsu).toBe(5415500);
  });

  it("翌年以降は 12ヶ月", () => {
    const items = fixedAssetsToDepreciationItems(
      [car],
      [{ ...depr2026, fiscal_year: 2027, depreciation_amount: 1002000 }],
      2027
    );
    expect(items[0].months).toBe(12);
  });

  it("当年の償却実績が無い資産・active 以外は載せない", () => {
    expect(fixedAssetsToDepreciationItems([car], [], 2026)).toHaveLength(0);
    expect(
      fixedAssetsToDepreciationItems(
        [{ ...car, status: "sold" }],
        [depr2026],
        2026
      )
    ).toHaveLength(0);
  });
});

describe("青色申告決算書の経費科目 — アプリの科目表と対応していること", () => {
  const code = (name: string) => {
    const a = DEFAULT_ACCOUNTS.find((x) => x.name === name);
    if (!a) throw new Error(`科目表に ${name} が無い`);
    return a.code;
  };

  it("決算書に専用の欄がある 17 科目は、その欄に入る", () => {
    const expected: Record<string, string> = {
      租税公課: "sozeikoka",
      荷造運賃: "nitsukuriunchin",
      水道光熱費: "suidokonetsu",
      旅費交通費: "ryohikotsu",
      通信費: "tsushin",
      広告宣伝費: "kokoku",
      接待交際費: "settai",
      損害保険料: "songai_hoken",
      修繕費: "shuzen",
      消耗品費: "shomohin",
      減価償却費: "genka_shokyaku",
      福利厚生費: "fukuri_kosei",
      給料賃金: "kyuryo_chinkin",
      外注工賃: "gaichu_kochin",
      利子割引料: "rishi_waribiki",
      地代家賃: "chidai_yachin",
      貸倒金: "kashidaore",
    };
    for (const [name, key] of Object.entries(expected)) {
      expect(resolveExpenseKey(code(name)), name).toBe(key);
    }
  });

  it("専用の欄が無い経費は雑費 (旧実装は 会議費→旅費交通費、支払手数料→通信費 などに化けていた)", () => {
    for (const name of ["新聞図書費", "会議費", "支払手数料", "車両費", "研修費", "雑費"]) {
      expect(resolveExpenseKey(code(name)), name).toBe("zappi");
    }
  });

  const tr = {
    year: 2026,
    return_type: "blue",
    revenue_total: 6000000,
    expense_total: 2200000,
    income_total: 3800000,
    blue_special_deduction: 650000,
    basic_deduction: 1040000,
    social_insurance_deduction: 0,
    life_insurance_deduction: 0,
    earthquake_insurance_deduction: 0,
    spouse_deduction: 0,
    dependents_deduction: 0,
    medical_deduction: 0,
    small_business_deduction: 0,
    taxable_income: 2110000,
    income_tax: 113500,
    reconstruction_tax: 2383,
    withholding_total: 0,
    tax_due: 115800,
  } as unknown as TaxReturn;

  it("仕訳から科目別に集計する (未分類コードは売上にも経費にも入れない)", () => {
    const blue = aggregateBlueReturnData(tr, [
      {
        id: "j1",
        date: "2026-01-31",
        lines: [
          { account_code: "400", debit_amount: 0, credit_amount: 500000 },
          { account_code: "110", debit_amount: 500000, credit_amount: 0 },
        ],
      },
      {
        id: "j2",
        date: "2026-12-31",
        lines: [
          { account_code: "611", debit_amount: 467600, credit_amount: 0 }, // 減価償却費
          { account_code: "621", debit_amount: 3000, credit_amount: 0 }, // 会議費
          { account_code: "501", debit_amount: 20000, credit_amount: 0 }, // 仕入高
          { account_code: "999", debit_amount: 9999, credit_amount: 0 }, // 未分類
        ],
      },
    ]);
    expect(blue.uriage).toBe(500000);
    expect(blue.shiire).toBe(20000);
    expect(blue.genka_shokyaku).toBe(467600);
    expect(blue.shomohin).toBeUndefined(); // 旧実装では減価償却費がここに入っていた
    expect(blue.ryohikotsu).toBeUndefined(); // 旧実装では会議費がここに入っていた
    expect(blue.zappi).toBe(3000);
    expect(blue.monthly?.[0].income).toBe(500000);
    expect(blue.monthly?.[11].cost).toBe(20000);
  });

  it("申告書の所得金額は青色申告特別控除後 (決算書の所得金額と一致する)", () => {
    const income = taxReturnToIncomeReturnData(tr);
    expect(income.eigyo_income).toBe(6000000);
    expect(income.eigyo_shotoku).toBe(3150000);
    expect(income.goukei_shotoku).toBe(3150000);
    // ⑫ − 所得控除合計 = 課税される所得金額 (1,000 円未満切捨て)
    expect(
      Math.floor(((income.goukei_shotoku ?? 0) - (income.kojo_goukei ?? 0)) / 1000) * 1000,
    ).toBe(income.kazei_shotoku);
  });
});

describe("貸借対照表 — 現在の科目コードで残高が入る", () => {
  it("現金・普通預金・売掛金・固定資産・買掛金・未払金・元入金", () => {
    const bs = aggregateBalanceSheet(2026, [
      {
        id: "open",
        date: "2025-12-31",
        lines: [
          { account_code: "100", debit_amount: 50000, credit_amount: 0 },
          { account_code: "110", debit_amount: 950000, credit_amount: 0 },
          { account_code: "300", debit_amount: 0, credit_amount: 1000000 },
        ],
      },
      {
        id: "y",
        date: "2026-06-30",
        lines: [
          { account_code: "120", debit_amount: 300000, credit_amount: 0 },
          { account_code: "162", debit_amount: 3000000, credit_amount: 0 },
          { account_code: "200", debit_amount: 0, credit_amount: 80000 },
          { account_code: "210", debit_amount: 0, credit_amount: 3000000 },
          { account_code: "110", debit_amount: 0, credit_amount: 220000 },
        ],
      },
    ]);
    expect(bs.genkin_kishu).toBe(50000);
    expect(bs.genkin_kimatsu).toBe(50000);
    expect(bs.sonota_yokin_kishu).toBe(950000);
    expect(bs.sonota_yokin_kimatsu).toBe(730000);
    expect(bs.urikake_kimatsu).toBe(300000);
    expect(bs.sharyo_kimatsu).toBe(3000000);
    expect(bs.kaikake_kimatsu).toBe(80000);
    expect(bs.miharaikin_kimatsu).toBe(3000000);
    expect(bs.motoire_kishu).toBe(1000000);
    expect(bs.motoire_kimatsu).toBe(1000000);
  });
});
