/**
 * 既存の TaxReturn (確定申告データ) と仕訳から、XTX 入力用の型
 * (IncomeReturnData / BlueReturnData / ConsumptionTax*Data) を組み立てる。
 *
 * マッピング方針:
 *   - 売上/経費の分類は勘定科目コードの先頭桁で判定
 *     (既存コード /reports や /tax-return と同じロジック)
 *     4* = 収益, 5* = 売上原価, 6* = 販売管理費, 7* = 営業外
 *   - 青色決算書の「科目別経費」は勘定科目コード別の代表マッピングで寄せる
 *   - 月別売上は journals.date から集計
 *   - 源泉徴収税額は withholding_slips から合算
 */

import type {
  IncomeReturnData,
  BlueReturnData,
  MonthlyAmount,
  ConsumptionTaxStandardData,
  ConsumptionTaxSimplifiedData,
  IncomeBreakdownItem,
  DepreciationItem,
  BalanceSheetData,
} from "./index";
import type {
  TaxReturn,
  WithholdingSlip,
  FixedAsset,
  FixedAssetDepreciation,
} from "@/types";

// ──────────────────────────────────────────────────────────
// 勘定科目コード → 青色決算書の経費科目 のマッピング
// ──────────────────────────────────────────────────────────

/**
 * 勘定科目コードの先頭2〜3桁を見て、青色決算書 (KOA210) の
 * どの経費科目カラムに加算するか決定する。
 *
 * e-Tax 固定の経費区分:
 *   租税公課 / 荷造運賃 / 水道光熱費 / 旅費交通費 / 通信費 /
 *   広告宣伝費 / 接待交際費 / 損害保険料 / 修繕費 / 消耗品費 /
 *   減価償却費 / 福利厚生費 / 給料賃金 / 外注工賃 / 利子割引料 /
 *   地代家賃 / 貸倒金 / 雑費
 */
const EXPENSE_CODE_MAP: Record<string, keyof BlueReturnData> = {
  // 消耗品費
  "611": "shomohin",
  // 通信費
  "622": "tsushin",
  // 水道光熱費
  "623": "suidokonetsu",
  // 旅費交通費
  "621": "ryohikotsu",
  // 接待交際費
  "624": "settai",
  // 広告宣伝費
  "625": "kokoku",
  // 地代家賃
  "626": "chidai_yachin",
  // 給料賃金
  "627": "kyuryo_chinkin",
  // 外注工賃
  "628": "gaichu_kochin",
  // 減価償却費
  "629": "genka_shokyaku",
  // 福利厚生費
  "630": "fukuri_kosei",
  // 租税公課
  "631": "sozeikoka",
  // 損害保険料
  "632": "songai_hoken",
  // 修繕費
  "633": "shuzen",
  // 荷造運賃
  "634": "nitsukuriunchin",
  // 利子割引料
  "641": "rishi_waribiki",
  // 貸倒金
  "636": "kashidaore",
};

/**
 * コードから経費キーを解決。該当なしなら "zappi" (雑費) に寄せる。
 */
function resolveExpenseKey(accountCode: string): keyof BlueReturnData {
  // 完全一致 → 前方一致
  if (EXPENSE_CODE_MAP[accountCode]) return EXPENSE_CODE_MAP[accountCode];
  for (const prefix of Object.keys(EXPENSE_CODE_MAP)) {
    if (accountCode.startsWith(prefix)) return EXPENSE_CODE_MAP[prefix];
  }
  return "zappi";
}

// ──────────────────────────────────────────────────────────
// 仕訳行型 (最低限)
// ──────────────────────────────────────────────────────────

export interface JournalLineLike {
  account_code: string;
  debit_amount: number;
  credit_amount: number;
}

export interface JournalLike {
  id: string;
  date: string; // YYYY-MM-DD
  lines?: JournalLineLike[];
}

// ──────────────────────────────────────────────────────────
// 確定申告書 (KOA020) マッピング
// ──────────────────────────────────────────────────────────

