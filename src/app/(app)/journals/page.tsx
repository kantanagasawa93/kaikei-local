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
import { Plus, BookOpen, Trash2, Pencil, Image as ImageIcon, Undo2, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  reverseJournalToInbox,
  undoLastReverse,
  getReverseUndoCount,
} from "@/lib/auto-journal";
import { toast } from "@/lib/toast";
import type { Journal, JournalLine } from "@/types";

interface JournalWithLines extends Journal {
  journal_lines: JournalLine[];
  // receipt_id は Journal 側で string | null と宣言されている前提。
  // 受信箱(写真自動取込) → 自動仕訳の経路で作られた仕訳にバッジを出す。
}

const PAGE_SIZE = 50;

export default function JournalsPage() {
  const [journals, setJournals] = useState<JournalWithLines[]>([]);
  const [monthFilter, setMonthFilter] = useState("");
  const [page, setPage] = useState(0);
  // ㊍ Round 6: 直近の差し戻しを取り消せる件数 (0 なら button 非表示)
  const [undoCount, setUndoCount] = useState(0);

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

  const filteredJournals = journals.filter((j) =>
    !monthFilter || j.date.startsWith(monthFilter)
  );
  const totalPages = Math.ceil(filteredJournals.length / PAGE_SIZE);
  const pagedJournals = filteredJournals.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // フィルタ変更時にページをリセット
  useEffect(() => { setPage(0); }, [monthFilter]);

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ja-JP").format(amount);

  return (
    <div className="space-y-6">
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
          <Link href="/journals/new">
            <Button>
              <Plus className="h-4 w-4 mr-1" />
              新規仕訳
            </Button>
          </Link>
        </div>
      </div>

      <div className="flex gap-2">
        <Input
          type="month"
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="w-44"
        />
      </div>

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
                    <TableRow key={`${journal.id}-${line.id}`}>
                      {lineIndex === 0 ? (
                        <>
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
