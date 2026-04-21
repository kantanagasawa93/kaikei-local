/**
 * 消費税及び地方消費税申告書 (一般・個人) RSH0010 - 令和7年分 (最新 v23.2.0)
 *
 * スキーマ: specs/etax/e-tax19/19XMLスキーマ/shohi/RSH0010-232.xsd
 *
 * 構成:
 *   - SHA010: 納税者等部 (第一表・第二表)
 *   - SHB013: 第一表・税額計算 (CQ* フィールド)
 *   - SHB025: 第二表・課税売上割合等 (CR* フィールド)
 *   - SHE020〜100: 付表2-1/2-2等 (minOccurs=0)
 *
 * 最小実装:
 *   - SHA010: 納税者部・課税期間
 *   - SHB013: 課税標準額・消費税額・控除税額・差引税額
 *
 * 課税期間は申告対象の暦年 (1/1 - 12/31) を想定。事業年度が異なる場合は明示的に指定。
 */

import type { EtaxContext, XtxDocument } from "./types";
import {
  PROCEDURE_CODES,
  FORM_VERSIONS,
  NAMESPACES,
  buildSoftNM,
  buildXtxFileName,
  yearToWareki,
} from "./codes";
import { type XmlNode, el, elc, ref } from "./xml-builder";
import { wrapInEnvelope } from "./envelope";
import { buildItSection } from "./it-section";

/**
 * 消費税申告書 (原則課税) の入力データ。
 */
export interface ConsumptionTaxStandardData {
  /** 課税期間 (自) ISO YYYY-MM-DD */
  kazei_from: string;
  /** 課税期間 (至) ISO YYYY-MM-DD */
  kazei_to: string;

  /** 課税標準額 (税抜, 千円未満切り捨て) */
  kazei_hyojun: number;
  /** 消費税額 (= 課税標準 × 7.8%) */
  shohizei: number;
  /** 控除過大調整税額 */
  kojo_kadai_chosei?: number;
  /** 控除税額 (仕入税額控除等の合計) */
  kojo_zeigaku: number;
  /** 控除不足還付税額 */
  kojo_fusoku_kanpu?: number;
  /** 差引税額 */
  sashihiki_zeigaku: number;
  /** 中間納付税額 */
  chukan_nofu?: number;
  /** 納付税額 (= 差引 - 中間) */
  nofu_zeigaku: number;

  // ── 地方消費税 ──
  /** 地方消費税の課税標準となる消費税額 (= 差引税額) */
  chihou_kazei_hyojun: number;
  /** 譲渡割額 (地方消費税, = 課税標準 × 22/78) */
  jouto_wari_gaku: number;
  /** 中間納付譲渡割額 */
  chukan_jouto_wari?: number;
  /** 納付譲渡割額 */
  nofu_jouto_wari: number;

  /** 消費税 + 地方消費税の合計納付額 */
  total_nofu: number;
}

function formAttrs(
  ctx: EtaxContext,
  version: string,
  id: string,
  page: number
): Record<string, string | number> {
  return {
    VR: version,
    id: `${id}-${page}`,
    page,
    sakuseiDay: ctx.sakuseiDay,
    sakuseiNM: buildSoftNM(ctx.softName, ctx.vendorName),
    softNM: buildSoftNM(ctx.softName, ctx.vendorName),
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

/**
 * SHA010 (納税者等部・第一表).
 * 最小版では納税者情報と課税期間のみ。
 */
function buildSHA010(ctx: EtaxContext, d: ConsumptionTaxStandardData): XmlNode {
  const header: XmlNode = elc("AAI00000", [
    ref("AAI00010", "TEISYUTSU_DAY"),
    ref("AAI00020", "ZEIMUSHO"),
    ref("AAI00030", "NOZEISHA_ADR"),
    ref("AAI00040", "NOZEISHA_TEL"),
    ref("AAI00070", "NOZEISHA_NM"),
    elc("AAI00120", [
      elc("AAI00130", isoToWarekiChildren(d.kazei_from)),
      elc("AAI00140", isoToWarekiChildren(d.kazei_to)),
    ]),
  ]);

  return elc(
    "SHA010",
    [elc("SHA010-1", [header], { page: 1 })],
    formAttrs(ctx, "10.0", "SHA010", 1)
  );
}

/**
 * SHB013 (第一表・税額計算).
 */
function buildSHB013(ctx: EtaxContext, d: ConsumptionTaxStandardData): XmlNode {
  const header: XmlNode = elc("CQA00000", [
    ref("CQA00010", "NOZEISHA_NM"),
  ]);

  const children: XmlNode[] = [header];

  // 課税標準額 (CQB00000)
  children.push(elc("CQB00000", [el("CQB00010", Math.round(d.kazei_hyojun))]));

  // 消費税額 (CQD00000)
  children.push(elc("CQD00000", [el("CQD00010", Math.round(d.shohizei))]));

  // 控除過大調整 (CQE00000)
  if (d.kojo_kadai_chosei != null) {
    children.push(elc("CQE00000", [el("CQE00010", Math.round(d.kojo_kadai_chosei))]));
  }

  // 控除税額 (CQF00000)
  children.push(elc("CQF00000", [el("CQF00010", Math.round(d.kojo_zeigaku))]));

  // 控除不足還付税額 (CQG00000)
  if (d.kojo_fusoku_kanpu != null) {
    children.push(elc("CQG00000", [el("CQG00010", Math.round(d.kojo_fusoku_kanpu))]));
  }

  // 差引税額 (CQH00000)
  children.push(elc("CQH00000", [el("CQH00010", Math.round(d.sashihiki_zeigaku))]));

  // 合計差引税額 (CQI00000)
  children.push(elc("CQI00000", [el("CQI00010", Math.round(d.nofu_zeigaku))]));

  // 地方消費税の課税標準 (CQJ00000)
  children.push(elc("CQJ00000", [el("CQJ00010", Math.round(d.chihou_kazei_hyojun))]));

  return elc("SHB013", children, formAttrs(ctx, "3.0", "SHB013", 1));
}

/**
 * 消費税申告書 (原則課税) の XTX を組み立てる。
 */
export function buildConsumptionTaxStandardXtx(
  ctx: EtaxContext,
  data: ConsumptionTaxStandardData
): XtxDocument {
  const procedureCode = PROCEDURE_CODES.SHOHI_KOJIN_IPPAN;
  const version = FORM_VERSIONS[procedureCode];

  const sha010 = buildSHA010(ctx, data);
  const shb013 = buildSHB013(ctx, data);

  const itSection = buildItSection(ctx);

  const xml = wrapInEnvelope({
    procedureCode,
    version,
    namespace: NAMESPACES.shohi,
    ctx,
    itSection,
    formParts: [sha010, shb013],
  });

  return {
    procedureCode,
    version,
    suggestedFileName: buildXtxFileName(procedureCode, ctx.fiscalYear, ctx.sakuseiDay),
    xml,
  };
}