/**
 * TaxReturn から IncomeReturnData (第一表の金額部分) を生成。
 */
export function taxReturnToIncomeReturnData(
  tr: TaxReturn
): IncomeReturnData {
  const blueSpecial = tr.blue_special_deduction;
  // 所得控除合計 (basic + その他)
  const kojoGoukei =
    tr.basic_deduction +
    tr.social_insurance_deduction +
    tr.life_insurance_deduction +
    tr.earthquake_insurance_deduction +
    tr.spouse_deduction +
    tr.dependents_deduction +
    tr.medical_deduction +
    tr.small_business_deduction;

  // 所得税等の額 (= incomeTax + reconstructionTax)
  const shotokuzeiNoGaku = tr.income_tax + tr.reconstruction_tax;

  return {
    shinkoku_shurui: tr.return_type === "blue" ? "青色" : "白色",
    shinkoku_kbn_cd: "1",

    // 収入金額等
    eigyo_income: tr.revenue_total,

    // 所得金額等
    eigyo_shotoku: tr.income_total,
    goukei_shotoku: tr.income_total,

    // 所得控除
    iryo_kojo: tr.medical_deduction,
    shakaihoken_kojo: tr.social_insurance_deduction,
    shokibo_kojo: tr.small_business_deduction,
    seimei_kojo: tr.life_insurance_deduction,
    jishin_kojo: tr.earthquake_insurance_deduction,
    haigu_kojo: tr.spouse_deduction,
    fuyou_kojo: tr.dependents_deduction,
    kiso_kojo: tr.basic_deduction,
    kojo_goukei: kojoGoukei,

    // 税金の計算
    kazei_shotoku: tr.taxable_income,
    shotokuzei: tr.income_tax,
    fukkou_tokubetsu: tr.reconstruction_tax,
    shotokuzei_no_gaku: shotokuzeiNoGaku,
    gensen_choshu: tr.withholding_total,
    shinkoku_nouzei: shotokuzeiNoGaku - tr.withholding_total,
    osameru_zeikin: tr.tax_due > 0 ? tr.tax_due : undefined,
    kanpu_zeikin: tr.tax_due < 0 ? -tr.tax_due : undefined,

    // その他
    aoiro_tokubetsu_kojo: blueSpecial || undefined,
  };
}

// ──────────────────────────────────────────────────────────
// 青色申告決算書 (KOA210) マッピング
// ──────────────────────────────────────────────────────────

/**
 * 仕訳行から売上・仕入・経費科目別合計を集計し、
 * BlueReturnData の主要フィールドを組み立てる。
 *
 * 勘定科目コードのルール:
 *   - 先頭 4  = 収益 (売上・営業外収益)
 *   - 先頭 5  = 売上原価 (仕入)
 *   - 先頭 6  = 販売費・一般管理費 (経費)
 *   - 先頭 7  = 営業外費用
 *   - 他は無視
 */
