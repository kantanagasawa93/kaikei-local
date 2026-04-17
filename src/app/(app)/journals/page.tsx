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
import { Plus, BookOpen, Trash2, Pencil } from "lucide-react";
import type { Journal, JournalLine } from "@/types";

interface JournalWithLines extends Journal {
  journal_lines: JournalLine[];
}

const PAGE_SIZE = 50;

export default function JournalsPage() {
  const [journals, setJournals] = useState<JournalWithLines[]>([]);
  const [monthFilter, setMonthFilter] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    loadJournals();
  }, []);

  async function loadJournals() {
    const { data } = await supabase
      .from("journals")
      .select("*, journal_lines(*)")
      .order("date", { ascending: false });
    if (data) setJournals(data);
  }

  async function handleDelete(id: string) {
    if (!confirm("この仕訳を削除しますか？")) return;
    await supabase.from("journals").delete().eq("id", id);
    setJournals((prev) => prev.filter((j) => j.id !== id));
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
        <Link href="/journals/new">
          <Button>
            <Plus className="h-4 w-4 mr-1" />
            新規仕訳
          </Button>
        </Link>
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
                            {journal.description}
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
