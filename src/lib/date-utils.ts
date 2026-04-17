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