export function aggregateBlueReturnData(
  tr: TaxReturn,
  journals: JournalLike[],
  opts?: {
    aoiroTokubetsuKojo?: number;
    senjushaKyuyo?: number;
  }
): BlueReturnData {
  // 月別売上・仕入集計
  const monthly: MonthlyAmount[] = Array.from({ length: 12 }, () => ({
    income: 0,
    cost: 0,
  }));

  // 科目別経費集計
  const expenseByKey: Record<string, number> = {};

  let uriage = 0;
  let shiire = 0;

  for (const j of journals) {
    const month = new Date(j.date).getMonth(); // 0-11
    for (const l of j.lines || []) {
      const code = l.account_code;
      if (code.startsWith("4")) {
        // 売上
        const amount = l.credit_amount - l.debit_amount;
        uriage += amount;
        if (monthly[month]) monthly[month].income! += amount;
      } else if (code.startsWith("5")) {
        // 売上原価 (仕入)
        const amount = l.debit_amount - l.credit_amount;
        shiire += amount;
        if (monthly[month]) monthly[month].cost! += amount;
      } else if (code.startsWith("6")) {
        // 経費
        const amount = l.debit_amount - l.credit_amount;
        const key = resolveExpenseKey(code);
        expenseByKey[key] = (expenseByKey[key] || 0) + amount;
      } else if (code.startsWith("7")) {
        // 営業外費用 (利子割引料等)
        const amount = l.debit_amount - l.credit_amount;
        expenseByKey["rishi_waribiki"] =
          (expenseByKey["rishi_waribiki"] || 0) + amount;
      }
    }
  }

  const data: BlueReturnData = {
    jigyo_kikan_jiko_from: `${tr.year}-01-01`,
    jigyo_kikan_itaru_to: `${tr.year}-12-31`,
    uriage,
    shiire,
    monthly,
    aoiro_tokubetsu_kojo: opts?.aoiroTokubetsuKojo ?? tr.blue_special_deduction,
    senjusha_kyuyo: opts?.senjushaKyuyo,
    // 経費科目を展開
    sozeikoka: expenseByKey["sozeikoka"],
    nitsukuriunchin: expenseByKey["nitsukuriunchin"],
    suidokonetsu: expenseByKey["suidokonetsu"],
    ryohikotsu: expenseByKey["ryohikotsu"],
    tsushin: expenseByKey["tsushin"],
    kokoku: expenseByKey["kokoku"],
    settai: expenseByKey["settai"],
    songai_hoken: expenseByKey["songai_hoken"],
    shuzen: expenseByKey["shuzen"],
    shomohin: expenseByKey["shomohin"],
    genka_shokyaku: expenseByKey["genka_shokyaku"],
    fukuri_kosei: expenseByKey["fukuri_kosei"],
    kyuryo_chinkin: expenseByKey["kyuryo_chinkin"],
    gaichu_kochin: expenseByKey["gaichu_kochin"],
    rishi_waribiki: expenseByKey["rishi_waribiki"],
    chidai_yachin: expenseByKey["chidai_yachin"],
    kashidaore: expenseByKey["kashidaore"],
    zappi: expenseByKey["zappi"],
  };

  return data;
}

// ──────────────────────────────────────────────────────────
// 消費税 (RSH0010 / RSH0030) マッピング
// ──────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────
// withholding_slips → ABD (所得の内訳) マッピング
// ──────────────────────────────────────────────────────────

/**
 * 源泉徴収票テーブルから ABD (所得の内訳) 項目を作る。
 */
export function withholdingSlipsToIncomeDetails(
  slips: WithholdingSlip[]
): IncomeBreakdownItem[] {
  return slips.map((s) => ({
    kind: "給与",
    shumoku: "給料・賞与",
    payer_name: s.payer_name || "(不明)",
    payer_identifier: s.payer_address || undefined,
    income: s.payment_amount,
    withholding: s.withholding_tax,
  }));
}

// ──────────────────────────────────────────────────────────
// fixed_assets → KOA210 減価償却明細 (AMF01600)
// ──────────────────────────────────────────────────────────

/**
 * 固定資産マスタから当年の減価償却明細を組み立てる。
 * fixed_asset_depreciations で当年の減価償却額を引き、
 * 残高を計算する (ナイーブ実装: depr_amount は year 指定で取る)。
 */
export function fixedAssetsToDepreciationItems(
  assets: FixedAsset[],
  depreciations: FixedAssetDepreciation[],
  year: number
): DepreciationItem[] {
  const deprByAsset = new Map<string, FixedAssetDepreciation>();
  for (const d of depreciations) {
    if (d.fiscal_year === year) {
      deprByAsset.set(d.fixed_asset_id, d);
    }
  }

  const items: DepreciationItem[] = [];
  for (const a of assets) {
    if (a.status !== "active") continue;
    const d = deprByAsset.get(a.id);
    if (!d) continue; // 当年減価償却の実績なし

    const months = 12; // 通年想定 (取得年月の場合は月数調整が必要、拡張余地)
    const useful = a.useful_life_years || 1;
    const rate =
      a.depreciation_method === "straight_line" ? 1 / useful : 0;

    items.push({
      name: a.name,
      acquired: a.acquisition_date.slice(0, 7),
      acquired_price: a.acquisition_cost,
      depreciation_base: a.acquisition_cost - (a.residual_value || 0),
      method: a.depreciation_method === "straight_line" ? "定額" : "定率",
      useful_years: useful,
      rate: Math.round(rate * 1000) / 1000,
      months,
      depreciation_year: d.depreciation_amount,
      business_use_ratio: Math.round((a.business_ratio || 1) * 100),
      expense_amount: d.depreciation_amount,
      book_value_kimatsu: d.book_value_after,
    });
  }

  return items;
}

