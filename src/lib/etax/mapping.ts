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
import { straightLineRate, monthsInService } from "@/lib/depreciation";
import {
  classifyAccountCode,
  DEFAULT_CATEGORY_MAP,
  type AccountCategoryMap,
} from "@/lib/accounts";

// ──────────────────────────────────────────────────────────
// 勘定科目コード → 青色決算書の経費科目 のマッピング
// ──────────────────────────────────────────────────────────

/**
 * アプリの勘定科目コード (src/lib/accounts.ts の DEFAULT_ACCOUNTS) を、
 * 青色申告決算書 (KOA210) の経費科目カラムに対応させる。
 *
 * e-Tax 固定の経費区分:
 *   租税公課 / 荷造運賃 / 水道光熱費 / 旅費交通費 / 通信費 /
 *   広告宣伝費 / 接待交際費 / 損害保険料 / 修繕費 / 消耗品費 /
 *   減価償却費 / 福利厚生費 / 給料賃金 / 外注工賃 / 利子割引料 /
 *   地代家賃 / 貸倒金 / 雑費
 *
 * 以前のこの表は、科目表を作り直す前の古いコード体系 (611=消耗品費、
 * 621=旅費交通費、622=通信費、…、629=減価償却費) のままだった。そのため
 *   - 減価償却費 (611) が「消耗品費」に、会議費 (621) が「旅費交通費」に、
 *     支払手数料 (622) が「通信費」に、車両費 (623) が「水道光熱費」に、
 *     研修費 (624) が「接待交際費」に計上され、
 *   - 租税公課〜消耗品費 (601〜610) と 612〜617 は全て「雑費」に落ち、
 *   - 決算書の「減価償却費」欄は常に空
 * になっていた (合計は合うが、科目別の内訳が全部間違っている)。
 * mapping.test.ts が科目表と突き合わせて検査するので、科目を足したらここも更新する。
 */
const EXPENSE_CODE_MAP: Record<string, keyof BlueReturnData> = {
  "601": "sozeikoka", // 租税公課
  "602": "nitsukuriunchin", // 荷造運賃
  "603": "suidokonetsu", // 水道光熱費
  "604": "ryohikotsu", // 旅費交通費
  "605": "tsushin", // 通信費
  "606": "kokoku", // 広告宣伝費
  "607": "settai", // 接待交際費
  "608": "songai_hoken", // 損害保険料
  "609": "shuzen", // 修繕費
  "610": "shomohin", // 消耗品費
  "611": "genka_shokyaku", // 減価償却費
  "612": "fukuri_kosei", // 福利厚生費
  "613": "kyuryo_chinkin", // 給料賃金
  "614": "gaichu_kochin", // 外注工賃
  "615": "rishi_waribiki", // 利子割引料
  "616": "chidai_yachin", // 地代家賃
  "617": "kashidaore", // 貸倒金
  // 620 新聞図書費 / 621 会議費 / 622 支払手数料 / 623 車両費 / 624 研修費 / 699 雑費 と
  // 利用者が追加した経費科目は、決算書に専用の欄が無いので「雑費」に合算する。
};

/**
 * コードから経費キーを解決。専用の欄が無い経費は "zappi" (雑費) に寄せる。
 * 完全一致のみ (前方一致で別の科目に寄せると、桁数の違うコードが誤って入る)。
 */
