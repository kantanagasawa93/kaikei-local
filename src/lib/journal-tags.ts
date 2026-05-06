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

/**
 * Round 22 ㊛: 仕訳タグの一括操作.
 *
 * - mode='add': 既存タグに追加 (重複は自動排除)
 * - mode='remove': 該当タグだけ取り除く (他のタグは保持)
 * - mode='replace': タグを完全置換
 *
 * 100 件規模を想定して 1 件ずつ UPDATE する (Tauri SQL は IN UPDATE が遅い)。
 * @returns 実際に更新できた件数
 */
export async function bulkUpdateJournalTags(
  journalIds: string[],
  tags: string[],
  mode: "add" | "remove" | "replace" = "add",
): Promise<number> {
  if (journalIds.length === 0) return 0;
  let count = 0;
  for (const id of journalIds) {
    try {
      let next: string[];
      if (mode === "replace") {
        next = tags;
      } else {
        const { data } = await db
          .from("journals")
          .select("tags")
          .eq("id", id)
          .single();
        const current = parseTags((data as { tags: string | null } | null)?.tags ?? null);
        if (mode === "add") {
          next = Array.from(new Set([...current, ...tags]));
        } else {
          // remove
          next = current.filter((t) => !tags.includes(t));
        }
      }
      const tagsStr = next.length === 0 ? null : stringifyTags(next);
      await db.from("journals").update({ tags: tagsStr }).eq("id", id);
      count++;
    } catch (e) {
      console.warn(`bulkUpdateJournalTags: ${id} failed:`, e);
    }
  }
  return count;
}
