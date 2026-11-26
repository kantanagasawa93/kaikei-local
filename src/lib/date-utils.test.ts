import { describe, it, expect, afterEach, vi } from "vitest";
import { addDaysToDateString, toLocalDateString, todayLocal } from "@/lib/date-utils";

describe("ローカル日付ヘルパ (既定日付が UTC でずれないこと)", () => {
  afterEach(() => vi.useRealTimers());

  it("toLocalDateString はローカルの年月日を使う", () => {
    // ローカル時刻で組み立てた Date は、タイムゾーンに関わらずその日付になる
    expect(toLocalDateString(new Date(2026, 0, 1, 8, 30))).toBe("2026-01-01");
    expect(toLocalDateString(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
    expect(toLocalDateString(new Date(2026, 2, 5, 0, 0))).toBe("2026-03-05");
  });

  it("todayLocal は元日の朝でも前年にならない (toISOString だと JST では 12/31 になる)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 1, 8, 30)); // ローカル 2027-01-01 08:30
    expect(todayLocal()).toBe("2027-01-01");
  });

  it("addDaysToDateString は月末・年またぎ・うるう年を正しく越える", () => {
    expect(addDaysToDateString("2026-11-26", 30)).toBe("2026-12-26");
    expect(addDaysToDateString("2026-12-15", 30)).toBe("2027-01-14");
    expect(addDaysToDateString("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToDateString("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDaysToDateString("2026-01-31", 0)).toBe("2026-01-31");
    expect(addDaysToDateString("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("形式が違う入力はそのまま返す (壊れた日付を別の日付に化けさせない)", () => {
    expect(addDaysToDateString("", 30)).toBe("");
    expect(addDaysToDateString("2026/11/26", 30)).toBe("2026/11/26");
  });
});