export function resolveExpenseKey(accountCode: string): keyof BlueReturnData {
  return EXPENSE_CODE_MAP[accountCode] ?? "zappi";
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
  // 事業所得 = 売上 − 経費 − 青色申告特別控除 (控除は所得を上限とする)
  const businessIncome = tr.income_total - Math.min(blueSpecial, Math.max(0, tr.income_total));

  return {
    shinkoku_shurui: tr.return_type === "blue" ? "青色" : "白色",
    shinkoku_kbn_cd: "1",

    // 収入金額等
    eigyo_income: tr.revenue_total,

    // 所得金額等。tax_returns.income_total は「売上 − 経費」(青色申告特別控除前) なので、
    // 申告書の所得金額 (①・⑫) には控除後の金額を入れる。控除前のままだと
    // 決算書の所得金額と一致せず、⑫ − 所得控除 ≠ 課税される所得金額 になる。
    eigyo_shotoku: businessIncome,
    goukei_shotoku: businessIncome,

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
    /** コード → 区分。利用者が追加した科目も分類したい時に渡す (省略時は既定の科目表) */
    categories?: AccountCategoryMap;
  }
): BlueReturnData {
  const categories = opts?.categories ?? DEFAULT_CATEGORY_MAP;
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
    // "YYYY-MM-DD" の月をそのまま読む (new Date() だと UTC 解釈でタイムゾーンによっては前月になる)
    const month = Number(j.date.slice(5, 7)) - 1; // 0-11
    for (const l of j.lines || []) {
      const code = l.account_code;
      // 区分は科目表から引く。コードの先頭桁で判定すると、取込で付いた 999 (未分類) を
      // 黙って捨てたり、桁の合う別体系のコードを誤って拾ったりする。
      const kind = classifyAccountCode(code, categories);
      if (kind === "revenue") {
        // 売上 (雑収入等を含む)
        const amount = l.credit_amount - l.debit_amount;
        uriage += amount;
        if (monthly[month]) monthly[month].income! += amount;
      } else if (kind === "cogs") {
        // 売上原価 (仕入)
        const amount = l.debit_amount - l.credit_amount;
        shiire += amount;
        if (monthly[month]) monthly[month].cost! += amount;
      } else if (kind === "expense") {
        // 経費
        const amount = l.debit_amount - l.credit_amount;
        const key = resolveExpenseKey(code);
        expenseByKey[key] = (expenseByKey[key] || 0) + amount;
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

    const months = monthsInService(a, year);
    const useful = a.useful_life_years || 1;
    const rate =
      a.depreciation_method === "straight_line" ? straightLineRate(useful) : 0;

    items.push({
      name: a.name,
      acquired: a.acquisition_date.slice(0, 7),
      acquired_price: a.acquisition_cost,
      depreciation_base: a.acquisition_cost - (a.residual_value || 0),
      method: a.depreciation_method === "straight_line" ? "定額" : "定率",
      useful_years: useful,
      rate,
      months,
      depreciation_year: d.depreciation_amount,
      // business_ratio は 0-100 の整数。旧実装は ×100 して 10000% になっていた
      business_use_ratio: a.business_ratio ?? 100,
      expense_amount: Math.floor(
        (d.depreciation_amount * (a.business_ratio ?? 100)) / 100
      ),
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
  return BS_CODE_MAP[code] ?? null;
}

/**
 * アプリの勘定科目コード → 貸借対照表 (KOA210) の欄。
 *
 * 以前は上のコメントにある古いコード体系 (111=現金、112=普通預金、311=元入金…) を
 * 前提にしていたため、現在の科目表 (100=現金、110=普通預金、300=元入金…) では
 * ほぼ全ての残高がどの欄にも入らず、貸借対照表が日付だけになっていた。
 * 一致してしまう一部のコードは逆に別の欄へ入っていた (111 当座預金 → 現金 など)。
 *
 * 決算書に専用の欄が無い科目 (未収入金・仮払金・仮払/仮受消費税・ソフトウェア・
 * 未払消費税・仮受金) は対応させていない。これらに残高がある場合、貸借の合計は
 * 手で空欄に書き足す必要がある。
 */
const BS_CODE_MAP: Record<string, { side: "asset" | "liability"; base: string }> = {
  "100": { side: "asset", base: "genkin" }, // 現金
  "101": { side: "asset", base: "genkin" }, // 小口現金
  "110": { side: "asset", base: "sonota_yokin" }, // 普通預金 →「その他の預金」
  "111": { side: "asset", base: "toza" }, // 当座預金
  "112": { side: "asset", base: "teiki" }, // 定期預金
  "120": { side: "asset", base: "urikake" }, // 売掛金
  "121": { side: "asset", base: "uketori_tegata" }, // 受取手形
  "130": { side: "asset", base: "maebarai" }, // 前払金
  "131": { side: "asset", base: "maebarai" }, // 前払費用
  "140": { side: "asset", base: "tanaoroshi" }, // 棚卸資産
  "160": { side: "asset", base: "tatemono" }, // 建物
  "161": { side: "asset", base: "tatemono_fuzoku" }, // 建物附属設備
  "162": { side: "asset", base: "sharyo" }, // 車両運搬具
  "163": { side: "asset", base: "kogu" }, // 工具器具備品
  "164": { side: "asset", base: "tochi" }, // 土地
  "200": { side: "liability", base: "kaikake" }, // 買掛金
  "201": { side: "liability", base: "shiharai_tegata" }, // 支払手形
  "210": { side: "liability", base: "miharaikin" }, // 未払金
  "211": { side: "liability", base: "miharaikin" }, // 未払費用
  "220": { side: "liability", base: "azukari" }, // 預り金
  "221": { side: "liability", base: "azukari" }, // 源泉所得税預り
  "230": { side: "liability", base: "maeuke" }, // 前受金
  "240": { side: "liability", base: "kariirekin" }, // 短期借入金
  "241": { side: "liability", base: "kariirekin" }, // 長期借入金
  "300": { side: "liability", base: "motoire" }, // 元入金
};

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
    const jYear = Number(j.date.slice(0, 4)); // 文字列の年をそのまま読む (タイムゾーン非依存)
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
    ["toza", "toza_kishu", "toza_kimatsu"],
    ["sonota_yokin", "sonota_yokin_kishu", "sonota_yokin_kimatsu"],
    ["teiki", "teiki_kishu", "teiki_kimatsu"],
    ["uketori_tegata", "uketori_tegata_kishu", "uketori_tegata_kimatsu"],
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
