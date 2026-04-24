/**
 * 青色申告決算書 (一般用) KOA210 - 令和7年分 (v11.0) 帳票個別部分。
 *
 * スキーマ: specs/etax/e-tax19/19XMLスキーマ/shotoku/KOA210-011.xsd
 *
 * 4ページ構成:
 *   KOA210-1: 表紙 + 損益計算書
 *   KOA210-2: 月別売上 + 給料内訳等
 *   KOA210-3: 減価償却 等
 *   KOA210-4: 貸借対照表
 *
 * XTX 全体ではなく、RKO0010 手続内の帳票個別部分として出現する。
 */

import type { EtaxContext } from "./types";
import {
  EMBEDDED_FORM_VERSIONS,
  buildSoftNM,
  yearToWareki,
} from "./codes";
import { type XmlNode, el, elc, ref } from "./xml-builder";

export interface MonthlyAmount {
  income?: number;
  cost?: number;
}

export interface BlueReturnData {
  jigyo_kikan_jiko_from: string;
  jigyo_kikan_itaru_to: string;

  uriage: number;
  kishu_tanaoroshi?: number;
  shiire: number;
  kimatsu_tanaoroshi?: number;

  sozeikoka?: number;
  nitsukuriunchin?: number;
  suidokonetsu?: number;
  ryohikotsu?: number;
  tsushin?: number;
  kokoku?: number;
  settai?: number;
  songai_hoken?: number;
  shuzen?: number;
  shomohin?: number;
  genka_shokyaku?: number;
  fukuri_kosei?: number;
  kyuryo_chinkin?: number;
  gaichu_kochin?: number;
  rishi_waribiki?: number;
  chidai_yachin?: number;
  kashidaore?: number;
  zappi?: number;

  senjusha_kyuyo?: number;
  kashidaore_hikiate_kuriire?: number;

  aoiro_tokubetsu_kojo?: number;

  monthly?: MonthlyAmount[];
  kaji_shohi?: number;
  zatsu_shunyu?: number;

  /**
   * 貸借対照表の明細。期首 (事業年度の1/1) / 期末 (12/31) の値をそれぞれ保持。
   * 金額欄は円単位整数。空値はゼロ扱い。
   */
  bs?: BalanceSheetData;

  /**
   * 減価償却費の明細 (AMF01600 繰り返し)
   */
  depreciation?: DepreciationItem[];
}

/**
 * 減価償却資産 1 件分。
 */
export interface DepreciationItem {
  /** 資産名称 (例: "ノートPC (MacBook Pro)") */
  name: string;
  /** 面積又は数量 (例: "1台") */
  quantity?: string;
  /** 取得年月 ISO (YYYY-MM) */
  acquired: string;
  /** 取得価額 */
  acquired_price: number;
  /** 償却の基礎になる金額 */
  depreciation_base: number;
  /** 償却方法 ("定額" / "定率" など) */
  method: string;
  /** 耐用年数 */
  useful_years: number;
  /** 償却率 */
  rate: number;
  /** 本年中の償却期間 (月数) */
  months: number;
  /** 本年分の普通償却費 */
  depreciation_year: number;
  /** 事業専用割合 (%) */
  business_use_ratio: number;
  /** 本年分の必要経費算入額 */
  expense_amount: number;
  /** 未償却残高 (期末) */
  book_value_kimatsu: number;
  /** 摘要 */
  note?: string;
}

/**
 * 貸借対照表データ。勘定科目のうち主要なものを網羅する。
 * 追加科目は未対応 (必要になれば BalanceSheetData を拡張)。
 */
export interface BalanceSheetData {
  /** 期末年月日 (ISO) */
  kimatsu_date?: string;

