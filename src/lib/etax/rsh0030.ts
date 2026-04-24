/**
 * 消費税及び地方消費税申告書 (簡易課税・個人) RSH0030 - 令和7年分 (最新 v23.2.0)
 *
 * スキーマ: specs/etax/e-tax19/19XMLスキーマ/shohi/RSH0030-232.xsd
 *
 * 構造は RSH0010 と類似。簡易課税は仕入税額を「みなし仕入率」で計算する。
 * 帳票 SHB015 を使う。
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
 * みなし仕入率の業種区分。
 *   1=卸売業(90%) / 2=小売業(80%) / 3=製造業(70%) /
 *   4=その他(60%) / 5=サービス業(50%) / 6=不動産業(40%)
 */
export type MinashiJigyoKubun = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * 消費税申告書 (簡易課税) の入力データ。
 */
export interface ConsumptionTaxSimplifiedData {
  kazei_from: string; // ISO
  kazei_to: string; // ISO

  jigyo_kubun: MinashiJigyoKubun;
  kazei_hyojun: number;
  shohizei: number;
  kojo_zeigaku: number; // 控除対象仕入税額 (みなし)
  sashihiki_zeigaku: number;
  chukan_nofu?: number;
  nofu_zeigaku: number;

  chihou_kazei_hyojun: number;
  jouto_wari_gaku: number;
  chukan_jouto_wari?: number;
  nofu_jouto_wari: number;
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

function isoToWarekiChildren(iso: string): XmlNode[] {
  const [y, m, d] = iso.split("-").map((s) => parseInt(s, 10));
  const wy = yearToWareki(y);
  return [el("era", wy.era), el("yy", wy.yy), el("mm", m), el("dd", d)];
}

function buildSHA010(
  ctx: EtaxContext,
  d: ConsumptionTaxSimplifiedData
): XmlNode {
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
 * SHB015 (簡易課税・税額計算)
 */
function buildSHB015(
  ctx: EtaxContext,
  d: ConsumptionTaxSimplifiedData
): XmlNode {
  const header: XmlNode = elc("BAA00000", [
    ref("BAA00010", "NOZEISHA_NM"),
  ]);

  const children: XmlNode[] = [header];
  children.push(elc("BAB00000", [el("BAB00010", Math.round(d.kazei_hyojun))]));
  children.push(elc("BAC00000", [el("BAC00010", Math.round(d.shohizei))]));
  children.push(elc("BAE00000", [el("BAE00010", Math.round(d.kojo_zeigaku))]));
  children.push(elc("BAG00000", [el("BAG00010", Math.round(d.sashihiki_zeigaku))]));
  children.push(
    elc("BAI00000", [el("BAI00010", Math.round(d.chihou_kazei_hyojun))])
  );

  return elc("SHB015", children, formAttrs(ctx, "5.0", "SHB015", 1));
}

export function buildConsumptionTaxSimplifiedXtx(
  ctx: EtaxContext,
  data: ConsumptionTaxSimplifiedData
): XtxDocument {
  const procedureCode = PROCEDURE_CODES.SHOHI_KOJIN_KANI;
  const version = FORM_VERSIONS[procedureCode];

  const sha010 = buildSHA010(ctx, data);
  const shb015 = buildSHB015(ctx, data);

  const itSection = buildItSection(ctx);

  const xml = wrapInEnvelope({
    procedureCode,
    version,
    namespace: NAMESPACES.shohi,
    ctx,
    itSection,
    formParts: [sha010, shb015],
  });

  return {
    procedureCode,
    version,
    suggestedFileName: buildXtxFileName(procedureCode, ctx.fiscalYear, ctx.sakuseiDay),
    xml,
  };
}
