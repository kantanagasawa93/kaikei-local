"use client";

import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { JournalForm, type JournalLineInput } from "@/components/journal-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function NewJournalPage() {
  const router = useRouter();

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
          <JournalForm onSubmit={handleSubmit} />
        </CardContent>
      </Card>
    </div>
  );
}
