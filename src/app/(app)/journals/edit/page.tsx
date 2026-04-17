"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { JournalForm, type JournalLineInput } from "@/components/journal-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

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
      <div className="flex items-center gap-4">
        <Link href="/journals">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">仕訳を編集</h1>
      </div>

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

export default function EditJournalPage() {
  return (
    <Suspense fallback={<div className="text-center py-12 text-muted-foreground">読み込み中...</div>}>
      <EditInner />
    </Suspense>
  );
}
