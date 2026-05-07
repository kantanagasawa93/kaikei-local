"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { JournalForm, type JournalLineInput } from "@/components/journal-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Copy, History } from "lucide-react";
import Link from "next/link";
import type { Journal, JournalLine } from "@/types";

interface RecentJournal extends Journal {
  journal_lines: JournalLine[];
}

export default function NewJournalPage() {
  const router = useRouter();
  // Round 25 ㊡: 過去の仕訳から複製するためのサジェスト
  const [recentJournals, setRecentJournals] = useState<RecentJournal[]>([]);
  const [partners, setPartners] = useState<Map<string, string>>(new Map());
  // Round 26 ㊢: partner 連動フィルタ — 選択された partner の仕訳のみ表示
  const [filterPartnerId, setFilterPartnerId] = useState<string>("");
  // 複製した値を JournalForm に渡すため (key 変更で remount)
  const [seedKey, setSeedKey] = useState(0);
  const [seed, setSeed] = useState<{
    description: string;
    lines: JournalLineInput[];
  } | null>(null);

  useEffect(() => {
    void loadRecent();
  }, []);

  async function loadRecent() {
    // 過去 90 日の仕訳を最大 10 件、新しい順
    const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const { data: js } = await supabase
      .from("journals")
      .select("*, journal_lines(*)")
      .gte("date", cutoff)
      .order("date", { ascending: false })
      .limit(10);
    setRecentJournals((js as RecentJournal[] | null) ?? []);
    // partners.id → name のマップ
    const { data: ps } = await supabase.from("partners").select("id, name");
    const m = new Map<string, string>();
    for (const p of (ps as { id: string; name: string }[] | null) ?? []) {
      m.set(p.id, p.name);
    }
    setPartners(m);
  }

  function copyFromJournal(j: RecentJournal) {
    const lines: JournalLineInput[] = j.journal_lines.map((ln) => ({
      account_code: ln.account_code,
      account_name: ln.account_name,
      debit_amount: ln.debit_amount,
      credit_amount: ln.credit_amount,
      tax_code: ln.tax_code,
      tax_amount: ln.tax_amount,
      partner_id: ln.partner_id,
      memo: ln.memo,
    }));
    setSeed({ description: j.description, lines });
    setSeedKey((k) => k + 1);
    // ページ最上部に戻して JournalForm をフォーカスさせる視覚効果
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const handleSubmit = async (data: {
    date: string;
    description: string;
    lines: JournalLineInput[];
  }) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error("認証が必要です");

    const { data: journal, error } = await supabase
      .from("journals")
      .insert({
        user_id: user.id,
        date: data.date,
        description: data.description,
      })
      .select()
      .single();

    if (error) throw error;

    const lineRecords = data.lines.map((line) => ({
      journal_id: journal.id,
      account_code: line.account_code,
      account_name: line.account_name,
      debit_amount: line.debit_amount,
      credit_amount: line.credit_amount,
      tax_code: line.tax_code,
      tax_amount: line.tax_amount,
      partner_id: line.partner_id,
      memo: line.memo,
    }));

    await supabase.from("journal_lines").insert(lineRecords);

    router.push("/journals");
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Link href="/journals">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">仕訳を登録</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">新規仕訳</CardTitle>
        </CardHeader>
        <CardContent>
          <JournalForm
            key={seedKey}
            onSubmit={handleSubmit}
            initialData={seed ? {
              date: new Date().toISOString().split("T")[0],
              description: seed.description,
              lines: seed.lines,
            } : undefined}
          />
        </CardContent>
      </Card>

      {/* Round 25 ㊡ + Round 26 ㊢: 過去の仕訳から複製サジェスト + partner 連動フィルタ */}
      {recentJournals.length > 0 && (() => {
        // partner_id でフィルタ (どの行にもその partner が含まれてれば該当)
        const visible = filterPartnerId
          ? recentJournals.filter((j) =>
              j.journal_lines.some((ln) => ln.partner_id === filterPartnerId),
            )
          : recentJournals;
        // フィルタ select 用に「過去仕訳に登場する partner」だけ取得
        const usedPartners = (() => {
          const set = new Set<string>();
          for (const j of recentJournals) {
            for (const ln of j.journal_lines) {
              if (ln.partner_id) set.add(ln.partner_id);
            }
          }
          return Array.from(set)
            .map((id) => ({ id, name: partners.get(id) ?? id }))
            .sort((a, b) => a.name.localeCompare(b.name));
        })();
        return (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2 gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <History className="h-4 w-4" />
              過去 90 日の仕訳から複製 ({visible.length}/{recentJournals.length} 件)
            </CardTitle>
            {usedPartners.length > 0 && (
              <select
                value={filterPartnerId}
                onChange={(e) => setFilterPartnerId(e.target.value)}
                className="border rounded px-2 py-1 text-xs h-8"
                title="特定の取引先の仕訳だけに絞る"
              >
                <option value="">すべての取引先</option>
                {usedPartners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              似た仕訳をクリックで上のフォームに複製できます (日付は今日に上書き)。
            </p>
            <div className="space-y-1.5">
              {visible.map((j) => {
                const partnerNames = Array.from(
                  new Set(
                    j.journal_lines
                      .map((ln) => (ln.partner_id ? partners.get(ln.partner_id) : null))
                      .filter((v): v is string => Boolean(v)),
                  ),
                );
                const totalDebit = j.journal_lines.reduce(
                  (a, ln) => a + (ln.debit_amount || 0),
                  0,
                );
                return (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => copyFromJournal(j)}
                    className="w-full text-left flex items-center gap-2 px-3 py-2
                               border rounded hover:bg-muted/40 hover:border-primary/40
                               transition-colors"
                  >
                    <Copy className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                    <span className="text-xs font-mono text-muted-foreground w-20 flex-shrink-0">
                      {j.date}
                    </span>
                    <span className="flex-1 text-sm truncate">{j.description}</span>
                    {partnerNames.length > 0 && (
                      <Badge variant="outline" className="text-[10px]">
                        {partnerNames[0]}
                        {partnerNames.length > 1 && ` +${partnerNames.length - 1}`}
                      </Badge>
                    )}
                    <span className="text-xs tabular-nums text-right w-24 flex-shrink-0">
                      ¥{totalDebit.toLocaleString()}
                    </span>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
        );
      })()}
    </div>
  );
}