// ──────────────────────────────────────────────────────────
// 仕訳残高 → BalanceSheetData (貸借対照表)
// ──────────────────────────────────────────────────────────

/**
 * 勘定科目コード → 貸借対照表項目キー へのマッピング。
 * 先頭桁で科目区分が決まるので、詳細マップを使う。
 *
 * 1xx = 流動資産
 *   111 現金
 *   112 当座預金 / 普通預金
 *   113 定期預金
 *   114 売掛金
 *   115 棚卸資産
 *   116 前払金
 *   117 貸付金
 * 13x = 固定資産
 *   131 建物
 *   132 建物附属設備
 *   133 機械装置
 *   134 車両運搬具
 *   135 工具・器具・備品
 *   136 土地
 * 2xx = 負債
 *   211 支払手形
 *   212 買掛金
 *   213 借入金
 *   214 未払金
 *   215 前受金
 *   216 預り金
 *   218 貸倒引当金
 * 3xx = 資本
 *   311 元入金
 *   312 事業主貸
 *   313 事業主借
 */
function bsKeyFromAccountCode(code: string): {
  side: "asset" | "liability";
  base: string;
} | null {
  const p2 = code.slice(0, 3);
  if (p2 === "111") return { side: "asset", base: "genkin" };
  if (p2 === "112") return { side: "asset", base: "sonota_yokin" };
  if (p2 === "113") return { side: "asset", base: "teiki" };
  if (p2 === "114") return { side: "asset", base: "urikake" };
  if (p2 === "115") return { side: "asset", base: "tanaoroshi" };
  if (p2 === "116") return { side: "asset", base: "maebarai" };
  if (p2 === "117") return { side: "asset", base: "kashitsuke" };
  if (p2 === "131") return { side: "asset", base: "tatemono" };
  if (p2 === "132") return { side: "asset", base: "tatemono_fuzoku" };
  if (p2 === "133") return { side: "asset", base: "kikai" };
  if (p2 === "134") return { side: "asset", base: "sharyo" };
  if (p2 === "135") return { side: "asset", base: "kogu" };
  if (p2 === "136") return { side: "asset", base: "tochi" };
  if (p2 === "211") return { side: "liability", base: "shiharai_tegata" };
  if (p2 === "212") return { side: "liability", base: "kaikake" };
  if (p2 === "213") return { side: "liability", base: "kariirekin" };
  if (p2 === "214") return { side: "liability", base: "miharaikin" };
  if (p2 === "215") return { side: "liability", base: "maeuke" };
  if (p2 === "216") return { side: "liability", base: "azukari" };
  if (p2 === "218") return { side: "liability", base: "kashidaore_hikiate" };
  if (p2 === "311") return { side: "liability", base: "motoire" };
  return null;
}

/**
 * 仕訳全行から BalanceSheetData を集計する。
 *
 * 前提:
 *   - 期首残高: 前年末時点までの累積 (year の 1/1 時点)
 *   - 期末残高: year の 12/31 時点の残高
 *   - 資産勘定は借方残高 (debit - credit)
 *   - 負債・資本勘定は貸方残高 (credit - debit)
 *
 * 簡易実装: year 以前の全仕訳の累積で期首残高、year 末までの累積で期末残高。
 */
