/**
 * Round 21 ⓒ: 仕訳タグ (journals.tags) の小さなユーティリティ。
 *
 * tags は JSON 配列文字列 (`'["経費精算済","会議費"]'`) で永続化する。
 * 検索・集計は SQLite の LIKE %"タグ名"% で十分速い (n=数千程度想定)。
 */

import { db } from "@/lib/localDb";

/** ローカルで使う典型タグ。UI のサジェストに使う (ユーザは任意の文字列を追加可能)。 */
export const SUGGESTED_TAGS = [
  "経費精算済",
  "会議費",
  "交際費",
  "旅費",
  "レビュー対象",
  "個人立替",
  "要再確認",
] as const;

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
  } catch {
    // legacy: カンマ区切りで保存していたケース (将来発生し得る) にも対応
    return raw
      .split(/[,、]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

export function stringifyTags(tags: string[]): string {
  const cleaned = Array.from(
    new Set(
      tags.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 30),
    ),
  );
  return JSON.stringify(cleaned);
}

export async function setJournalTags(
  journalId: string,
  tags: string[],
): Promise<void> {
  const tagsStr = tags.length === 0 ? null : stringifyTags(tags);
  await db.from("journals").update({ tags: tagsStr }).eq("id", journalId);
}

/** journal_id → tags[] のマップを 1 クエリで作る (一覧描画用) */
export async function loadAllJournalTags(): Promise<Record<string, string[]>> {
  const { data } = await db.from("journals").select("id, tags");
  const map: Record<string, string[]> = {};
  for (const row of (data as { id: string; tags: string | null }[] | null) ?? []) {
    map[row.id] = parseTags(row.tags);
  }
  return map;
}
