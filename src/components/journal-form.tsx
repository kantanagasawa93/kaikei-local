"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AccountSelect } from "@/components/account-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { TAX_CLASSES, suggestTaxCodeForAccount, extractTaxFromIncluded } from "@/lib/tax-classes";
import { getAccountByCode } from "@/lib/accounts";
import { supabase } from "@/lib/supabase";
import type { Partner } from "@/types";

export interface JournalLineInput {
  account_code: string;
  account_name: string;
  debit_amount: number;
  credit_amount: number;
  tax_code: string | null;
  tax_amount: number;
  partner_id: string | null;
  memo: string | null;
}

interface JournalFormProps {
  onSubmit: (data: {
    date: string;
    description: string;
    lines: JournalLineInput[];
  }) => Promise<void>;
  initialData?: {
    date?: string;
    description?: string;
    lines?: JournalLineInput[];
  };
}

function emptyLine(): JournalLineInput {
  return {
    account_code: "",
    account_name: "",
    debit_amount: 0,
    credit_amount: 0,
    tax_code: "OUT",
    tax_amount: 0,
    partner_id: null,
    memo: null,
  };
}

export function JournalForm({ onSubmit, initialData }: JournalFormProps) {
  const [date, setDate] = useState(
    initialData?.date || new Date().toISOString().split("T")[0]
  );
  const [description, setDescription] = useState(initialData?.description || "");
  const [lines, setLines] = useState<JournalLineInput[]>(
    initialData?.lines || [emptyLine(), emptyLine()]
  );
  const [partners, setPartners] = useState<Partner[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase
      .from("partners")
      .select("*")
      .order("name")
      .then(({ data }) => {
        if (data) setPartners(data);
      });
  }, []);

  const updateLine = (index: number, updates: Partial<JournalLineInput>) => {
    setLines((prev) =>
      prev.map((line, i) => {
        if (i !== index) return line;
        const merged = { ...line, ...updates };
        // 勘定科目が変わったら税区分を推測
        if (updates.account_code && updates.account_code !== line.account_code) {
          const acc = getAccountByCode(updates.account_code);
          if (acc) {
            merged.tax_code = suggestTaxCodeForAccount(acc.category, acc.code);
          }
        }
        // 金額/税区分が変わったら内税で税額を逆算
        const amount = merged.debit_amount || merged.credit_amount;
        merged.tax_amount = extractTaxFromIncluded(amount, merged.tax_code);
        return merged;
      })
    );
  };

  const addLine = () => {
    setLines((prev) => [...prev, emptyLine()]);
  };

  const removeLine = (index: number) => {
    if (lines.length <= 2) return;
    setLines((prev) => prev.filter((_, i) => i !== index));
  };

  const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0);
  const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0);
  const isBalanced = totalDebit === totalCredit && totalDebit > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isBalanced) return;
    setSaving(true);
    try {
      await onSubmit({ date, description, lines });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>日付</Label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <Label>摘要</Label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="取引の説明"
            required
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-base">仕訳明細</Label>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="h-3 w-3 mr-1" />
            行を追加
          </Button>
        </div>

        <div className="space-y-3">
          {lines.map((line, index) => (
            <div key={index} className="grid grid-cols-12 gap-2 items-start border rounded-lg p-3">
              <div className="col-span-12 md:col-span-4 space-y-1">
                <Label className="text-xs text-muted-foreground">勘定科目</Label>
                <AccountSelect
                  value={line.account_code}
                  onValueChange={(code, name) =>
                    updateLine(index, { account_code: code, account_name: name })
                  }
                  placeholder="科目を選択"
                />
              </div>
              <div className="col-span-6 md:col-span-2 space-y-1">
                <Label className="text-xs text-muted-foreground">税区分</Label>
                <Select
                  value={line.tax_code || "OUT"}
                  onValueChange={(v) => v && updateLine(index, { tax_code: v })}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue>
                      {TAX_CLASSES.find((t) => t.code === (line.tax_code || "OUT"))?.name ?? (line.tax_code || "OUT")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {TAX_CLASSES.map((t) => (
                      <SelectItem key={t.code} value={t.code}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-6 md:col-span-2 space-y-1">
                <Label className="text-xs text-muted-foreground">取引先</Label>
                <Select
                  value={line.partner_id || "__none__"}
                  onValueChange={(v) =>
                    v && updateLine(index, { partner_id: v === "__none__" ? null : v })
                  }
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="なし">
                      {line.partner_id
                        ? partners.find((p) => p.id === line.partner_id)?.name ?? "なし"
                        : "（なし）"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">（なし）</SelectItem>
                    {partners.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-6 md:col-span-2 space-y-1">
                <Label className="text-xs text-muted-foreground">借方</Label>
                <Input
                  type="number"
                  value={line.debit_amount || ""}
                  onChange={(e) =>
                    updateLine(index, {
                      debit_amount: parseInt(e.target.value, 10) || 0,
                    })
                  }
                  placeholder="0"
                  className="text-right"
                />
              </div>
              <div className="col-span-6 md:col-span-2 space-y-1">
                <Label className="text-xs text-muted-foreground">貸方</Label>
                <div className="flex gap-1">
                  <Input
                    type="number"
                    value={line.credit_amount || ""}
                    onChange={(e) =>
                      updateLine(index, {
                        credit_amount: parseInt(e.target.value, 10) || 0,
                      })
                    }
                    placeholder="0"
                    className="text-right"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeLine(index)}
                    disabled={lines.length <= 2}
                    className="h-9 w-9 p-0 shrink-0"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
              {line.tax_amount > 0 && (
                <div className="col-span-12 text-xs text-muted-foreground text-right">
                  うち消費税 {line.tax_amount.toLocaleString()}円
                </div>
              )}
              <div className="col-span-12">
                <Input
                  value={line.memo || ""}
                  onChange={(e) => updateLine(index, { memo: e.target.value || null })}
                  placeholder="メモ（任意）"
                  className="h-8 text-sm"
                />
              </div>
            </div>
          ))}

          {/* 合計行 */}
          <div className="grid grid-cols-12 gap-2 pt-2 border-t font-medium">
            <div className="col-span-4 text-sm">合計</div>
            <div className="col-span-4 text-right text-sm">
              借方 {totalDebit.toLocaleString()}
            </div>
            <div className="col-span-4 text-right text-sm">
              貸方 {totalCredit.toLocaleString()}
            </div>
          </div>

          {!isBalanced && totalDebit + totalCredit > 0 && (
            <p className="text-sm text-destructive">
              借方と貸方の合計が一致しません（差額:{" "}
              {Math.abs(totalDebit - totalCredit).toLocaleString()}円）
            </p>
          )}
        </div>
      </div>

      <Button type="submit" disabled={saving || !isBalanced} className="w-full">
        {saving ? "保存中..." : "仕訳を登録"}
      </Button>
    </form>
  );
}
