"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { JournalForm, type JournalLineInput } from "@/components/journal-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { rejournalize } from "@/lib/auto-journal";
import { toast } from "@/lib/toast";

function EditInner() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id");
  const [loading, setLoading] = useState(true);
  const [initialData, setInitialData] = useState<{
    date: string;
    description: string;
    lines: JournalLineInput[];
  } | null>(null);
  // ㉭ Round 12: 受信箱由来 (receipt_id 紐付き) の仕訳のみ「再仕訳化」を出す
  const [hasReceipt, setHasReceipt] = useState(false);
  const [rejournalizing, setRejournalizing] = useState(false);

  // 再仕訳化ボタンのハンドラ
  async function handleRejournalize() {
    if (!id || rejournalizing) return;
    const ok = window.confirm(
      "現在の仕訳と領収書を削除し、写真を受信箱に戻して AI OCR で再度仕訳化します。\n\n" +
        "(誤操作の場合は、仕訳帳の「直近の差し戻しを取り消す」で復元できます)\n\n" +
        "続行しますか?",
    );
    if (!ok) return;
    setRejournalizing(true);
    try {
      await rejournalize(id);
      toast.success("AI OCR で再仕訳化しました");
      router.push("/journals");
    } catch (e) {
      toast.error(`再仕訳化に失敗: ${(e as Error).message}`);
      setRejournalizing(false);
    }
  }

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    (async () => {
      const { data: journal } = await supabase
        .from("journals")
        .select("*")
        .eq("id", id)
        .single();
      if (!journal) {
        setLoading(false);
        return;
      }
      const { data: lines } = await supabase
        .from("journal_lines")
        .select("*")
        .eq("journal_id", id);

      setInitialData({
        date: journal.date,
        description: journal.description,
        lines: (lines || []).map((l: any) => ({
          account_code: l.account_code,
          account_name: l.account_name,
          debit_amount: l.debit_amount,
          credit_amount: l.credit_amount,
          tax_code: l.tax_code || "OUT",
          tax_amount: l.tax_amount || 0,
          partner_id: l.partner_id || null,
          memo: l.memo || null,
        })),
      });
      setHasReceipt(!!journal.receipt_id);
      setLoading(false);
    })();
  }, [id]);

  const handleSubmit = async (data: {
    date: string;
    description: string;
    lines: JournalLineInput[];
  }) => {
    if (!id) return;

    // ヘッダー更新
    await supabase
      .from("journals")
      .update({ date: data.date, description: data.description })
      .eq("id", id);

    // 既存明細を削除して再挿入
    await supabase.from("journal_lines").delete().eq("journal_id", id);

    const lineRecords = data.lines.map((line) => ({
      journal_id: id,
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

  if (loading) {
    return <div className="text-center py-12 text-muted-foreground">読み込み中...</div>;
  }

  if (!initialData) {
    return <div className="text-center py-12 text-muted-foreground">仕訳が見つかりません</div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4 flex-wrap">
        <Link href="/journals">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">仕訳を編集</h1>
        {/* ㉭ Round 12: 受信箱由来の仕訳のみに「AI OCR で再仕訳化」を出す.
            押すと journal+receipt 削除 → photo_inbox を receipt 状態に戻し →
            autoJournalizeOne で再仕訳。誤操作の救済は仕訳帳の Undo で。 */}
        {hasReceipt && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRejournalize}
            disabled={rejournalizing}
            className="ml-auto"
            title="現在の仕訳を破棄して、AI OCR で再度仕訳化する"
          >
            <Wand2 className={`h-4 w-4 mr-1 ${rejournalizing ? "animate-pulse" : ""}`} />
            {rejournalizing ? "再仕訳化中..." : "AI OCR で再仕訳化"}
          </Button>
        )}
      </div>

      {/* ㉝ Round 9: auto 分割サマリー — memo に「自動分割」を含む借方 line が
          複数ある時、何がどの基準で分けられたか summary card で見せる */}
      <AutoSplitSummary lines={initialData.lines} />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">仕訳の編集</CardTitle>
        </CardHeader>
        <CardContent>
          <JournalForm onSubmit={handleSubmit} initialData={initialData} />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Round 9 ㉝: 自動分割された仕訳をハイライト表示する小さなカード。
 *
 * memo に "自動分割" が含まれる借方 line が 2 つ以上あれば「自動分割の内訳」
 * カードを出す。価格按分 / 件数按分の区別、各勘定科目の amount、共通品目を
 * 1 か所にまとめて表示するので、編集中ユーザは「なぜこの仕訳が複数行なのか」
 * が一目で分かる。
 */
function AutoSplitSummary({ lines }: { lines: JournalLineInput[] }) {
  const splitLines = lines.filter(
    (l) => l.memo && /^自動分割/.test(l.memo) && (l.debit_amount ?? 0) > 0,
  );
  if (splitLines.length < 2) return null;

  // 按分方式: memo 文字列に「価格按分」が含まれていれば price、件数按分なら count
  const method = splitLines.some((l) => l.memo?.includes("価格按分"))
    ? ("price" as const)
    : ("count" as const);

  const total = splitLines.reduce((acc, l) => acc + (l.debit_amount ?? 0), 0);

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          自動分割の内訳
          <Badge variant="secondary" className="text-[10px] font-normal">
            {method === "price" ? "価格按分" : "件数按分"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-1 text-xs">
          {splitLines.map((l, i) => {
            const ratio = total > 0 ? Math.round(((l.debit_amount ?? 0) / total) * 100) : 0;
            return (
              <li key={i} className="flex items-baseline gap-2">
                <span className="font-mono text-muted-foreground w-12 text-right">{ratio}%</span>
                <span className="font-medium min-w-[7em]">{l.account_name}</span>
                <span className="font-mono tabular-nums">¥{(l.debit_amount ?? 0).toLocaleString()}</span>
                {l.memo && (
                  <span className="text-muted-foreground text-[10px] truncate">
                    {l.memo.replace(/^自動分割\s*\(/, "(")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[10px] text-muted-foreground">
          合計 ¥{total.toLocaleString()}。誤判定があれば下のフォームから直接編集できます。
        </p>
      </CardContent>
    </Card>
  );
}

export default function EditJournalPage() {
  return (
    <Suspense fallback={<div className="text-center py-12 text-muted-foreground">読み込み中...</div>}>
      <EditInner />
    </Suspense>
  );
}