export function aggregateBalanceSheet(
  year: number,
  allJournals: JournalLike[]
): BalanceSheetData {
  const kishuBalance: Record<string, number> = {};
  const kimatsuBalance: Record<string, number> = {};

  for (const j of allJournals) {
    const jYear = new Date(j.date).getFullYear();
    if (jYear > year) continue; // 未来年の仕訳は無視
    const isKishu = jYear < year; // 前年以前なら期首のみ
    for (const l of j.lines || []) {
      const map = bsKeyFromAccountCode(l.account_code);
      if (!map) continue;
      const signed =
        map.side === "asset"
          ? l.debit_amount - l.credit_amount
          : l.credit_amount - l.debit_amount;
      if (isKishu) {
        kishuBalance[map.base] = (kishuBalance[map.base] || 0) + signed;
      }
      // 期末は全て累積 (前年以前も含む)
      kimatsuBalance[map.base] = (kimatsuBalance[map.base] || 0) + signed;
    }
  }

  const bs: BalanceSheetData = {
    kimatsu_date: `${year}-12-31`,
  };

  // 資産側
  const assetFields: Array<[string, keyof BalanceSheetData, keyof BalanceSheetData]> = [
    ["genkin", "genkin_kishu", "genkin_kimatsu"],
    ["sonota_yokin", "sonota_yokin_kishu", "sonota_yokin_kimatsu"],
    ["teiki", "teiki_kishu", "teiki_kimatsu"],
    ["urikake", "urikake_kishu", "urikake_kimatsu"],
    ["tanaoroshi", "tanaoroshi_kishu", "tanaoroshi_kimatsu"],
    ["maebarai", "maebarai_kishu", "maebarai_kimatsu"],
    ["kashitsuke", "kashitsuke_kishu", "kashitsuke_kimatsu"],
    ["tatemono", "tatemono_kishu", "tatemono_kimatsu"],
    ["tatemono_fuzoku", "tatemono_fuzoku_kishu", "tatemono_fuzoku_kimatsu"],
    ["kikai", "kikai_kishu", "kikai_kimatsu"],
    ["sharyo", "sharyo_kishu", "sharyo_kimatsu"],
    ["kogu", "kogu_kishu", "kogu_kimatsu"],
    ["tochi", "tochi_kishu", "tochi_kimatsu"],
  ];
  const liabilityFields: Array<[string, keyof BalanceSheetData, keyof BalanceSheetData]> = [
    ["shiharai_tegata", "shiharai_tegata_kishu", "shiharai_tegata_kimatsu"],
    ["kaikake", "kaikake_kishu", "kaikake_kimatsu"],
    ["kariirekin", "kariirekin_kishu", "kariirekin_kimatsu"],
    ["miharaikin", "miharaikin_kishu", "miharaikin_kimatsu"],
    ["maeuke", "maeuke_kishu", "maeuke_kimatsu"],
    ["azukari", "azukari_kishu", "azukari_kimatsu"],
    ["kashidaore_hikiate", "kashidaore_hikiate_kishu", "kashidaore_hikiate_kimatsu"],
    ["motoire", "motoire_kishu", "motoire_kimatsu"],
  ];

  let assetTotalKishu = 0;
  let assetTotalKimatsu = 0;
  let liabilityTotalKishu = 0;
  let liabilityTotalKimatsu = 0;
  for (const [base, kKey, kmKey] of assetFields) {
    const ki = kishuBalance[base] || 0;
    const km = kimatsuBalance[base] || 0;
    if (ki) {
      (bs as Record<string, number>)[kKey as string] = ki;
      assetTotalKishu += ki;
    }
    if (km) {
      (bs as Record<string, number>)[kmKey as string] = km;
      assetTotalKimatsu += km;
    }
  }
  for (const [base, kKey, kmKey] of liabilityFields) {
    const ki = kishuBalance[base] || 0;
    const km = kimatsuBalance[base] || 0;
    if (ki) {
      (bs as Record<string, number>)[kKey as string] = ki;
      liabilityTotalKishu += ki;
    }
    if (km) {
      (bs as Record<string, number>)[kmKey as string] = km;
      liabilityTotalKimatsu += km;
    }
  }

  if (assetTotalKishu) bs.shisan_goukei_kishu = assetTotalKishu;
  if (assetTotalKimatsu) bs.shisan_goukei_kimatsu = assetTotalKimatsu;
  if (liabilityTotalKishu) bs.fusai_goukei_kishu = liabilityTotalKishu;
  if (liabilityTotalKimatsu) bs.fusai_goukei_kimatsu = liabilityTotalKimatsu;

  return bs;
}

