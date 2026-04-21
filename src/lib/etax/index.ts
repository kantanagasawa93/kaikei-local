/**
 * e-Tax モジュール公開API。
 *
 * 呼び出し側は `@/lib/etax` から関数・型を import する。
 */

export * from "./types";
export * from "./codes";
export {
  escapeXml,
  renderDocument,
  renderNode,
  el,
  elc,
  ref,
  empty,
  type XmlNode,
  type Attrs,
} from "./xml-builder";
export { buildCatalog, buildProcedureRoot, buildXtx, wrapInEnvelope } from "./envelope";
export { buildItSection } from "./it-section";
export { validateTaxpayer, splitErrors } from "./validator";
export { loadTaxpayerInfo, saveTaxpayerInfo, emptyTaxpayerInfo } from "./storage";
export { buildEtaxConfirmationPdf, type EtaxPdfInput } from "./pdf";
export {
  taxReturnToIncomeReturnData,
  aggregateBlueReturnData,
  buildConsumptionTaxStandardFromAggregate,
  buildConsumptionTaxSimplifiedFromAggregate,
  withholdingSlipsToIncomeDetails,
  fixedAssetsToDepreciationItems,
  aggregateBalanceSheet,
  type JournalLike,
  type JournalLineLike,
} from "./mapping";

// 所得税申告 (RKO0010) - 申告書 + 青色決算書を含む
export {
  type ShotokuShinkokuData,
  buildShotokuShinkokuXtx,
} from "./rko0010";

// サブ帳票の型定義も公開する
export {
  type IncomeReturnData,
  type IncomeBreakdownItem,
  type ShakaiHokenMeisai,
  type HaigushaInfo,
  type FuyoShinzokuInfo,
  type SenjushaInfo,
  buildKOA020Part,
} from "./koa020";
export {
  type BlueReturnData,
  type MonthlyAmount,
  type BalanceSheetData,
  type DepreciationItem,
  buildKOA210Part,
} from "./koa210";

// 消費税申告 (独立した XTX)
export {
  type ConsumptionTaxStandardData,
  buildConsumptionTaxStandardXtx,
} from "./rsh0010";
export {
  type ConsumptionTaxSimplifiedData,
  type MinashiJigyoKubun,
  buildConsumptionTaxSimplifiedXtx,
} from "./rsh0030";
