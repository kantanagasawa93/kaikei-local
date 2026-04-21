/**
 * 軽量 XML ビルダー。国税庁 e-Tax XTX (XML) 生成用。
 *
 * XTX の特徴:
 *   - UTF-8 固定、ルートは <DATA>
 *   - 要素名にタガログ文字・全角は含まれず、ASCII のみ
 *   - `IDREF` 属性や `id` 属性での参照が使われる
 *   - 空要素は自閉じタグ (`<X/>`) を使う
 *   - 数値要素は整数または小数（円単位の金額は整数）
 *
 * 依存を追加したくないため、標準の文字列連結で十分機能する最小実装。
 * xmlbuilder2 等は入れない。
 */

/**
 * XML テキスト用の最小限エスケープ。
 * e-Tax は入力文字集合として JIS X 0208 の範囲を期待するが、
 * この層では XML メタ文字のみ対処する。上位層で文字集合正規化を行う。
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 属性値用のエスケープ。escapeXml と同じだが、
 * 意図を明示するための別名。
 */
export function escapeAttr(s: string): string {
  return escapeXml(s);
}

export type AttrValue = string | number | boolean | undefined | null;
export type Attrs = Record<string, AttrValue>;

/**
 * 属性を `name="value"` 形式の文字列に直列化。
 * value が undefined / null / false の場合はスキップ。
 * 順序は呼び出し側での挿入順を保つ。
 */
export function renderAttrs(attrs?: Attrs): string {
  if (!attrs) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    const s = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
    parts.push(`${k}="${escapeAttr(s)}"`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

export interface XmlNode {
  tag: string;
  attrs?: Attrs;
  /** 子要素。文字列は PCDATA としてエスケープされる。null/undefined/false はスキップ。 */
  children?: Array<XmlNode | string | number | null | undefined | false>;
  /** true のとき子を無視して PCDATA のみ。内部で text を使う場合に使用。 */
  text?: string | number;
  /** 空要素でも自閉じにせず開閉タグを出したい場合 true（XTX では基本不要） */
  forceOpenClose?: boolean;
}

/**
 * XML ノードを文字列に再帰レンダリング。
 * インデントは付けない（XTX ではバイト差が署名に影響するため改行のみ）。
 */
export function renderNode(node: XmlNode): string {
  const attrs = renderAttrs(node.attrs);
  // text が優先
  if (node.text !== undefined && node.text !== null) {
    const t = typeof node.text === "number" ? String(node.text) : escapeXml(node.text);
    return `<${node.tag}${attrs}>${t}</${node.tag}>`;
  }
  const kids = (node.children || []).filter(
    (c) => c !== null && c !== undefined && c !== false
  );
  if (kids.length === 0 && !node.forceOpenClose) {
    return `<${node.tag}${attrs}/>`;
  }
  const inner = kids
    .map((c) => {
      if (typeof c === "string") return escapeXml(c);
      if (typeof c === "number") return String(c);
      return renderNode(c as XmlNode);
    })
    .join("");
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/**
 * XML ドキュメントを文字列に直列化。
 * XTX は宣言必須: <?xml version="1.0" encoding="UTF-8"?>
 */
export function renderDocument(root: XmlNode): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + renderNode(root);
}

/**
 * 便利関数: タグと text で要素を作る。
 */
export function el(tag: string, text: string | number, attrs?: Attrs): XmlNode {
  return { tag, attrs, text };
}

/**
 * 便利関数: タグと子要素で要素を作る。
 */
export function elc(
  tag: string,
  children: Array<XmlNode | string | number | null | undefined | false>,
  attrs?: Attrs
): XmlNode {
  return { tag, attrs, children };
}

/**
 * 便利関数: IDREF 属性だけで子を持たない参照要素。
 *   <AAA00130 IDREF="NOZEISHA_NM"/>
 */
export function ref(tag: string, idref: string): XmlNode {
  return { tag, attrs: { IDREF: idref } };
}

/**
 * 便利関数: 空要素 (省略可能な項目を明示的に出したい時)。
 */
export function empty(tag: string, attrs?: Attrs): XmlNode {
  return { tag, attrs };
}
