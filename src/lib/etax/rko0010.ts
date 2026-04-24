/**
 * 所得税及び復興特別所得税申告 (RKO0010) - 令和7年分 (v25.0.0) の XTX 全体を生成。
 *
 * スキーマ: specs/etax/e-tax19/19XMLスキーマ/shotoku/RKO0010-250.xsd
 *
 * この手続 ID の中に KOA020 (申告書)、KOA210 (青色申告決算書) 等が
 * 帳票個別部分として兄弟要素で格納される。
 *
 * XTX 構造:
 *   <DATA id="DATA">
 *     <RKO0010 VR="25.0.0" id="RKO0010">
 *       <CATALOG>...</CATALOG>
 *       <CONTENTS>
 *         <IT>...</IT>
 *         <KOA020 VR="23.0" ...>...</KOA020>  ← 申告書 (必須)
 *         <KOA210 VR="11.0" ...>...</KOA210>  ← 青色決算書 (任意)
 *       </CONTENTS>
 *     </RKO0010>
 *   </DATA>
 */

import type { EtaxContext, XtxDocument } from "./types";
import {
  PROCEDURE_CODES,
  FORM_VERSIONS,
  NAMESPACES,
  buildXtxFileName,
} from "./codes";
import { wrapInEnvelope } from "./envelope";
import { buildItSection } from "./it-section";
import {
  type IncomeReturnData,
  buildKOA020Part,
} from "./koa020";
import {
  type BlueReturnData,
  buildKOA210Part,
} from "./koa210";

/**
 * 所得税申告 (確定申告) データ。青色申告決算書 (blue) は任意 (任意で組み込める)。
 */
export interface ShotokuShinkokuData {
  /** 確定申告書 (必須) */
  income: IncomeReturnData;
  /** 青色申告決算書 (青色申告者のみ) */
  blue?: BlueReturnData;
}

/**
 * 所得税申告 XTX を組み立てる。
 */
export function buildShotokuShinkokuXtx(
  ctx: EtaxContext,
  data: ShotokuShinkokuData
): XtxDocument {
  const procedureCode = PROCEDURE_CODES.SHOTOKU_SHINKOKU;
  const version = FORM_VERSIONS[procedureCode];

  const itSection = buildItSection(ctx);

  const formParts = [buildKOA020Part(ctx, data.income)];
  if (data.blue) {
    formParts.push(buildKOA210Part(ctx, data.blue));
  }

  const xml = wrapInEnvelope({
    procedureCode,
    version,
    namespace: NAMESPACES.shotoku,
    ctx,
    itSection,
    formParts,
  });

  return {
    procedureCode,
    version,
    suggestedFileName: buildXtxFileName(procedureCode, ctx.fiscalYear, ctx.sakuseiDay),
    xml,
  };
}
