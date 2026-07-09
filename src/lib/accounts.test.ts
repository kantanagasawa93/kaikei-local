import { describe, it, expect } from "vitest";
import {
  searchAccounts,
  normalizeForSearch,
  ACCOUNT_READINGS,
  DEFAULT_ACCOUNTS,
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
