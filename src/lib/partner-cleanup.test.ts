import { describe, it, expect } from "vitest";
import {
  detectPartnerVariants,
  normalizePartnerName,
  variantPairKey,
} from "@/lib/partner-cleanup";

function detect(names: string[]) {
  const partners = names.map((name, i) => ({ id: `p${i}`, name }));
  return detectPartnerVariants(partners, {});
}

describe("normalizePartnerName", () => {
  it("会社形態のゆれを吸収 (㈱ ≡ 株式会社)", () => {
    expect(normalizePartnerName("㈱コメリ")).toBe(normalizePartnerName("株式会社コメリ"));
    expect(normalizePartnerName("㈱コメリ")).toBe("コメリ");
  });
  it("記号・中黒・全半角・大文字小文字を吸収", () => {
    expect(normalizePartnerName("ユナイテッド・シネマ")).toBe("ユナイテッドシネマ");
    expect(normalizePartnerName("STARBUCKS®")).toBe("starbucks");
    expect(normalizePartnerName("ＲＥＣ　ＣＯＦＦＥＥ")).toBe("reccoffee");
  });
});

describe("detectPartnerVariants — 真の表記ゆれのみ検出する", () => {
  it("省略形 (一方が他方の前方一致) は検出", () => {
    const pairs = detect(["タリーズ", "タリーズコーヒー"]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].base.name).toBe("タリーズ"); // 短い方 = 残す候補
    expect(pairs[0].variant.name).toBe("タリーズコーヒー");
  });

  it("ブランド ⊆ ブランド+店舗 は検出", () => {
    expect(detect(["STARBUCKS®", "STARBUCKS® 福岡新宮店"])).toHaveLength(1);
    expect(
      detect(["ユナイテッド・シネマ", "ユナイテッド・シネマ キャナルシティ13"]),
    ).toHaveLength(1);
  });

  it("会社形態だけ違う (㈱ vs 株式会社) は検出", () => {
    expect(detect(["㈱コメリ", "株式会社コメリ"])).toHaveLength(1);
  });

  it("★ 同ブランド別店舗 (共通接頭辞の後に両者が別々に伸びる) は検出しない", () => {
    // ユーザ報告の誤検知ケース群
    expect(
      detect(["REC COFFEE 薬院駅前店", "REC COFFEE 博多ロースタリー"]),
    ).toHaveLength(0);
    expect(detect(["コメリ パワー領鹿店", "コメリ パワー新居浜店"])).toHaveLength(0);
    expect(
      detect([
        "ユナイテッド・シネマ トリアス久山",
        "ユナイテッド・シネマ キャナルシティ13",
      ]),
    ).toHaveLength(0);
  });

  it("短すぎる共通部分 (正規化後 3 文字未満) は誤検知しない", () => {
    expect(detect(["AB", "ABC商店"])).toHaveLength(0);
  });

  it("無関係な名前は検出しない", () => {
    expect(detect(["アマゾン", "楽天市場"])).toHaveLength(0);
  });

  it("3 件以上でも前方一致ペアだけを拾う", () => {
    const pairs = detect([
      "タリーズ",
      "タリーズコーヒー",
      "コメリ パワー領鹿店",
      "コメリ パワー新居浜店",
    ]);
    expect(pairs).toHaveLength(1);
    expect(variantPairKey(pairs[0].base.id, pairs[0].variant.id)).toBe(
      variantPairKey("p0", "p1"),
    );
  });
});
