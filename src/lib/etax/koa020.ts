/**
 * 確定申告書 (KOA020) 第一表・第二表 - 令和7年分 (v23.0) の帳票個別部分を生成。
 *
 * スキーマ: specs/etax/e-tax19/19XMLスキーマ/shotoku/KOA020-023.xsd
 *
 * 注意: KOA020 は XTX のルートではなく、RKO0010 (所得税申告) 手続内の
 * 帳票個別部分として出現する。このファイルは XTX 全体を作らず
 * 「KOA020 ルート要素 (帳票個別部分)」のみを返す。
 */

import type { EtaxContext, WarekiDate } from "./types";
import {
  EMBEDDED_FORM_VERSIONS,
  buildSoftNM,
  yearToWareki,
} from "./codes";
import { type XmlNode, el, elc, ref } from "./xml-builder";

// ──────────────────────────────────────────────────────────
// 第二表 用のサブ構造
// ──────────────────────────────────────────────────────────

/**
 * 所得の内訳 (ABD00010 繰り返し)。給与所得者は支払者ごと、
 * 雑所得 (業務・その他) も支払者ごとに明細行を作る。
 */
export interface IncomeBreakdownItem {
  kind: string; // 所得の種類 (例: "給与", "雑(業務)", "配当")
  shumoku?: string; // 種目 (例: "給料", "賞与", "報酬")
  payer_name: string; // 支払者の名称
  payer_identifier?: string; // 法人番号または所在地
  income: number; // 収入金額
  withholding: number; // 源泉徴収税額
}

/**
 * 社会保険料の内訳 (ABH00120 繰り返し)
 */
export interface ShakaiHokenMeisai {
  kind: string; // "国民健康保険", "国民年金", "国民年金基金" など
  amount: number; // 支払保険料額
  excl_yearend_adjust?: number; // うち年末調整等以外
}

/**
 * 配偶者情報 (ABY00010)
 */
export interface HaigushaInfo {
  name: string;
  mynumber?: string; // 個人番号 12桁
  birthday: WarekiDate;
  shogaisha?: boolean; // 障害者
  tokubetsu_shogaisha?: boolean; // 特別障害者
  kokugai_kyoju?: boolean; // 国外居住
  douikyo?: boolean; // 同居
}

/**
 * 扶養親族 (ABY00150 繰り返し)
 */
export interface FuyoShinzokuInfo {
  name: string;
  mynumber?: string;
  zokugara: string; // 続柄 (子、父、母 など)
  birthday: WarekiDate;
  shogaisha?: boolean;
  tokubetsu_shogaisha?: boolean;
  kokugai_kyoju?: boolean;
  douikyo?: boolean;
}

/**
 * 事業専従者 (ABE00010 繰り返し)
 */
export interface SenjushaInfo {
  name: string;
  mynumber?: string;
  zokugara: string;
  birthday: WarekiDate;
  jiyu_jokyo?: string; // 従事月数・程度・仕事の内容
  kyuyo: number; // 専従者給与(控除)額
}

/**
 * 確定申告書の入力データ (金額は円単位整数)。
 */
export interface IncomeReturnData {
  shinkoku_shurui: "青色" | "白色" | "修正" | "分離" | "損失";
  shinkoku_kbn_cd?: string;

  // 収入金額等
  eigyo_income?: number;
  nogyo_income?: number;
  fudosan_income?: number;
  rishi_income?: number;
  haito_income?: number;
  kyuyo_income?: number;
  koteki_nenkin?: number;
  gyomu_zatsu?: number;
  sonota_zatsu?: number;
  soku_jouto_tanki?: number;
  soku_jouto_choki?: number;
  ichiji?: number;

  // 所得金額等
  eigyo_shotoku?: number;
  nogyo_shotoku?: number;
  fudosan_shotoku?: number;
  rishi_shotoku?: number;
  haito_shotoku?: number;
  kyuyo_shotoku?: number;
  zatsu_shotoku?: number;
  soku_jouto_ichiji?: number;
  goukei_shotoku?: number;

  // 所得控除
  zason_kojo?: number;
  iryo_kojo?: number;
  shakaihoken_kojo?: number;
  shokibo_kojo?: number;
  seimei_kojo?: number;
  jishin_kojo?: number;
  kifu_kojo?: number;
  kafu_hitori_kojo?: number;
  kinro_shogai_kojo?: number;
  haigu_kojo?: number;
  fuyou_kojo?: number;
  kiso_kojo: number;
  kojo_goukei?: number;