  // 資産の部
  genkin_kishu?: number;
  genkin_kimatsu?: number;
  toza_kishu?: number;
  toza_kimatsu?: number;
  teiki_kishu?: number;
  teiki_kimatsu?: number;
  sonota_yokin_kishu?: number;
  sonota_yokin_kimatsu?: number;
  uketori_tegata_kishu?: number;
  uketori_tegata_kimatsu?: number;
  urikake_kishu?: number;
  urikake_kimatsu?: number;
  yuka_shoken_kishu?: number;
  yuka_shoken_kimatsu?: number;
  tanaoroshi_kishu?: number;
  tanaoroshi_kimatsu?: number;
  maebarai_kishu?: number;
  maebarai_kimatsu?: number;
  kashitsuke_kishu?: number;
  kashitsuke_kimatsu?: number;
  tatemono_kishu?: number;
  tatemono_kimatsu?: number;
  tatemono_fuzoku_kishu?: number;
  tatemono_fuzoku_kimatsu?: number;
  kikai_kishu?: number;
  kikai_kimatsu?: number;
  sharyo_kishu?: number;
  sharyo_kimatsu?: number;
  kogu_kishu?: number;
  kogu_kimatsu?: number;
  tochi_kishu?: number;
  tochi_kimatsu?: number;
  /** 事業主貸 (期末のみ) */
  jigyonushi_kashi_kimatsu?: number;
  /** 資産合計 */
  shisan_goukei_kishu?: number;
  shisan_goukei_kimatsu?: number;

  // 負債・資本の部
  shiharai_tegata_kishu?: number;
  shiharai_tegata_kimatsu?: number;
  kaikake_kishu?: number;
  kaikake_kimatsu?: number;
  kariirekin_kishu?: number;
  kariirekin_kimatsu?: number;
  miharaikin_kishu?: number;
  miharaikin_kimatsu?: number;
  maeuke_kishu?: number;
  maeuke_kimatsu?: number;
  azukari_kishu?: number;
  azukari_kimatsu?: number;
  kashidaore_hikiate_kishu?: number;
  kashidaore_hikiate_kimatsu?: number;
  /** 元入金 */
  motoire_kishu?: number;
  motoire_kimatsu?: number;
  /** 事業主借 (期末のみ) */
  jigyonushi_kari_kimatsu?: number;
  /** 青色申告特別控除前の所得金額 (期末のみ) */
  aoiro_mae_shotoku_kimatsu?: number;
  /** 負債・資本合計 */
  fusai_goukei_kishu?: number;
  fusai_goukei_kimatsu?: number;
}

function formAttrs(
  ctx: EtaxContext,
  version: string,
  id: string,
  page: number
): Record<string, string | number> {
  const s = buildSoftNM(ctx.softName, ctx.vendorName);
  return {
    VR: version,
    id: `${id}-${page}`,
    page,
    sakuseiDay: ctx.sakuseiDay,
    sakuseiNM: s,
    softNM: s,
  };
}

function yenEl(tag: string, amount: number | undefined): XmlNode | undefined {
  if (amount === undefined || amount === null) return undefined;
  return el(tag, Math.round(amount));
}

function isoToWarekiChildren(iso: string): XmlNode[] {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const wy = yearToWareki(y);
  return [el("era", wy.era), el("yy", wy.yy), el("mm", m), el("dd", d)];
}