/**
 * 原則課税の消費税申告データを TaxReturn + 集計結果から組み立て。
 *
 * @param kazei 課税売上 (税抜)
 * @param koujyo 仕入税額控除 (仮払消費税等の合計)
 */
export function buildConsumptionTaxStandardFromAggregate(args: {
  year: number;
  kazeiUri: number; // 課税売上 (税抜)
  shiireZei: number; // 仕入税額控除
}): ConsumptionTaxStandardData {
  const { year, kazeiUri, shiireZei } = args;

  // 課税標準額 (千円未満切り捨て)
  const kazeiHyojun = Math.floor(kazeiUri / 1000) * 1000;

  // 消費税額 (7.8% 国税分)
  const shohizei = Math.floor((kazeiHyojun * 78) / 1000);

  // 差引税額 (100円未満切り捨て)
  const sashihiki = Math.max(0, shohizei - Math.floor(shiireZei));
  const sashihikiFlat = Math.floor(sashihiki / 100) * 100;

  // 地方消費税 = 国税 × 22/78
  const jouto = Math.floor((sashihikiFlat * 22) / 78);
  const joutoFlat = Math.floor(jouto / 100) * 100;

  return {
    kazei_from: `${year}-01-01`,
    kazei_to: `${year}-12-31`,
    kazei_hyojun: kazeiHyojun,
    shohizei,
    kojo_zeigaku: Math.floor(shiireZei),
    sashihiki_zeigaku: sashihikiFlat,
    nofu_zeigaku: sashihikiFlat,
    chihou_kazei_hyojun: sashihikiFlat,
    jouto_wari_gaku: joutoFlat,
    nofu_jouto_wari: joutoFlat,
    total_nofu: sashihikiFlat + joutoFlat,
  };
}

/**
 * 簡易課税の消費税申告データを組み立て。
 */
export function buildConsumptionTaxSimplifiedFromAggregate(args: {
  year: number;
  kazeiUri: number;
  jigyoKubun: 1 | 2 | 3 | 4 | 5 | 6;
}): ConsumptionTaxSimplifiedData {
  const { year, kazeiUri, jigyoKubun } = args;
  const kazeiHyojun = Math.floor(kazeiUri / 1000) * 1000;
  const shohizei = Math.floor((kazeiHyojun * 78) / 1000);

  // みなし仕入率
  const minashi: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
    1: 0.9, // 卸
    2: 0.8, // 小売
    3: 0.7, // 製造
    4: 0.6, // その他
    5: 0.5, // サービス
    6: 0.4, // 不動産
  };
  const rate = minashi[jigyoKubun];
  const kojo = Math.floor(shohizei * rate);
  const sashihiki = Math.max(0, shohizei - kojo);
  const sashihikiFlat = Math.floor(sashihiki / 100) * 100;
  const jouto = Math.floor((sashihikiFlat * 22) / 78);
  const joutoFlat = Math.floor(jouto / 100) * 100;

  return {
    kazei_from: `${year}-01-01`,
    kazei_to: `${year}-12-31`,
    jigyo_kubun: jigyoKubun,
    kazei_hyojun: kazeiHyojun,
    shohizei,
    kojo_zeigaku: kojo,
    sashihiki_zeigaku: sashihikiFlat,
    nofu_zeigaku: sashihikiFlat,
    chihou_kazei_hyojun: sashihikiFlat,
    jouto_wari_gaku: joutoFlat,
    nofu_jouto_wari: joutoFlat,
    total_nofu: sashihikiFlat + joutoFlat,
  };
}