  // 税金の計算
  kazei_shotoku: number;
  shotokuzei: number;
  haito_zeigaku_kojo?: number;
  jutaku_kojo?: number;
  sashihiki_shotokuzei?: number;
  saisashihiki_shotokuzei?: number;
  fukkou_tokubetsu?: number;
  shotokuzei_no_gaku?: number;
  gensen_choshu?: number;
  shinkoku_nouzei?: number;
  yotei_nouzei?: number;
  dai3ki_zeigaku?: number;
  osameru_zeikin?: number;
  kanpu_zeikin?: number;

  // その他
  senjusha_kyuyo?: number;
  aoiro_tokubetsu_kojo?: number;
  zatsu_gensen?: number;

  // 還付先口座
  kanpu_ginko?: string;
  kanpu_shiten?: string;
  kanpu_yokin_shubetsu?: "普通" | "当座" | "納税準備";
  kanpu_koza_bango?: string;

  // ──── 第二表 拡張 ────
  /** 所得の内訳 (ABD): 給与/雑所得の源泉徴収明細 */
  income_details?: IncomeBreakdownItem[];
  /** 社会保険料の内訳 (ABH00110/00120) */
  shakaihoken_meisai?: ShakaiHokenMeisai[];
  /** 配偶者情報 (ABY00010) */
  haigusha?: HaigushaInfo;
  /** 扶養親族 (ABY00150 繰り返し) */
  fuyo_shinzoku?: FuyoShinzokuInfo[];
  /** 事業専従者 (ABE00010 繰り返し) */
  senjusha?: SenjushaInfo[];
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
    id,
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

function buildKOA020_1(ctx: EtaxContext, d: IncomeReturnData): XmlNode {
  const wy = yearToWareki(ctx.fiscalYear);

  const header: XmlNode = elc("ABA00000", [
    elc("ABA00010", [el("era", wy.era), el("yy", wy.yy)]),
    elc("ABA00020", [
      el("kubun_CD", d.shinkoku_kbn_cd || "1"),
      el("kubun_NM", d.shinkoku_shurui),
    ]),
    ref("ABA00030", "ZEIMUSHO"),
    ref("ABA00040", "TEISYUTSU_DAY"),
    elc("ABA00050", [
      ref("ABA00080", "NOZEISHA_ZIP"),
      ref("ABA00090", "NOZEISHA_ADR"),
      ref("ABA00130", "NOZEISHA_NM_KN"),
      ref("ABA00140", "NOZEISHA_NM"),
      ...(ctx.taxpayer.shokugyo ? [ref("ABA00160", "SHOKUGYO")] : []),
      ...(ctx.taxpayer.yago ? [ref("ABA00170", "NOZEISHA_YAGO")] : []),
    ]),
  ]);

  const contents: XmlNode[] = [];

  // 収入金額等
  const incomes = [
    yenEl("ABB00030", d.eigyo_income),
    yenEl("ABB00040", d.nogyo_income),
    yenEl("ABB00050", d.fudosan_income),
    yenEl("ABB00070", d.haito_income),
    yenEl("ABB00080", d.kyuyo_income),
    yenEl("ABB00100", d.koteki_nenkin),
    yenEl("ABB00105", d.gyomu_zatsu),
    yenEl("ABB00110", d.sonota_zatsu),
    yenEl("ABB00130", d.soku_jouto_tanki),
    yenEl("ABB00180", d.soku_jouto_choki),
    yenEl("ABB00230", d.ichiji),
  ].filter((x): x is XmlNode => !!x);
  if (incomes.length) contents.push(elc("ABB00010", incomes));

  // 所得金額等
  const shotoku = [
    yenEl("ABB00300", d.eigyo_shotoku),
    yenEl("ABB00320", d.nogyo_shotoku),
    yenEl("ABB00340", d.fudosan_shotoku),
    yenEl("ABB00350", d.rishi_shotoku),
    yenEl("ABB00360", d.haito_shotoku),
    yenEl("ABB00370", d.kyuyo_shotoku),
    yenEl("ABB01130", d.zatsu_shotoku),
    yenEl("ABB00400", d.soku_jouto_ichiji),
    yenEl("ABB00410", d.goukei_shotoku),
  ].filter((x): x is XmlNode => !!x);
  if (shotoku.length) contents.push(elc("ABB00270", shotoku));

  // 所得控除
  const kojo = [
    yenEl("ABB00430", d.zason_kojo),
    yenEl("ABB00440", d.iryo_kojo),
    yenEl("ABB00450", d.shakaihoken_kojo),
    yenEl("ABB00460", d.shokibo_kojo),
    yenEl("ABB00470", d.seimei_kojo),
    yenEl("ABB00480", d.jishin_kojo),
    yenEl("ABB00490", d.kifu_kojo),
    yenEl("ABB00500", d.kafu_hitori_kojo),
    yenEl("ABB00510", d.kinro_shogai_kojo),
    yenEl("ABB00520", d.haigu_kojo),
    yenEl("ABB00540", d.fuyou_kojo),
    yenEl("ABB00550", d.kiso_kojo),
    yenEl("ABB00560", d.kojo_goukei),
  ].filter((x): x is XmlNode => !!x);
  if (kojo.length) contents.push(elc("ABB00420", kojo));

  // 税金の計算
  const zeikin = [
    yenEl("ABB00580", d.kazei_shotoku),
    yenEl("ABB00590", d.shotokuzei),
    yenEl("ABB00600", d.haito_zeigaku_kojo),
    yenEl("ABB00650", d.jutaku_kojo),
    yenEl("ABB00670", d.sashihiki_shotokuzei),
    yenEl("ABB01010", d.saisashihiki_shotokuzei),
    yenEl("ABB01020", d.fukkou_tokubetsu),
    yenEl("ABB01030", d.shotokuzei_no_gaku),
    yenEl("ABB00710", d.gensen_choshu),
    yenEl("ABB00720", d.shinkoku_nouzei),
    yenEl("ABB00730", d.yotei_nouzei),
    yenEl("ABB00740", d.dai3ki_zeigaku),
    yenEl("ABB00750", d.osameru_zeikin),
    yenEl("ABB00760", d.kanpu_zeikin),
  ].filter((x): x is XmlNode => !!x);
  if (zeikin.length) contents.push(elc("ABB00570", zeikin));

  // その他
  const sonota = [
    yenEl("ABB00790", d.senjusha_kyuyo),
    yenEl("ABB00800", d.aoiro_tokubetsu_kojo),
    yenEl("ABB00810", d.zatsu_gensen),
  ].filter((x): x is XmlNode => !!x);
  if (sonota.length) contents.push(elc("ABB00770", sonota));

  return elc("KOA020-1", [header, elc("ABB00000", contents)], { page: 1 });
}

/**
 * 和暦ヘルパー: era/yy/mm/dd 子要素化。
 */
function warekiChildren(w: WarekiDate): XmlNode[] {
  return [
    el("era", w.era),
    el("yy", w.yy),
    el("mm", w.mm),
    el("dd", w.dd),
  ];
}

/**
 * ABD (所得の内訳) セクションを生成。
 */
function buildABD(details: IncomeBreakdownItem[]): XmlNode {
  const children: XmlNode[] = [];
  let totalWithholding = 0;
  for (const item of details) {
    totalWithholding += item.withholding;
    const row: XmlNode[] = [
      el("ABD00020", item.kind),
      ...(item.shumoku ? [el("ABD00025", item.shumoku)] : []),
      ...(item.payer_identifier
        ? [el("ABD00030", item.payer_identifier)]
        : []),
      el("ABD00040", item.payer_name),
      el("ABD00050", Math.round(item.income)),
      el("ABD00060", Math.round(item.withholding)),
    ];
    children.push(elc("ABD00010", row));
  }
  // 源泉徴収税額の合計
  children.push(el("ABD00070", totalWithholding));
  return elc("ABD00000", children);
}

/**
 * ABH (明細) - 社会保険料・生命保険料等の内訳。
 * 最小版として ABH00110 (社保) のみ構造化。生命保険等は未対応。
 */
function buildABH(d: IncomeReturnData): XmlNode | undefined {
  const children: XmlNode[] = [];

  if (d.shakaihoken_meisai && d.shakaihoken_meisai.length > 0) {
    const rows: XmlNode[] = [];
    for (const item of d.shakaihoken_meisai) {
      const row: XmlNode[] = [
        el("ABH00130", item.kind),
        el("ABH00140", Math.round(item.amount)),
        ...(item.excl_yearend_adjust != null
          ? [el("ABH00580", Math.round(item.excl_yearend_adjust))]
          : []),
      ];
      rows.push(elc("ABH00120", row));
    }
    children.push(elc("ABH00110", rows));
  }

  if (!children.length) return undefined;
  return elc("ABH00000", children);
}

/**
 * ABY (配偶者・扶養親族) を生成。
 */
function buildABY(d: IncomeReturnData): XmlNode | undefined {
  const children: XmlNode[] = [];

  // 配偶者 ABY00010
  if (d.haigusha) {
    const h = d.haigusha;
    const row: XmlNode[] = [
      el("ABY00020", h.name),
      ...(h.mynumber ? [el("ABY00030", h.mynumber)] : []),
      elc("ABY00040", warekiChildren(h.birthday)),
    ];
    if (h.shogaisha) row.push(el("ABY00060", "1"));
    if (h.tokubetsu_shogaisha) row.push(el("ABY00070", "1"));
    if (h.kokugai_kyoju) row.push(el("ABY00090", "1"));
    if (h.douikyo) row.push(el("ABY00120", "1"));
    children.push(elc("ABY00010", row));
  }

  // 扶養親族 ABY00150 (繰り返し)
  if (d.fuyo_shinzoku) {
    for (const f of d.fuyo_shinzoku) {
      const row: XmlNode[] = [
        el("ABY00160", f.name),
        ...(f.mynumber ? [el("ABY00170", f.mynumber)] : []),
        el("ABY00180", f.zokugara),
        elc("ABY00190", warekiChildren(f.birthday)),
      ];
      children.push(elc("ABY00150", row));
    }
  }

  if (!children.length) return undefined;
  return elc("ABY00000", children);
}

/**
 * ABE (事業専従者) を生成。
 */
function buildABE(d: IncomeReturnData): XmlNode | undefined {
  if (!d.senjusha || d.senjusha.length === 0) return undefined;
  const rows: XmlNode[] = [];
  for (const s of d.senjusha) {
    const row: XmlNode[] = [
      el("ABE00020", s.name),
      ...(s.mynumber ? [el("ABE00025", s.mynumber)] : []),
      elc("ABE00030", warekiChildren(s.birthday)),
      el("ABE00040", s.zokugara),
      ...(s.jiyu_jokyo ? [el("ABE00060", s.jiyu_jokyo)] : []),
      el("ABE00070", Math.round(s.kyuyo)),
    ];
    rows.push(elc("ABE00010", row));
  }
  return elc("ABE00000", rows);
}

function buildKOA020_2(ctx: EtaxContext, d: IncomeReturnData): XmlNode {
  const wy = yearToWareki(ctx.fiscalYear);
  const header: XmlNode = elc("ABC00000", [
    elc("ABC00010", [el("era", wy.era), el("yy", wy.yy)]),
    ref("ABC00030", "ZEIMUSHO"),
    ref("ABC00040", "TEISYUTSU_DAY"),
    ref("ABC00070", "NOZEISHA_NM"),
  ]);

  const sections: XmlNode[] = [header];

  if (d.income_details && d.income_details.length > 0) {
    sections.push(buildABD(d.income_details));
  }
  const senjusha = buildABE(d);
  if (senjusha) sections.push(senjusha);
  const meisai = buildABH(d);
  if (meisai) sections.push(meisai);
  const haigu = buildABY(d);
  if (haigu) sections.push(haigu);

  return elc("KOA020-2", sections, { page: 1 });
}

/**
 * KOA020 (申告書) の帳票個別部分 1 つ分を返す。
 * RKO0010 (所得税申告) XTX に組み込む用。
 */
export function buildKOA020Part(
  ctx: EtaxContext,
  data: IncomeReturnData
): XmlNode {
  const version = EMBEDDED_FORM_VERSIONS.KOA020;
  return elc(
    "KOA020",
    [buildKOA020_1(ctx, data), buildKOA020_2(ctx, data)],
    formAttrs(ctx, version, "KOA020", 1)
  );
}
