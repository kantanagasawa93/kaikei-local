/**
 * SQLite の datetime('now') は 'YYYY-MM-DD HH:MM:SS' 形式で、
 * WebKit の new Date() はこの空白区切り文字列を確実にパースできない。
 * ISO 形式（T 区切り + Z）に変換してから扱う。
 */
export function parseSqliteDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const iso = s.includes("T")
    ? s
    : s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z");
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d;
}

export function formatSqliteDate(
  s: string | null | undefined,
  opts: { withTime?: boolean } = {}
): string {
  const d = parseSqliteDate(s);
  if (!d) return "-";
  if (opts.withTime) {
    return d.toLocaleString("ja-JP");
  }
  return d.toLocaleDateString("ja-JP");
}

/**
 * Date → ローカル (端末のタイムゾーン) の日付 "YYYY-MM-DD"。
 *
 * `d.toISOString().slice(0, 10)` は UTC の日付になる。日本時間 (UTC+9) では
 * 0:00〜8:59 の間「前日」が返り、仕訳や請求書の既定日付が 1 日ずれる。
 * 1 月 1 日の朝だと前年 12/31 = 前の会計年度に入ってしまうので、日付の既定値は
 * 必ずこの関数 (または todayLocal) で作ること。
 */
export function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 今日 (ローカル) の日付 "YYYY-MM-DD"。 */
export function todayLocal(): string {
  return toLocalDateString(new Date());
}

/**
 * "YYYY-MM-DD" に日数を足した日付文字列を返す (月末・年またぎは Date に任せる)。
 * `new Date("YYYY-MM-DD")` は UTC 0 時として解釈されるので、年月日を分解して
 * ローカル日付として組み立てる。形式が違う入力はそのまま返す。
 */
export function addDaysToDateString(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return toLocalDateString(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
}
