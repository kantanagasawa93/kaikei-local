/**
 * IT 部 (納税者情報) を生成する。
 *
 * IT 部は全帳票共通で「納税者本人の氏名・住所・税務署・事業所情報」を保持し、
 * 帳票個別部分から IDREF で参照させる。
 *
 * 主な要素 (general/ITdefinition.xsd より):
 *   - ZEIMUSHO         税務署コード + 名称
 *   - NOZEISHA_NM      納税者氏名
 *   - NOZEISHA_NM_KN   納税者氏名フリガナ
 *   - NOZEISHA_ZIP     郵便番号
 *   - NOZEISHA_ADR     住所
 *   - NOZEISHA_TEL     電話番号
 *   - BIRTHDAY         生年月日 (和暦)
 *   - SHOKUGYO         職業
 *   - JIGYOSHO_*       事業所 (名称・住所・電話)
 *   - NOZEISHA_YAGO    屋号
 *
 * 令和7年分でも基本構造は変わらない想定。属性「VR="1.0"」。
 */

import type { EtaxContext, TaxpayerInfo, WarekiDate } from "./types";
import { type XmlNode, elc, el } from "./xml-builder";
import { isoToWareki } from "./codes";

/**
 * 和暦日付を era/yy/mm/dd 子要素にバラす。
 */
function warekiToChildren(w: WarekiDate): XmlNode[] {
  return [
    el("era", w.era),
    el("yy", w.yy),
    el("mm", w.mm),
    el("dd", w.dd),
  ];
}

/**
 * 郵便番号 "1234567" → "123-4567" 表記に (e-Tax はハイフン付きを期待するケースが多い)。
 * 必要に応じて後で形式チェックを入れる。
 */
function formatPostal(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.length === 7) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return p; // 非想定形式はそのまま通す (バリデータ側で検出)
}

/**
 * 電話番号を仕様に合わせて整形。e-Tax は半角数字 + ハイフンを受ける。
 * ここでは入力をほぼそのまま使うが、全角数字だけ半角化する。
 */
function sanitizePhone(p: string): string {
  return p
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^\d\-+()\s]/g, "");
}

/**
 * IT 部 (<IT VR="1.0" id="IT">...) を生成。
 */
export function buildItSection(ctx: EtaxContext): XmlNode {
  const t: TaxpayerInfo = ctx.taxpayer;

  const children: XmlNode[] = [];

  // 税務署
  children.push(
    elc(
      "ZEIMUSHO",
      [
        el("ZEIMUSHO_CD", t.zeimusho_cd),
        el("ZEIMUSHO_NM", t.zeimusho_nm),
      ],
      { id: "ZEIMUSHO" }
    )
  );

  // 提出年月日 (作成日を流用)
  children.push(
    elc("TEISYUTSU_DAY", warekiToChildren(isoToWareki(ctx.sakuseiDay)), {
      id: "TEISYUTSU_DAY",
    })
  );

  // 納税者氏名フリガナ
  children.push(el("NOZEISHA_NM_KN", t.name_kana, { id: "NOZEISHA_NM_KN" }));
  // 納税者氏名
  children.push(el("NOZEISHA_NM", t.name, { id: "NOZEISHA_NM" }));

  // 住所
  children.push(el("NOZEISHA_ZIP", formatPostal(t.postal_code), { id: "NOZEISHA_ZIP" }));
  children.push(el("NOZEISHA_ADR", t.address, { id: "NOZEISHA_ADR" }));
  children.push(el("NOZEISHA_TEL", sanitizePhone(t.phone), { id: "NOZEISHA_TEL" }));

  // 生年月日
  children.push(
    elc("BIRTHDAY", warekiToChildren(t.birthday_wareki), { id: "BIRTHDAY" })
  );

  // 職業
  if (t.shokugyo) {
    children.push(el("SHOKUGYO", t.shokugyo, { id: "SHOKUGYO" }));
  }

  // 事業内容 (職業の別要素)
  if (t.jigyo_naiyo) {
    children.push(el("JIGYO_NAIYO", t.jigyo_naiyo, { id: "JIGYO_NAIYO" }));
  }

  // 屋号
  if (t.yago) {
    children.push(el("NOZEISHA_YAGO", t.yago, { id: "NOZEISHA_YAGO" }));
  }

  // 事業所情報 (オプション)
  if (t.jigyosho_nm) {
    children.push(el("JIGYOSHO_NM", t.jigyosho_nm, { id: "JIGYOSHO_NM" }));
  }
  if (t.jigyosho_postal) {
    children.push(
      el("JIGYOSHO_ZIP", formatPostal(t.jigyosho_postal), { id: "JIGYOSHO_ZIP" })
    );
  }
  if (t.jigyosho_address) {
    children.push(el("JIGYOSHO_ADR", t.jigyosho_address, { id: "JIGYOSHO_ADR" }));
  }
  if (t.jigyosho_phone) {
    children.push(
      el("JIGYOSHO_TEL", sanitizePhone(t.jigyosho_phone), { id: "JIGYOSHO_TEL" })
    );
  }

  return elc("IT", children, { VR: "1.0", id: "IT" });
}