function buildPage1(ctx: EtaxContext, d: BlueReturnData): XmlNode {
  const wy = yearToWareki(ctx.fiscalYear);

  const nenbun = elc("AMA00000", [
    elc("AMA00010", [el("era", wy.era), el("yy", wy.yy)]),
  ]);

  const nozeisha = elc("AMB00000", [
    ref("AMB00010", "NOZEISHA_ZIP"),
    ref("AMB00020", "NOZEISHA_ADR"),
    ref("AMB00070", "NOZEISHA_NM_KN"),
    ref("AMB00080", "NOZEISHA_NM"),
    ...(ctx.taxpayer.shokugyo ? [ref("AMB00100", "SHOKUGYO")] : []),
    ...(ctx.taxpayer.yago ? [ref("AMB00110", "NOZEISHA_YAGO")] : []),
    ...(ctx.taxpayer.phone ? [ref("AMB00120", "NOZEISHA_TEL")] : []),
  ]);

  const teishutsu = elc("AME00000", [ref("AME00010", "TEISYUTSU_DAY")]);

  const pl_breakdown: XmlNode[] = [];
  pl_breakdown.push(
    elc("AMF00020", [
      elc("AMF00030", isoToWarekiChildren(d.jigyo_kikan_jiko_from)),
      elc("AMF00040", isoToWarekiChildren(d.jigyo_kikan_itaru_to)),
    ])
  );

  const kingaku: XmlNode[] = [];
  kingaku.push(el("AMF00100", Math.round(d.uriage)));

  const uriagegenka: XmlNode[] = [];
  const kishu = yenEl("AMF00120", d.kishu_tanaoroshi);
  if (kishu) uriagegenka.push(kishu);
  uriagegenka.push(el("AMF00130", Math.round(d.shiire)));
  const shokei = (d.kishu_tanaoroshi || 0) + d.shiire;
  uriagegenka.push(el("AMF00140", shokei));
  const kimatsu = yenEl("AMF00150", d.kimatsu_tanaoroshi);
  if (kimatsu) uriagegenka.push(kimatsu);
  const sashihiki_genka = shokei - (d.kimatsu_tanaoroshi || 0);
  uriagegenka.push(el("AMF00160", sashihiki_genka));
  kingaku.push(elc("AMF00110", uriagegenka));

  const sashihiki = Math.round(d.uriage) - sashihiki_genka;
  kingaku.push(el("AMF00170", sashihiki));

  const keihi: Array<XmlNode | undefined> = [
    yenEl("AMF00190", d.sozeikoka),
    yenEl("AMF00200", d.nitsukuriunchin),
    yenEl("AMF00210", d.suidokonetsu),
    yenEl("AMF00220", d.ryohikotsu),
    yenEl("AMF00230", d.tsushin),
    yenEl("AMF00240", d.kokoku),
    yenEl("AMF00250", d.settai),
    yenEl("AMF00260", d.songai_hoken),
    yenEl("AMF00270", d.shuzen),
    yenEl("AMF00280", d.shomohin),
    yenEl("AMF00290", d.genka_shokyaku),
    yenEl("AMF00300", d.fukuri_kosei),
    yenEl("AMF00310", d.kyuryo_chinkin),
    yenEl("AMF00320", d.gaichu_kochin),
    yenEl("AMF00330", d.rishi_waribiki),
    yenEl("AMF00340", d.chidai_yachin),
    yenEl("AMF00350", d.kashidaore),
    yenEl("AMF00370", d.zappi),
  ];
  const keihi_total = keihi.reduce((s, n) => {
    if (!n) return s;
    return s + (parseInt(n.text as string) || 0);
  }, 0);
  const keihi_nodes = keihi.filter((x): x is XmlNode => !!x);
  keihi_nodes.push(el("AMF00380", keihi_total));
  kingaku.push(elc("AMF00180", keihi_nodes));

  const sashihiki_after = sashihiki - keihi_total;
  kingaku.push(el("AMF00390", sashihiki_after));

  if (d.senjusha_kyuyo || d.kashidaore_hikiate_kuriire) {
    const kuriire: XmlNode[] = [];
    if (d.senjusha_kyuyo) kuriire.push(el("AMF00460", d.senjusha_kyuyo));
    if (d.kashidaore_hikiate_kuriire)
      kuriire.push(el("AMF00470", d.kashidaore_hikiate_kuriire));
    const total = (d.senjusha_kyuyo || 0) + (d.kashidaore_hikiate_kuriire || 0);
    kuriire.push(el("AMF00490", total));
    kingaku.push(elc("AMF00450", kuriire));
  }

  const aoiro_mae =
    sashihiki_after - (d.senjusha_kyuyo || 0) - (d.kashidaore_hikiate_kuriire || 0);
  kingaku.push(el("AMF00500", aoiro_mae));
  if (d.aoiro_tokubetsu_kojo) {
    kingaku.push(el("AMF00510", d.aoiro_tokubetsu_kojo));
  }
  const shotoku = aoiro_mae - (d.aoiro_tokubetsu_kojo || 0);
  kingaku.push(el("AMF00530", shotoku));

  pl_breakdown.push(elc("AMF00090", kingaku));

  const pl = elc("AMF00000", [elc("AMF00010", pl_breakdown)]);

  return elc("KOA210-1", [nenbun, nozeisha, teishutsu, pl], { page: 1 });
}

