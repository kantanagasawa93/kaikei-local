import { describe, it, expect } from "vitest";
import {
  searchAccounts,
  normalizeForSearch,
  ACCOUNT_READINGS,
  DEFAULT_ACCOUNTS,
  classifyAccountCode,
  resolveAccountByName,
  UNCLASSIFIED_ACCOUNT_CODE,
} from "@/lib/accounts";

describe("normalizeForSearch", () => {
  it("全角英数を半角に、カタカナをひらがなに、小文字化する", () => {
    expect(normalizeForSearch("６０４")).toBe("604");
    expect(normalizeForSearch("ショウモウ")).toBe("しょうもう");
    expect(normalizeForSearch("Supplies")).toBe("supplies");
  });
});

describe("searchAccounts — freee 風予測変換", () => {
  it("コード完全一致がトップ", () => {
    expect(searchAccounts("610")[0].code).toBe("610");
    expect(searchAccounts("604")[0].code).toBe("604");
  });

  it("漢字の部分一致で科目が出る", () => {
    expect(searchAccounts("消耗")[0].code).toBe("610");
    expect(searchAccounts("旅費")[0].code).toBe("604");
    expect(searchAccounts("通信")[0].code).toBe("605");
  });

  it("読み仮名 (ひらがな) で出る", () => {
    expect(searchAccounts("しょうもう")[0].code).toBe("610");
    expect(searchAccounts("つうしん")[0].code).toBe("605");
  });

  it("カタカナ入力もひらがな読みにマッチ", () => {
    expect(searchAccounts("ショウモウ")[0].code).toBe("610");
  });

  it("全角数字のコードにマッチ", () => {
    expect(searchAccounts("６０４")[0].code).toBe("604");
  });

  it("英名でマッチ (大文字小文字問わず)", () => {
    expect(searchAccounts("supplies")[0].code).toBe("610");
    expect(searchAccounts("RENT")[0].code).toBe("616");
  });

  it("前方一致を部分一致より優先する", () => {
    // 「かい」→ 買掛金(かいかけきん) が 会議費(かいぎひ) と同順位帯だが
    // どちらも前方一致なのでコード順。まず前方一致群が来ることを確認。
    const codes = searchAccounts("かい").map((a) => a.code);
    expect(codes).toContain("200"); // 買掛金
    expect(codes).toContain("621"); // 会議費
  });

  it("category 指定でその区分だけに絞る", () => {
    const res = searchAccounts("金", "asset");
    expect(res.every((a) => a.category === "asset")).toBe(true);
    // 資産の「現金」「売掛金」等が入り、負債の「買掛金」は入らない
    expect(res.map((a) => a.code)).toContain("100");
    expect(res.map((a) => a.code)).not.toContain("200");
  });

  it("該当なしは空配列", () => {
    expect(searchAccounts("xyzzy該当なし")).toEqual([]);
  });

  it("空クエリは pool 全件を返す", () => {
    expect(searchAccounts("").length).toBe(DEFAULT_ACCOUNTS.length);
    expect(searchAccounts("  ", "expense").length).toBe(
      DEFAULT_ACCOUNTS.filter((a) => a.category === "expense").length,
    );
  });
});

describe("ACCOUNT_READINGS", () => {
  it("全ての勘定科目に読み仮名がある (予測変換の穴を防ぐ)", () => {
    const missing = DEFAULT_ACCOUNTS.filter((a) => !ACCOUNT_READINGS[a.code]);
    expect(missing.map((a) => `${a.code} ${a.name}`)).toEqual([]);
  });

  it("読み仮名はひらがな (と長音符) のみ", () => {
    for (const r of Object.values(ACCOUNT_READINGS)) {
      expect(r).toMatch(/^[ぁ-んー]+$/);
    }
  });
});

describe("classifyAccountCode — 集計区分は科目表から引く", () => {
  it("既定の科目を 収益 / 売上原価 / 経費 / BS に分ける", () => {
    expect(classifyAccountCode("400")).toBe("revenue");
    expect(classifyAccountCode("410")).toBe("revenue");
    expect(classifyAccountCode("501")).toBe("cogs");
    expect(classifyAccountCode("502")).toBe("cogs");
    expect(classifyAccountCode("607")).toBe("expense");
    expect(classifyAccountCode("699")).toBe("expense");
    expect(classifyAccountCode("110")).toBe("bs");
    expect(classifyAccountCode("210")).toBe("bs");
    expect(classifyAccountCode("300")).toBe("bs");
  });

  it("科目表に無いコードは null (先頭桁で勝手に売上・経費にしない)", () => {
    // 取込で付く未分類コード。旧実装では売上にも経費にも入らず黙って消えていた
    expect(classifyAccountCode(UNCLASSIFIED_ACCOUNT_CODE)).toBeNull();
    expect(classifyAccountCode("A900")).toBeNull();
    // 先頭が 4/6 でも科目表に無ければ分類しない
    expect(classifyAccountCode("650")).toBeNull();
    expect(classifyAccountCode("")).toBeNull();
    expect(classifyAccountCode(null)).toBeNull();
  });

  it("DB で追加された科目は渡した対応表で分類できる", () => {
    const map = new Map([
      ["A900", "expense"],
      ["A901", "revenue"],
      ["A902", "liability"],
    ] as const);
    expect(classifyAccountCode("A900", map)).toBe("expense");
    expect(classifyAccountCode("A901", map)).toBe("revenue");
    expect(classifyAccountCode("A902", map)).toBe("bs");
  });

  it("既定の科目は全て分類できる (科目を足した時の入れ忘れ検知)", () => {
    const unknown = DEFAULT_ACCOUNTS.filter((a) => classifyAccountCode(a.code) === null);
    expect(unknown).toEqual([]);
  });
});

describe("resolveAccountByName — 他ソフトの科目名を既定の科目に寄せる", () => {
  it("既定の科目名はそのまま引ける", () => {
    expect(resolveAccountByName("接待交際費")).toEqual({ code: "607", name: "接待交際費" });
    expect(resolveAccountByName("普通預金")).toEqual({ code: "110", name: "普通預金" });
  });

  it("よくある別名を寄せる (実データで 999 になっていた 交際費 / 外注費)", () => {
    expect(resolveAccountByName("交際費")).toEqual({ code: "607", name: "接待交際費" });
    expect(resolveAccountByName("外注費")).toEqual({ code: "614", name: "外注工賃" });
    expect(resolveAccountByName("支払利息")?.code).toBe("615");
  });

  it("空白・全角半角の差は無視する", () => {
    expect(resolveAccountByName(" 旅費交通費 ")?.code).toBe("604");
    expect(resolveAccountByName("旅費　交通費")?.code).toBe("604");
  });

  it("口座名など判断できない名前は null (勝手に寄せない)", () => {
    expect(resolveAccountByName("三井住友MASTERカード")).toBeNull();
    expect(resolveAccountByName("西日本シティ（API）")).toBeNull();
    expect(resolveAccountByName("損益")).toBeNull();
    expect(resolveAccountByName("")).toBeNull();
    expect(resolveAccountByName(null)).toBeNull();
  });

  it("別名の飛び先は必ず既定の科目表に存在する", () => {
    // 別名テーブルに存在しないコードを書いた時に気付けるように
    for (const alias of ["交際費", "外注費", "保険料", "給料手当", "手数料", "売上", "仕入"]) {
      const r = resolveAccountByName(alias);
      expect(r, alias).not.toBeNull();
      expect(DEFAULT_ACCOUNTS.some((a) => a.code === r!.code)).toBe(true);
    }
  });
});
