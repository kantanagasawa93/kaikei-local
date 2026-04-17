"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Zap } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { DEFAULT_ACCOUNTS, getAccountByCode } from "@/lib/accounts";
import { TAX_CLASSES } from "@/lib/tax-classes";
import type { AutoRule, BankAccount } from "@/types";

const emptyForm = {
  bank_account_id: "",
  is_income: "any" as "any" | "yes" | "no",
  match_text: "",
  match_type: "contains" as const,
  amount_min: "",
  amount_max: "",
  priority: 0,
  action_type: "suggest_journal" as const,
  account_code: "",
  tax_code: "P10",
};

export default function AutoRulesPage() {
  const [rules, setRules] = useState<AutoRule[]>([]);
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const [rulesRes, accountsRes] = await Promise.all([
      supabase.from("auto_rules").select("*").order("priority", { ascending: false }),
      supabase.from("bank_accounts").select("*"),
    ]);
    if (rulesRes.data) setRules(rulesRes.data);
    if (accountsRes.data) setAccounts(accountsRes.data);
  }

  async function handleAdd() {
    if (!form.match_text || !form.account_code) return;
    const account = getAccountByCode(form.account_code);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || !account) return;
    await supabase.from("auto_rules").insert({
      user_id: user.id,
      bank_account_id: form.bank_account_id || null,
      is_income:
        form.is_income === "any" ? null : form.is_income === "yes",
      match_text: form.match_text,
      match_type: form.match_type,
      amount_min: form.amount_min ? parseInt(form.amount_min, 10) : null,
      amount_max: form.amount_max ? parseInt(form.amount_max, 10) : null,
      priority: form.priority,
      action_type: form.action_type,
      account_code: form.account_code,
      account_name: account.name,
      tax_code: form.tax_code,
    });
    setForm(emptyForm);
    setOpen(false);
    load();
  }

  async function handleDelete(id: string) {
    await supabase.from("auto_rules").delete().eq("id", id);
    load();
  }

  async function handleToggle(id: string, is_enabled: boolean) {
    await supabase.from("auto_rules").update({ is_enabled }).eq("id", id);
    load();
  }

  const filtered = rules.filter(
    (r) =>
      !search || r.match_text.toLowerCase().includes(search.toLowerCase())
  );

  const accountName = (id: string | null) =>
    id ? accounts.find((a) => a.id === id)?.name || "-" : "すべて";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">自動登録ルール</h1>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          新規作成
        </Button>
      </div>

      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          明細の取引内容に一致するルールを設定すると、取り込んだ明細に対して勘定科目・税区分を自動提案します。
          <br />
          <b>正答率</b> は提案が採用された割合。低いルールは条件を見直してください。
        </CardContent>
      </Card>

      <Input
        placeholder="マッチ文字列で検索"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Zap className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">ルールがまだ登録されていません。</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>有効</TableHead>
                  <TableHead>収支</TableHead>
                  <TableHead>口座</TableHead>
                  <TableHead>マッチ条件</TableHead>
                  <TableHead>優先度</TableHead>
                  <TableHead>推測結果</TableHead>
                  <TableHead className="text-right">適用</TableHead>
                  <TableHead className="text-right">正答率</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => {
                  const accuracy =
                    r.applied_count > 0
                      ? Math.round((r.accepted_count / r.applied_count) * 100)
                      : null;
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={r.is_enabled}
                          onChange={(e) => handleToggle(r.id, e.target.checked)}
                        />
                      </TableCell>
                      <TableCell>
                        {r.is_income === null ? (
                          <span className="text-xs text-muted-foreground">-</span>
                        ) : (
                          <Badge variant={r.is_income ? "default" : "secondary"} className="text-xs">
                            {r.is_income ? "入金" : "出金"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {accountName(r.bank_account_id)}
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">
                          <span className="text-xs text-muted-foreground">
                            {r.match_type === "contains"
                              ? "部分一致"
                              : r.match_type === "starts"
                                ? "前方一致"
                                : r.match_type === "equals"
                                  ? "完全一致"
                                  : "正規表現"}
                            :
                          </span>{" "}
                          {r.match_text}
                        </div>
                        {(r.amount_min || r.amount_max) && (
                          <div className="text-xs text-muted-foreground">
                            金額: {r.amount_min?.toLocaleString() || "-"} 〜{" "}
                            {r.amount_max?.toLocaleString() || "-"}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{r.priority}</TableCell>
                      <TableCell>
                        <div className="text-sm">{r.account_name}</div>
                        {r.tax_code && (
                          <div className="text-xs text-muted-foreground">
                            {TAX_CLASSES.find((t) => t.code === r.tax_code)?.name}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {r.applied_count}件
                      </TableCell>
                      <TableCell className="text-right text-sm">
                        {accuracy !== null ? `${accuracy}%` : "-"}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(r.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>自動登録ルール</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>マッチする文字列 *</Label>
              <Input
                value={form.match_text}
                onChange={(e) => setForm({ ...form, match_text: e.target.value })}
                placeholder="例: ヤマト運輸"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>マッチ方法</Label>
                <Select
                  value={form.match_type}
                  onValueChange={(v) =>
                    v && setForm({ ...form, match_type: v as typeof form.match_type })
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {{
                        contains: "部分一致",
                        starts: "前方一致",
                        equals: "完全一致",
                        regex: "正規表現",
                      }[form.match_type]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contains">部分一致</SelectItem>
                    <SelectItem value="starts">前方一致</SelectItem>
                    <SelectItem value="equals">完全一致</SelectItem>
                    <SelectItem value="regex">正規表現</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>収支</Label>
                <Select
                  value={form.is_income}
                  onValueChange={(v) =>
                    v && setForm({ ...form, is_income: v as typeof form.is_income })
                  }
                >
                  <SelectTrigger>
                    <SelectValue>
                      {{ any: "両方", yes: "入金のみ", no: "出金のみ" }[form.is_income]}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">両方</SelectItem>
                    <SelectItem value="yes">入金のみ</SelectItem>
                    <SelectItem value="no">出金のみ</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>金額（下限）</Label>
                <Input
                  type="number"
                  value={form.amount_min}
                  onChange={(e) => setForm({ ...form, amount_min: e.target.value })}
                />
              </div>
              <div>
                <Label>金額（上限）</Label>
                <Input
                  type="number"
                  value={form.amount_max}
                  onChange={(e) => setForm({ ...form, amount_max: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>対象口座</Label>
              <Select
                value={form.bank_account_id || "__all__"}
                onValueChange={(v) =>
                  v && setForm({ ...form, bank_account_id: v === "__all__" ? "" : v })
                }
              >
                <SelectTrigger>
                  <SelectValue>
                    {form.bank_account_id
                      ? accounts.find((a) => a.id === form.bank_account_id)?.name ?? "すべての口座"
                      : "すべての口座"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">すべての口座</SelectItem>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>推測する勘定科目 *</Label>
                <Select
                  value={form.account_code}
                  onValueChange={(v) => v && setForm({ ...form, account_code: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="科目を選択">
                      {DEFAULT_ACCOUNTS.find((a) => a.code === form.account_code)?.name ?? "科目を選択"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {DEFAULT_ACCOUNTS.map((a) => (
                      <SelectItem key={a.code} value={a.code}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>税区分</Label>
                <Select
                  value={form.tax_code}
                  onValueChange={(v) => v && setForm({ ...form, tax_code: v })}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {TAX_CLASSES.find((t) => t.code === form.tax_code)?.name ?? form.tax_code}
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
            </div>
            <div>
              <Label>優先度</Label>
              <Input
                type="number"
                value={form.priority}
                onChange={(e) =>
                  setForm({ ...form, priority: parseInt(e.target.value, 10) || 0 })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={handleAdd}
              disabled={!form.match_text || !form.account_code}
            >
              登録
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