function buildPage2(_ctx: EtaxContext, d: BlueReturnData): XmlNode {
  // KOA210-2 (FA3026 月別売上) は帳票右上に「令和N年分」「フリガナ/氏名」欄を持つ。
  // IT 部 NENBUN / NOZEISHA_NM(_KN) を IDREF で参照しないと PDF 上で空表示になる。
  const children: XmlNode[] = [
    ref("AMF00538", "NENBUN"),
    elc("AMF00540", [
      ref("AMF00550", "NOZEISHA_NM_KN"),
      ref("AMF00560", "NOZEISHA_NM"),
    ]),
  ];
  if (d.monthly && d.monthly.length === 12) {
    const kids: XmlNode[] = [];
    const monthTags = [
      ["AMF00590", "AMF00600", "AMF00610"],
      ["AMF00620", "AMF00630", "AMF00640"],
      ["AMF00650", "AMF00660", "AMF00670"],
      ["AMF00680", "AMF00690", "AMF00700"],
      ["AMF00710", "AMF00720", "AMF00730"],
      ["AMF00740", "AMF00750", "AMF00760"],
      ["AMF00770", "AMF00780", "AMF00790"],
      ["AMF00800", "AMF00810", "AMF00820"],
      ["AMF00830", "AMF00840", "AMF00850"],
      ["AMF00860", "AMF00870", "AMF00880"],
      ["AMF00890", "AMF00900", "AMF00910"],
      ["AMF00920", "AMF00930", "AMF00940"],
    ];
    for (let i = 0; i < 12; i++) {
      const m = d.monthly[i];
      const [wrapTag, incomeTag, costTag] = monthTags[i];
      const sub: XmlNode[] = [];
      if (m.income != null) sub.push(el(incomeTag, Math.round(m.income)));
      if (m.cost != null) sub.push(el(costTag, Math.round(m.cost)));
      if (sub.length) kids.push(elc(wrapTag, sub));
    }
    if (d.kaji_shohi) kids.push(el("AMF00950", Math.round(d.kaji_shohi)));
    if (d.zatsu_shunyu) kids.push(el("AMF00960", Math.round(d.zatsu_shunyu)));
    const totalIncome =
      d.monthly.reduce((s, m) => s + (m.income || 0), 0) +
      (d.kaji_shohi || 0) +
      (d.zatsu_shunyu || 0);
    const totalCost = d.monthly.reduce((s, m) => s + (m.cost || 0), 0);
    kids.push(
      elc("AMF00970", [
        el("AMF00980", Math.round(totalIncome)),
        el("AMF00990", Math.round(totalCost)),
      ])
    );
    children.push(elc("AMF00580", kids));
  }
  return elc("KOA210-2", children, { page: 1 });
}

/**
 * KOA210-3 (3ページ目): 減価償却明細 + 利子割引料/地代家賃/税理士報酬内訳
 * 現状は減価償却のみ実装 (最頻出、他は必要に応じて拡張)。
 */
function buildPage3(_ctx: EtaxContext, d: BlueReturnData): XmlNode {
  const children: XmlNode[] = [];

  if (d.depreciation && d.depreciation.length > 0) {
    const rows: XmlNode[] = [];
    let totalNormal = 0;
    let totalExpense = 0;
    let totalBook = 0;
    for (const item of d.depreciation) {
      totalNormal += item.depreciation_year;
      totalExpense += item.expense_amount;
      totalBook += item.book_value_kimatsu;

      const [y, m] = item.acquired.split("-").map((s) => parseInt(s, 10));
      const wy = yearToWareki(y);

      const row: XmlNode[] = [
        el("AMF01610", item.name),
        ...(item.quantity ? [el("AMF01620", item.quantity)] : []),
        elc("AMF01630", [
          el("era", wy.era),
          el("yy", wy.yy),
          el("mm", m),
        ]),
        el("AMF01640", Math.round(item.acquired_price)),
        el("AMF01650", Math.round(item.depreciation_base)),
        el("AMF01660", item.method),
        el("AMF01670", item.useful_years),
        el("AMF01680", item.rate),
        el("AMF01720", item.months),
        el("AMF01730", Math.round(item.depreciation_year)),
        el("AMF01750", Math.round(item.depreciation_year)),
        el("AMF01760", item.business_use_ratio),
        el("AMF01770", Math.round(item.expense_amount)),
        el("AMF01780", Math.round(item.book_value_kimatsu)),
        ...(item.note ? [el("AMF01790", item.note)] : []),
      ];
      rows.push(elc("AMF01600", row));
    }
    // 計
    rows.push(
      elc("AMF01800", [
        el("AMF01810", totalNormal),
        el("AMF01830", totalNormal),
        el("AMF01840", totalExpense),
        el("AMF01850", totalBook),
      ])
    );
    children.push(elc("AMF01590", rows));
  }

  return elc("KOA210-3", children, { page: 1 });
}

