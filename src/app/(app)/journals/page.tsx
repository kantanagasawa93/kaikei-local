"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, BookOpen, Trash2, Pencil, Image as ImageIcon, Undo2, RotateCcw, Download, Tag, X as XIcon, CheckSquare, Square } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  reverseJournalToInbox,
  undoLastReverse,
  getReverseUndoCount,
} from "@/lib/auto-journal";
import { buildJournalsCsv, downloadCsv, buildFiscalYearSummary } from "@/lib/journal-export";
import { exportFiscalYearSummaryPdf, downloadBlob } from "@/lib/pdf-export";
import {
  parseTags,
  setJournalTags,
  bulkUpdateJournalTags,
  SUGGESTED_TAGS,
} from "@/lib/journal-tags";
import { toast } from "@/lib/toast";
import type { Journal, JournalLine } from "@/types";

interface JournalWithLines extends Journal {
  journal_lines: JournalLine[];
  // receipt_id は Journal 側で string | null と宣言されている前提。
  // 受信箱(写真自動取込) → 自動仕訳の経路で作られた仕訳にバッジを出す。
}

const PAGE_SIZE = 50;

export default function JournalsPage() {
  // Round 22 ⓓ: ?month=YYYY-MM クエリで dashboard ドリルダウンから飛んで来た時の初期値.
  // Next 16 static export では useSearchParams() に Suspense boundary が要るため
  // window.location.search を直接読む (Tauri の static export ではこれで十分).
  const [journals, setJournals] = useState<JournalWithLines[]>([]);
  const [monthFilter, setMonthFilter] = useState("");
  // Round 25 ⓒ: from/to レンジを URL クエリで受ける (dashboard ドリルダウン用)
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const m = params.get("month");
    if (m && /^\d{4}-\d{2}$/.test(m)) {
      setMonthFilter(m);
    }
    // Round 24 ㊟: ?incomplete=1 で「要確認のみ」フィルタ ON で開く
    if (params.get("incomplete") === "1") {
      setIncompleteOnly(true);
    }
    // Round 25 ⓒ: ?from=YYYY-MM-DD&to=YYYY-MM-DD レンジ
    const f = params.get("from");
    const t = params.get("to");
    if (f && /^\d{4}-\d{2}-\d{2}$/.test(f)) setDateFrom(f);
    if (t && /^\d{4}-\d{2}-\d{2}$/.test(t)) setDateTo(t);
  }, []);
  const [tagFilter, setTagFilter] = useState("");
  // Round 23 ⓒ: 摘要検索 + 金額レンジ
  const [descSearch, setDescSearch] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  // Round 23 ⓓ: 不完全な仕訳のみ表示
  const [incompleteOnly, setIncompleteOnly] = useState(false);
  const [page, setPage] = useState(0);
  // ㊍ Round 6: 直近の差し戻しを取り消せる件数 (0 なら button 非表示)
  const [undoCount, setUndoCount] = useState(0);
  // Round 21 ⓒ: タグ編集モーダル対象の仕訳 ID
  const [tagEditFor, setTagEditFor] = useState<string | null>(null);
  // Round 22 ㊛: 仕訳の bulk select 状態 (id Set) + bulk タグ追加モーダル
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTagModalOpen, setBulkTagModalOpen] = useState(false);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllVisible(ids: string[]) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function handleBulkAddTags(tagsToAdd: string[]) {
    if (tagsToAdd.length === 0 || selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const updated = await bulkUpdateJournalTags(ids, tagsToAdd, "add");
    // ローカル state も即時反映
    setJournals((prev) =>
      prev.map((j) => {
        if (!selectedIds.has(j.id)) return j;
        const cur = parseTags(j.tags ?? null);
        const next = Array.from(new Set([...cur, ...tagsToAdd]));
        return { ...j, tags: next.length === 0 ? null : JSON.stringify(next) };
      }),
    );
    toast.success(`${updated} 件にタグを追加しました`);
    setBulkTagModalOpen(false);
    clearSelection();
  }

  async function handleBulkRemoveTag(tag: string) {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const updated = await bulkUpdateJournalTags(ids, [tag], "remove");
    setJournals((prev) =>
      prev.map((j) => {
        if (!selectedIds.has(j.id)) return j;
        const cur = parseTags(j.tags ?? null).filter((t) => t !== tag);
        return { ...j, tags: cur.length === 0 ? null : JSON.stringify(cur) };
      }),
    );
    toast.success(`${updated} 件から「${tag}」を外しました`);
  }

  useEffect(() => {
    loadJournals();
    void getReverseUndoCount().then(setUndoCount);
  }, []);

  async function loadJournals() {
    const { data } = await supabase
      .from("journals")
      .select("*, journal_lines(*)")
      .order("date", { ascending: false });
    if (data) setJournals(data);
  }

  // ㊒ Round 7: 仕訳 CSV エクスポート (画像 URL コラム + 受信箱由来フラグ込み)
  // Round 21 ⓔ: yearOverride を受けると会計年度 (1/1〜12/31) で出力する
  async function handleExportCsv(yearOverride?: number) {
    try {
      let from: string | null = null;
      let to: string | null = null;
      let suffix = "";
      if (yearOverride) {
        from = `${yearOverride}-01-01`;
        to = `${yearOverride}-12-31`;
        suffix = `_FY${yearOverride}`;
      } else if (monthFilter) {
        from = `${monthFilter}-01`;
        const [y, m] = monthFilter.split("-").map(Number);
        const last = new Date(y, m, 0).getDate();
        to = `${monthFilter}-${String(last).padStart(2, "0")}`;
        suffix = `_${monthFilter}`;
      }
      const csv = await buildJournalsCsv({ fromDate: from, toDate: to });
      const fname = `kaikei_journals${suffix}_${new Date().toISOString().slice(0, 10)}.csv`;
      downloadCsv(csv, fname);
      toast.success(`CSV を書き出しました (${fname})`);
    } catch (e) {
      toast.error(`CSV 書き出しに失敗: ${(e as Error).message}`);
    }
  }

  // Round 21 ⓔ: 利用可能な会計年度の集合 (journals.date の先頭 4 文字)
  const availableYears = (() => {
    const set = new Set<number>();
    for (const j of journals) {
      const y = parseInt(j.date.slice(0, 4), 10);
      if (Number.isFinite(y)) set.add(y);
    }
    return Array.from(set).sort((a, b) => b - a);
  })();

  // ㊍ undo: app_settings に積んでおいた直近の差し戻しスナップショットから
  // 仕訳・明細・領収書・受信箱状態をまとめて復元する。
  async function handleUndoReverse() {
    try {
      const r = await undoLastReverse();
      if (!r.restored) {
        toast.info("取り消せる差し戻しがありません");
      } else {
        toast.success(`差し戻しを取り消し、仕訳を復元しました (#${r.journalId})`);
        await loadJournals();
      }
      setUndoCount(await getReverseUndoCount());
    } catch (e) {
      toast.error(`取り消しに失敗: ${(e as Error).message}`);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("この仕訳を削除しますか？")) return;
    await supabase.from("journals").delete().eq("id", id);
    setJournals((prev) => prev.filter((j) => j.id !== id));
  }

  // Round 4 ㊂ 差し戻し:
  // 受信箱由来 (receipt_id 紐付き) の仕訳を取り消して photo_inbox を candidate に戻す。
  // 自動仕訳の結果が誤読だった時のリカバリー動線。
  // Round 6 ㊍: 削除前にスナップショットを undo stack に積むので、押した直後でも
  //              取り消せる (上の handleUndoReverse から復元)。
  async function handleReverseToInbox(id: string) {
    const ok = window.confirm(
      "この仕訳と紐付く領収書レコードを削除して、写真を「未判定」状態の受信箱に戻します。\n\n" +
        "戻したあと、受信箱の「いますぐ仕訳化」または「領収書として登録」から再仕訳できます。\n\n" +
        "(押した直後なら「直近の差し戻しを取り消す」ボタンで復元可能)\n\n" +
        "続行しますか?",
    );
    if (!ok) return;
    try {
      const inboxId = await reverseJournalToInbox(id);
      if (inboxId) {
        toast.success("仕訳を取り消して受信箱に戻しました");
      } else {
        toast.info("仕訳と領収書を削除しました (受信箱由来ではないので戻し先なし)");
      }
      setJournals((prev) => prev.filter((j) => j.id !== id));
      setUndoCount(await getReverseUndoCount());
    } catch (e) {
      toast.error(`差し戻しに失敗: ${(e as Error).message}`);
    }
  }

  // Round 23 ⓓ: 不完全な仕訳の判定
  // - 借方・貸方すべて 0 円
  // - 摘要が「不明 - 雑費」(autoJournalize の fallback)
  // - 行が 0 件
  const isIncomplete = (j: JournalWithLines): boolean => {
    if (!j.journal_lines || j.journal_lines.length === 0) return true;
    const total = j.journal_lines.reduce(
      (acc, ln) => acc + (ln.debit_amount || 0) + (ln.credit_amount || 0),
      0,
    );
    if (total === 0) return true;
    if (
      j.description &&
      (j.description.startsWith("不明 - ") || j.description === "不明")
    ) {
      return true;
    }
    return false;
  };

  const filteredJournals = journals.filter((j) => {
    if (monthFilter && !j.date.startsWith(monthFilter)) return false;
    // Round 25 ⓒ: from/to レンジフィルタ
    if (dateFrom && j.date < dateFrom) return false;
    if (dateTo && j.date > dateTo) return false;
    if (tagFilter) {
      const ts = parseTags(j.tags ?? null);
      if (!ts.includes(tagFilter)) return false;
    }
    // Round 23 ⓒ: 摘要検索 (description + 各行 account_name + memo を OR で部分一致)
    if (descSearch.trim()) {
      const q = descSearch.trim().toLowerCase();
      const hay = [
        j.description?.toLowerCase() ?? "",
        ...(j.journal_lines ?? []).map(
          (ln) =>
            (ln.account_name ?? "").toLowerCase() +
            " " +
            (ln.memo ?? "").toLowerCase(),
        ),
      ].join(" ");
      if (!hay.includes(q)) return false;
    }
    // 金額レンジ (借方の最大値で判定)
    const amountMinNum = parseInt(amountMin.replace(/,/g, ""), 10);
    const amountMaxNum = parseInt(amountMax.replace(/,/g, ""), 10);
    if (
      Number.isFinite(amountMinNum) ||
      Number.isFinite(amountMaxNum)
    ) {
      const lineMax = (j.journal_lines ?? []).reduce(
        (m, ln) => Math.max(m, ln.debit_amount || 0, ln.credit_amount || 0),
        0,
      );
      if (Number.isFinite(amountMinNum) && lineMax < amountMinNum) return false;
      if (Number.isFinite(amountMaxNum) && lineMax > amountMaxNum) return false;
    }
    if (incompleteOnly && !isIncomplete(j)) return false;
    return true;
  });

  // 既存仕訳に出てきた全タグの集合 (フィルタの select 候補に使う)
  const allTags = (() => {
    const set = new Set<string>();
    for (const j of journals) {
      for (const t of parseTags(j.tags ?? null)) set.add(t);
    }
    return Array.from(set).sort();
  })();
  const totalPages = Math.ceil(filteredJournals.length / PAGE_SIZE);
  const pagedJournals = filteredJournals.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // フィルタ変更時にページをリセット
  useEffect(() => { setPage(0); }, [monthFilter]);

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ja-JP").format(amount);

  // Round 21 ⓒ: タグ編集モーダル
  const tagEditTarget = tagEditFor
    ? journals.find((j) => j.id === tagEditFor)
    : null;

  return (
    <div className="space-y-6">
      {tagEditTarget && (
        <TagEditModal
          journalId={tagEditTarget.id}
          initial={parseTags(tagEditTarget.tags ?? null)}
          description={tagEditTarget.description}
          onSave={async (newTags) => {
            await setJournalTags(tagEditTarget.id, newTags);
            setJournals((prev) =>
              prev.map((j) =>
                j.id === tagEditTarget.id
                  ? { ...j, tags: newTags.length === 0 ? null : JSON.stringify(newTags) }
                  : j,
              ),
            );
            setTagEditFor(null);
            toast.success("タグを保存しました");
          }}
          onClose={() => setTagEditFor(null)}
        />
      )}
      {bulkTagModalOpen && (
        <BulkTagModal
          count={selectedIds.size}
          onAdd={(tags) => void handleBulkAddTags(tags)}
          onClose={() => setBulkTagModalOpen(false)}
        />
      )}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">仕訳帳</h1>
        <div className="flex gap-2">
          {/* ㊍ 直近の差し戻しを取り消すボタン (stack に 1 件以上ある時のみ) */}
          {undoCount > 0 && (
            <Button variant="outline" onClick={handleUndoReverse} title="直近の差し戻しを取り消して仕訳を復元">
              <RotateCcw className="h-4 w-4 mr-1" />
              直近の差し戻しを取り消す
              <Badge variant="secondary" className="ml-2 text-[10px]">{undoCount}</Badge>
            </Button>
          )}
          {/* ㊒ CSV エクスポート — 月フィルタ適用、画像 URL + 受信箱フラグ込み */}
          <Button variant="outline" onClick={() => handleExportCsv()} title="仕訳帳を CSV でダウンロード (画像 URL + 受信箱由来フラグ込み)">
            <Download className="h-4 w-4 mr-1" />
            CSV
          </Button>
          {/* Round 21 ⓔ: 会計年度で CSV 出力 (e-Tax 前段で 1 年分まとめて) */}
          {availableYears.length > 0 && (
            <select
              onChange={(e) => {
                const y = parseInt(e.target.value, 10);
                if (Number.isFinite(y)) {
                  void handleExportCsv(y);
                  e.target.value = "";
                }
              }}
              defaultValue=""
              className="border rounded px-2 py-1 text-sm h-9"
              title="指定の会計年度 (1/1〜12/31) を CSV 出力"
            >
              <option value="" disabled>
                年度別 CSV
              </option>
              {availableYears.map((y) => (
                <option key={y} value={y}>
                  FY {y}
                </option>
              ))}
            </select>
          )}
          {/* Round 22 ⓔ: 年度サマリ PDF (確定申告期のレビュー用) */}
          {availableYears.length > 0 && (
            <select
              onChange={(e) => {
                const y = parseInt(e.target.value, 10);
                if (Number.isFinite(y)) {
                  void (async () => {
                    try {
                      const summary = await buildFiscalYearSummary(y);
                      const bytes = await exportFiscalYearSummaryPdf(summary);
                      downloadBlob(
                        bytes,
                        `kaikei_summary_FY${y}_${new Date().toISOString().slice(0, 10)}.pdf`,
                      );
                      toast.success(`FY${y} のサマリ PDF を生成しました`);
                    } catch (err) {
                      toast.error(`PDF 生成に失敗: ${(err as Error).message}`);
                    }
                  })();
                  e.target.value = "";
                }
              }}
              defaultValue=""
              className="border rounded px-2 py-1 text-sm h-9"
              title="指定の会計年度 (1/1〜12/31) を 1 枚 PDF にまとめる"
            >
              <option value="" disabled>
                年度サマリ PDF
              </option>
              {availableYears.map((y) => (
                <option key={y} value={y}>
                  FY {y}
                </option>
              ))}
            </select>
          )}
          <Link href="/journals/new">
            <Button>
              <Plus className="h-4 w-4 mr-1" />
              新規仕訳
            </Button>
          </Link>
        </div>
      </div>

      {/* Round 25 ⓒ: from/to レンジ active 時の chip 表示 + 解除ボタン */}
      {(dateFrom || dateTo) && (
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline" className="bg-blue-50 border-blue-200 text-blue-700">
            期間: {dateFrom || "..."} 〜 {dateTo || "..."}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDateFrom("");
              setDateTo("");
              // URL からも消す
              if (typeof window !== "undefined") {
                const url = new URL(window.location.href);
                url.searchParams.delete("from");
                url.searchParams.delete("to");
                window.history.replaceState({}, "", url.toString());
              }
            }}
            className="h-6 text-xs"
          >
            解除
          </Button>
        </div>
      )}

      <div className="flex gap-2 items-center flex-wrap">
        <Input
          type="month"
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="w-44"
        />
        {/* Round 21 ⓒ: タグでの絞り込み */}
        {allTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="border rounded px-2 py-1 text-sm h-9"
          >
            <option value="">すべてのタグ</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
        {/* Round 23 ⓒ: 摘要 + 金額レンジ検索 */}
        <Input
          type="search"
          placeholder="摘要・科目・メモを検索"
          value={descSearch}
          onChange={(e) => setDescSearch(e.target.value)}
          className="w-56"
        />
        <Input
          type="text"
          inputMode="numeric"
          placeholder="¥下限"
          value={amountMin}
          onChange={(e) => setAmountMin(e.target.value)}
          className="w-24"
          title="この金額以上の借方/貸方を含む仕訳"
        />
        <span className="text-xs text-muted-foreground">〜</span>
        <Input
          type="text"
          inputMode="numeric"
          placeholder="¥上限"
          value={amountMax}
          onChange={(e) => setAmountMax(e.target.value)}
          className="w-24"
          title="この金額以下の借方/貸方を含む仕訳"
        />
        {/* Round 23 ⓓ: 不完全な仕訳のみフィルタ */}
        <label className="flex items-center gap-1.5 text-sm select-none cursor-pointer">
          <input
            type="checkbox"
            checked={incompleteOnly}
            onChange={(e) => setIncompleteOnly(e.target.checked)}
            className="h-4 w-4"
          />
          要確認のみ
        </label>
      </div>

      {/* Round 22 ㊛: bulk action toolbar — selectedIds が 1 件以上ある時だけ表示
          Round 25 ⓓ: 選択中の借方/貸方合計をワンライナーで表示 */}
      {selectedIds.size > 0 && (() => {
        let totalDebit = 0;
        let totalCredit = 0;
        for (const j of journals) {
          if (!selectedIds.has(j.id)) continue;
          for (const ln of j.journal_lines ?? []) {
            totalDebit += ln.debit_amount || 0;
            totalCredit += ln.credit_amount || 0;
          }
        }
        const fmt = (n: number) =>
          new Intl.NumberFormat("ja-JP").format(n);
        return (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-200 rounded-md flex-wrap">
          <span className="text-sm font-medium text-blue-700">
            {selectedIds.size} 件選択中
          </span>
          <span className="text-xs text-blue-700/80 tabular-nums">
            借方 ¥{fmt(totalDebit)} / 貸方 ¥{fmt(totalCredit)}
          </span>
          <Button
            size="sm"
            variant="default"
            onClick={() => setBulkTagModalOpen(true)}
            title="選択した仕訳にまとめてタグを追加"
          >
            <Tag className="h-3 w-3 mr-1" />
            タグを追加
          </Button>
          {/* よくある「経費精算済」をワンクリックで追加 */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleBulkAddTags(["経費精算済"])}
            title="選択した仕訳に「経費精算済」をワンクリックで追加"
          >
            ＋ 経費精算済
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void handleBulkRemoveTag("経費精算済")}
            title="選択した仕訳から「経費精算済」を外す"
          >
            ✕ 経費精算済
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            選択解除
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => selectAllVisible(pagedJournals.map((j) => j.id))}
            className="ml-auto"
          >
            ページ内すべて選択
          </Button>
        </div>
        );
      })()}

      {pagedJournals.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <BookOpen className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {journals.length === 0
                ? "仕訳がまだありません"
                : "選択した期間の仕訳がありません"}
            </p>
            {journals.length === 0 && (
              <Link href="/journals/new">
                <Button className="mt-4" variant="outline">
                  最初の仕訳を登録
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {/* Round 22 ㊛: bulk select checkbox 列 */}
                  <TableHead className="w-8">
                    <button
                      type="button"
                      onClick={() => {
                        const visibleIds = pagedJournals.map((j) => j.id);
                        const allSelected = visibleIds.every((id) => selectedIds.has(id));
                        if (allSelected) {
                          // 全部解除
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            for (const id of visibleIds) next.delete(id);
                            return next;
                          });
                        } else {
                          selectAllVisible(visibleIds);
                        }
                      }}
                      className="hover:opacity-70"
                      title="ページ内すべて選択 / 解除"
                    >
                      {pagedJournals.every((j) => selectedIds.has(j.id)) && pagedJournals.length > 0 ? (
                        <CheckSquare className="h-4 w-4" />
                      ) : (
                        <Square className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                  </TableHead>
                  <TableHead className="w-28">日付</TableHead>
                  <TableHead>摘要</TableHead>
                  <TableHead>勘定科目</TableHead>
                  <TableHead className="text-right">借方</TableHead>
                  <TableHead className="text-right">貸方</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedJournals.map((journal) =>
                  journal.journal_lines.map((line, lineIndex) => (
                    <TableRow
                      key={`${journal.id}-${line.id}`}
                      className={selectedIds.has(journal.id) ? "bg-blue-50/50" : undefined}
                    >
                      {lineIndex === 0 ? (
                        <>
                          {/* Round 22 ㊛: bulk select checkbox */}
                          <TableCell
                            rowSpan={journal.journal_lines.length}
                            className="align-top"
                          >
                            <button
                              type="button"
                              onClick={() => toggleSelected(journal.id)}
                              className="hover:opacity-70 mt-1"
                              aria-label={selectedIds.has(journal.id) ? "選択解除" : "選択"}
                            >
                              {selectedIds.has(journal.id) ? (
                                <CheckSquare className="h-4 w-4 text-primary" />
                              ) : (
                                <Square className="h-4 w-4 text-muted-foreground" />
                              )}
                            </button>
                          </TableCell>
                          <TableCell
                            rowSpan={journal.journal_lines.length}
                            className="align-top font-medium"
                          >
                            {journal.date}
                          </TableCell>
                          <TableCell
                            rowSpan={journal.journal_lines.length}
                            className="align-top"
                          >
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span>{journal.description}</span>
                              {/* Round 23 ⓓ: 不完全な仕訳に amber Badge */}
                              {isIncomplete(journal) && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] gap-1 bg-amber-50 border-amber-300 text-amber-800"
                                  title="金額が 0 / 摘要が「不明」など、確定申告前に確認すべき仕訳"
                                >
                                  要確認
                                </Badge>
                              )}
                              {journal.receipt_id && (
                                // 受信箱由来の自動仕訳である目印。
                                // Phase 4 (auto-journal) で receipts.id が必ず紐付く。
                                <Link
                                  href={`/receipts`}
                                  className="inline-flex"
                                  title="写真受信箱から自動仕訳された行 — 領収書一覧で原本を確認できます"
                                >
                                  <Badge
                                    variant="secondary"
                                    className="text-[10px] gap-1 cursor-pointer hover:bg-secondary/80"
                                  >
                                    <ImageIcon className="h-3 w-3" />
                                    受信箱
                                  </Badge>
                                </Link>
                              )}
                              {/* Round 21 ⓒ: 仕訳タグ chip 表示 + 編集ボタン */}
                              {parseTags(journal.tags ?? null).map((t) => (
                                <Badge
                                  key={t}
                                  variant="outline"
                                  className="text-[10px] gap-1 bg-blue-50 border-blue-200 text-blue-700"
                                >
                                  <Tag className="h-3 w-3" />
                                  {t}
                                </Badge>
                              ))}
                              <button
                                type="button"
                                onClick={() => setTagEditFor(journal.id)}
                                className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
                                title="タグを編集"
                              >
                                <Tag className="h-3 w-3" />
                                {parseTags(journal.tags ?? null).length === 0 ? "+ タグ" : "編集"}
                              </button>
                            </div>
                          </TableCell>
                        </>
                      ) : null}
                      <TableCell>
                        <span className="text-xs text-muted-foreground mr-1">
                          {line.account_code}
                        </span>
                        {line.account_name}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {line.debit_amount > 0
                          ? formatCurrency(line.debit_amount)
                          : ""}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {line.credit_amount > 0
                          ? formatCurrency(line.credit_amount)
                          : ""}
                      </TableCell>
                      {lineIndex === 0 ? (
                        <TableCell
                          rowSpan={journal.journal_lines.length}
                          className="align-top"
                        >
                          <div className="flex gap-1">
                            <Link href={`/journals/edit/?id=${journal.id}`}>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                            </Link>
                            {/* ㊂ 受信箱由来の仕訳に限り「受信箱に戻す」を出す。
                                単純削除と違って imported_receipt_id を逆引いて
                                photo_inbox を candidate に戻すため、誤仕訳の
                                やり直しがここから 1 クリックで完結する。 */}
                            {journal.receipt_id && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleReverseToInbox(journal.id)}
                                className="h-8 w-8 p-0"
                                title="受信箱に戻して再仕訳する"
                              >
                                <Undo2 className="h-3 w-3" />
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(journal.id)}
                              className="h-8 w-8 p-0"
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {filteredJournals.length}件中 {page * PAGE_SIZE + 1}〜{Math.min((page + 1) * PAGE_SIZE, filteredJournals.length)}件
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
            >
              前へ
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
            >
              次へ
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Round 21 ⓒ: 仕訳タグ編集モーダル.
 * - chip 形式で表示 / 個別 ✕ で削除
 * - フリー入力で新規追加
 * - SUGGESTED_TAGS から候補をクリック追加
 */
function TagEditModal({
  journalId: _journalId,
  initial,
  description,
  onSave,
  onClose,
}: {
  journalId: string;
  initial: string[];
  description: string;
  onSave: (tags: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [tags, setTags] = useState<string[]>(initial);
  const [input, setInput] = useState("");

  const addTag = (t: string) => {
    const trimmed = t.trim();
    if (!trimmed || trimmed.length > 30) return;
    if (tags.includes(trimmed)) return;
    setTags([...tags, trimmed]);
    setInput("");
  };

  const removeTag = (t: string) => {
    setTags(tags.filter((x) => x !== t));
  };

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg shadow-xl max-w-md w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-bold">タグを編集</h2>
          <p className="text-xs text-muted-foreground truncate">{description}</p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">タグはまだありません</p>
          ) : (
            tags.map((t) => (
              <Badge
                key={t}
                variant="outline"
                className="gap-1 bg-blue-50 border-blue-200 text-blue-700"
              >
                <Tag className="h-3 w-3" />
                {t}
                <button
                  type="button"
                  onClick={() => removeTag(t)}
                  className="ml-1 hover:text-red-600"
                  aria-label={`${t} を削除`}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </Badge>
            ))
          )}
        </div>

        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTag(input);
              }
            }}
            placeholder="新しいタグを入力 (Enter で追加)"
            className="flex-1 text-sm"
          />
          <Button size="sm" variant="outline" onClick={() => addTag(input)}>
            追加
          </Button>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1.5">候補:</p>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_TAGS.filter((s) => !tags.includes(s)).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => addTag(s)}
                className="text-[11px] px-2 py-0.5 border rounded hover:bg-muted"
              >
                + {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button onClick={() => void onSave(tags)}>保存</Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Round 22 ㊛: 複数選択 → タグ一括追加用モーダル.
 * - SUGGESTED_TAGS のチップを並べてクリックでバスケットに入れる
 * - フリー入力で追加もできる
 * - 「追加」ボタンで bulkUpdateJournalTags("add") を発火
 */
function BulkTagModal({
  count,
  onAdd,
  onClose,
}: {
  count: number;
  onAdd: (tags: string[]) => void;
  onClose: () => void;
}) {
  const [basket, setBasket] = useState<string[]>([]);
  const [input, setInput] = useState("");

  const addToBasket = (t: string) => {
    const trimmed = t.trim();
    if (!trimmed || trimmed.length > 30) return;
    if (basket.includes(trimmed)) return;
    setBasket([...basket, trimmed]);
    setInput("");
  };

  const removeFromBasket = (t: string) => {
    setBasket(basket.filter((x) => x !== t));
  };

  return (
    <div
      className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg shadow-xl max-w-md w-full p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-lg font-bold">タグを一括追加</h2>
          <p className="text-xs text-muted-foreground">
            {count} 件の仕訳に下記のタグを追加します
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5 min-h-[40px] p-2 border rounded">
          {basket.length === 0 ? (
            <p className="text-xs text-muted-foreground self-center">
              候補からチップを追加するか、下に直接入力
            </p>
          ) : (
            basket.map((t) => (
              <Badge
                key={t}
                variant="outline"
                className="gap-1 bg-blue-50 border-blue-200 text-blue-700"
              >
                <Tag className="h-3 w-3" />
                {t}
                <button
                  type="button"
                  onClick={() => removeFromBasket(t)}
                  className="ml-1 hover:text-red-600"
                  aria-label={`${t} を削除`}
                >
                  <XIcon className="h-3 w-3" />
                </button>
              </Badge>
            ))
          )}
        </div>

        <div className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addToBasket(input);
              }
            }}
            placeholder="新しいタグを入力 (Enter で追加)"
            className="flex-1 text-sm"
          />
          <Button size="sm" variant="outline" onClick={() => addToBasket(input)}>
            候補に追加
          </Button>
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-1.5">候補:</p>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_TAGS.filter((s) => !basket.includes(s)).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => addToBasket(s)}
                className="text-[11px] px-2 py-0.5 border rounded hover:bg-muted"
              >
                + {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            キャンセル
          </Button>
          <Button
            onClick={() => onAdd(basket)}
            disabled={basket.length === 0}
          >
            {count} 件に追加
          </Button>
        </div>
      </div>
    </div>
  );
}
