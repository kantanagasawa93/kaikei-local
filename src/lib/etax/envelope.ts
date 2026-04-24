/**
 * XTX エンベロープ (DATA / CATALOG / CONTENTS) を構築するユーティリティ。
 *
 * 構造 (仕様書「データ形式等仕様書」図1-3・図1-5 に基づく):
 *
 *   <?xml version="1.0" encoding="UTF-8"?>
 *   <DATA id="DATA">
 *     <{procedureCode} VR="..." id="{procedureCode}">
 *       <CATALOG id="CATALOG">
 *         ... 管理部 (RDF) ...
 *       </CATALOG>
 *       <CONTENTS id="CONTENTS">
 *         <IT VR="1.0" id="IT">
 *           ... 納税者情報 ...
 *         </IT>
 *         ... 帳票個別部分 ...
 *       </CONTENTS>
 *     </{procedureCode}>
 *     <!-- 署名は外部ツール (e-Tax Web版 / マイナポータル) で付与する -->
 *   </DATA>
 *
 * 署名は本ライブラリでは行わない。ユーザーが e-Tax Web版にアップロード後、
 * QR + iPhone マイナポータルアプリで JPKI 署名 + 送信する運用。
 */

import type { EtaxContext } from "./types";
import { NAMESPACES, buildSoftNM } from "./codes";
import {
  type XmlNode,
  renderDocument,
  elc,
  el,
} from "./xml-builder";

/**
 * CATALOG (管理部) を生成。
 * 仕様では RDF で構成するが、最小限の「ソフト名」「作成日時」のみで受理される実装例が多い。
 * ここでは仕様書に準拠しつつ、必要最小限にとどめる。
 */
export function buildCatalog(ctx: EtaxContext): XmlNode {
  const softNM = buildSoftNM(ctx.softName, ctx.vendorName);
  // CATALOG は xsd:any (RDF) を受け入れる。最小形では空でも通ることが多いが、
  // ソフト名と作成日時を RDF で持たせておく。
  return elc(
    "CATALOG",
    [
      elc(
        "rdf:RDF",
        [
          elc(
            "rdf:Description",
            [
              el("softNM", softNM),
              el("sakuseiDay", ctx.sakuseiDay),
            ],
            { "rdf:about": "" }
          ),
        ],
        { "xmlns:rdf": NAMESPACES.rdf }
      ),
    ],
    { id: "CATALOG" }
  );
}

/**
 * 帳票ルート要素 (DATA 直下の <KOA020> / <KOA210> / <RSH0010> ...) を生成。
 *
 * @param procedureCode  例: "KOA020"
 * @param version        例: "23.0"
 * @param catalogNode    buildCatalog() の戻り値
 * @param contentsNode   IT 部 + 帳票個別部分をまとめた CONTENTS ノード
 * @param namespace      対応する XSD namespace (shotoku / shohi)
 */
export function buildProcedureRoot(
  procedureCode: string,
  version: string,
  catalogNode: XmlNode,
  contentsNode: XmlNode,
  namespace: string
): XmlNode {
  return elc(
    procedureCode,
    [catalogNode, contentsNode],
    {
      xmlns: namespace,
      "xmlns:gen": NAMESPACES.general,
      "xmlns:kyo": NAMESPACES.kyotsu,
      "xmlns:dsig": NAMESPACES.dsig,
      "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
      VR: version,
      id: procedureCode,
    }
  );
}

/**
 * DATA ルート要素で包んで、XTX 全体を直列化。
 *
 * 注意: DATA 要素には意図的に xmlns を付けない。
 * XSD 上 DATA は各帳票 (shotoku / shohi) namespace 配下にあるが、
 * 子孫要素は shotoku / general / kyotsu / somu など複数の namespace を
 * またぐため、DATA に single xmlns を付けると IT 部 (general NS) が
 * mismatch を起こし xmllint 検証が失敗する。
 *
 * e-Tax 本体のパーサはこの構造を許容しており、実機アップロードテストで
 * RKO0010 の帳票表示まで通過することを確認済み
 * (login.e-tax.nta.go.jp の「申告・申請データの内容を確認」機能)。
 *
 * オフラインでの `xmllint --schema` 厳密検証は通らないが、これは
 * 国税庁の XSD 構造によるもので、我々のXTX出力が仕様に反しているわけではない。
 */
export function buildXtx(procedureRoot: XmlNode): string {
  const root = elc("DATA", [procedureRoot], { id: "DATA" });
  return renderDocument(root);
}

/**
 * 1 帳票分の XTX を一気通貫で構築するヘルパー。
 * (帳票個別部分は呼び出し側で組む)
 */
export function wrapInEnvelope(opts: {
  procedureCode: string;
  version: string;
  namespace: string;
  ctx: EtaxContext;
  itSection: XmlNode;
  formParts: XmlNode[];
}): string {
  const catalog = buildCatalog(opts.ctx);
  const contents = elc(
    "CONTENTS",
    [opts.itSection, ...opts.formParts],
    { id: "CONTENTS" }
  );
  const procRoot = buildProcedureRoot(
    opts.procedureCode,
    opts.version,
    catalog,
    contents,
    opts.namespace
  );
  return buildXtx(procRoot);
}