/**
 * 貸借対照表 (AMG00000) を生成。期首 (AMG00040) と期末 (AMG00240) をそれぞれ
 * 科目別子要素で表現する。負債も同様。
 *
 * スキーマ準拠のタグ:
 *   資産 期首: AMG00060〜AMG00210 (科目)、AMG00230 (合計)
 *   資産 期末: AMG00260〜AMG00410 (科目)、AMG00430 事業主貸、AMG00440 (合計)
 *   負債 期首: AMG00510〜AMG00580 (科目)、AMG00600 元入金、AMG00610 合計
 *   負債 期末: AMG00640〜AMG00710 (科目)、AMG00730 事業主借、AMG00740 元入金、
 *              AMG00750 青特前所得、AMG00760 合計
 */
function buildPage4(_ctx: EtaxContext, d: BlueReturnData): XmlNode {
  if (!d.bs) return elc("KOA210-4", [], { page: 1 });

  const bs = d.bs;
  const children: XmlNode[] = [];

  // 期末年月日
  if (bs.kimatsu_date) {
    const [y, m, dd] = bs.kimatsu_date.split("-").map((s) => parseInt(s, 10));
    const wy = yearToWareki(y);
    children.push(
      elc("AMG00010", [
        el("era", wy.era),
        el("yy", wy.yy),
        el("mm", m),
        el("dd", dd),
      ])
    );
  }

  // 資産の部
  const shisan: XmlNode[] = [];
  // 期首
  const kishu_assets: XmlNode[] = [];
  const pushYen = (arr: XmlNode[], tag: string, val: number | undefined) => {
    if (val != null) arr.push(el(tag, Math.round(val)));
  };
  pushYen(kishu_assets, "AMG00060", bs.genkin_kishu);
  pushYen(kishu_assets, "AMG00070", bs.toza_kishu);
  pushYen(kishu_assets, "AMG00080", bs.teiki_kishu);
  pushYen(kishu_assets, "AMG00090", bs.sonota_yokin_kishu);
  pushYen(kishu_assets, "AMG00100", bs.uketori_tegata_kishu);
  pushYen(kishu_assets, "AMG00110", bs.urikake_kishu);
  pushYen(kishu_assets, "AMG00120", bs.yuka_shoken_kishu);
  pushYen(kishu_assets, "AMG00130", bs.tanaoroshi_kishu);
  pushYen(kishu_assets, "AMG00140", bs.maebarai_kishu);
  pushYen(kishu_assets, "AMG00150", bs.kashitsuke_kishu);
  pushYen(kishu_assets, "AMG00160", bs.tatemono_kishu);
  pushYen(kishu_assets, "AMG00170", bs.tatemono_fuzoku_kishu);
  pushYen(kishu_assets, "AMG00180", bs.kikai_kishu);
  pushYen(kishu_assets, "AMG00190", bs.sharyo_kishu);
  pushYen(kishu_assets, "AMG00200", bs.kogu_kishu);
  pushYen(kishu_assets, "AMG00210", bs.tochi_kishu);
  if (bs.shisan_goukei_kishu != null)
    kishu_assets.push(el("AMG00230", Math.round(bs.shisan_goukei_kishu)));
  if (kishu_assets.length) shisan.push(elc("AMG00040", kishu_assets));

  // 期末
  const kimatsu_assets: XmlNode[] = [];
  pushYen(kimatsu_assets, "AMG00260", bs.genkin_kimatsu);
  pushYen(kimatsu_assets, "AMG00270", bs.toza_kimatsu);
  pushYen(kimatsu_assets, "AMG00280", bs.teiki_kimatsu);
  pushYen(kimatsu_assets, "AMG00290", bs.sonota_yokin_kimatsu);
  pushYen(kimatsu_assets, "AMG00300", bs.uketori_tegata_kimatsu);
  pushYen(kimatsu_assets, "AMG00310", bs.urikake_kimatsu);
  pushYen(kimatsu_assets, "AMG00320", bs.yuka_shoken_kimatsu);
  pushYen(kimatsu_assets, "AMG00330", bs.tanaoroshi_kimatsu);
  pushYen(kimatsu_assets, "AMG00340", bs.maebarai_kimatsu);
  pushYen(kimatsu_assets, "AMG00350", bs.kashitsuke_kimatsu);
  pushYen(kimatsu_assets, "AMG00360", bs.tatemono_kimatsu);
  pushYen(kimatsu_assets, "AMG00370", bs.tatemono_fuzoku_kimatsu);
  pushYen(kimatsu_assets, "AMG00380", bs.kikai_kimatsu);
  pushYen(kimatsu_assets, "AMG00390", bs.sharyo_kimatsu);
  pushYen(kimatsu_assets, "AMG00400", bs.kogu_kimatsu);
  pushYen(kimatsu_assets, "AMG00410", bs.tochi_kimatsu);
  pushYen(kimatsu_assets, "AMG00430", bs.jigyonushi_kashi_kimatsu);
  if (bs.shisan_goukei_kimatsu != null)
    kimatsu_assets.push(el("AMG00440", Math.round(bs.shisan_goukei_kimatsu)));
  if (kimatsu_assets.length) shisan.push(elc("AMG00240", kimatsu_assets));

  if (shisan.length) children.push(elc("AMG00020", shisan));

  // 負債・資本の部
  const fusai: XmlNode[] = [];
  // 期首
  const kishu_fusai: XmlNode[] = [];
  pushYen(kishu_fusai, "AMG00510", bs.shiharai_tegata_kishu);
  pushYen(kishu_fusai, "AMG00520", bs.kaikake_kishu);
  pushYen(kishu_fusai, "AMG00530", bs.kariirekin_kishu);
  pushYen(kishu_fusai, "AMG00540", bs.miharaikin_kishu);
  pushYen(kishu_fusai, "AMG00550", bs.maeuke_kishu);
  pushYen(kishu_fusai, "AMG00560", bs.azukari_kishu);
  pushYen(kishu_fusai, "AMG00580", bs.kashidaore_hikiate_kishu);
  pushYen(kishu_fusai, "AMG00600", bs.motoire_kishu);
  if (bs.fusai_goukei_kishu != null)
    kishu_fusai.push(el("AMG00610", Math.round(bs.fusai_goukei_kishu)));
  if (kishu_fusai.length) fusai.push(elc("AMG00490", kishu_fusai));

  // 期末
  const kimatsu_fusai: XmlNode[] = [];
  pushYen(kimatsu_fusai, "AMG00640", bs.shiharai_tegata_kimatsu);
  pushYen(kimatsu_fusai, "AMG00650", bs.kaikake_kimatsu);
  pushYen(kimatsu_fusai, "AMG00660", bs.kariirekin_kimatsu);
  pushYen(kimatsu_fusai, "AMG00670", bs.miharaikin_kimatsu);
  pushYen(kimatsu_fusai, "AMG00680", bs.maeuke_kimatsu);
  pushYen(kimatsu_fusai, "AMG00690", bs.azukari_kimatsu);
  pushYen(kimatsu_fusai, "AMG00710", bs.kashidaore_hikiate_kimatsu);
  pushYen(kimatsu_fusai, "AMG00730", bs.jigyonushi_kari_kimatsu);
  pushYen(kimatsu_fusai, "AMG00740", bs.motoire_kimatsu);
  pushYen(kimatsu_fusai, "AMG00750", bs.aoiro_mae_shotoku_kimatsu);
  if (bs.fusai_goukei_kimatsu != null)
    kimatsu_fusai.push(el("AMG00760", Math.round(bs.fusai_goukei_kimatsu)));
  if (kimatsu_fusai.length) fusai.push(elc("AMG00620", kimatsu_fusai));

  if (fusai.length) children.push(elc("AMG00450", fusai));

  return elc("KOA210-4", children.length ? [elc("AMG00000", children)] : [], {
    page: 1,
  });
}

/**
 * KOA210 (青色申告決算書) の帳票個別部分 1 つ分を返す。
 * RKO0010 (所得税申告) XTX に組み込む用。
 */
export function buildKOA210Part(
  ctx: EtaxContext,
  data: BlueReturnData
): XmlNode {
  const version = EMBEDDED_FORM_VERSIONS.KOA210;
  return elc(
    "KOA210",
    [
      buildPage1(ctx, data),
      buildPage2(ctx, data),
      buildPage3(ctx, data),
      buildPage4(ctx, data),
    ],
    formAttrs(ctx, version, "KOA210", 1)
  );
}
