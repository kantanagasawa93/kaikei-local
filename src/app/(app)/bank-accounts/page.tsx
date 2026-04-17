"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Landmark, CreditCard, Trash2 } from "lucide-react";
import type { BankAccount } from "@/types";

export default function BankAccountsPage() {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountType, setAccountType] = useState<"bank" | "credit_card">("bank");
  const [last4, setLast4] = useState("");

  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    const { data } = await supabase
      .from("bank_accounts")
      .select("*")
      .order("created_at", { ascending: false });
    if (data) setAccounts(data);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    await supabase.from("bank_accounts").insert({
      user_id: user.id,
      name,
      bank_name: bankName,
      account_type: accountType,
      account_number_last4: last4 || null,
    });

    setName("");
    setBankName("");
    setLast4("");
    setDialogOpen(false);
    loadAccounts();
  }

  async function handleDelete(id: string) {
    if (!confirm("この口座を削除しますか？関連する明細も全て削除されます。")) return;
    await supabase.from("bank_accounts").delete().eq("id", id);
    setAccounts((prev) => prev.filter((a) => a.id !== id));
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(amount);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">口座・クレカ管理</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-9 px-4 py-2 cursor-pointer">
            <Plus className="h-4 w-4" />
            口座を追加
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>口座を追加</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleCreate} className="space-y-4">
              <div className="space-y-2">
                <Label>種別</Label>
                <Select value={accountType} onValueChange={(v) => v && setAccountType(v as "bank" | "credit_card")}>
                  <SelectTrigger>
                    <SelectValue>
                      {accountType === "bank" ? "銀行口座" : "クレジットカード"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bank">銀行口座</SelectItem>
                    <SelectItem value="credit_card">クレジットカード</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>口座名</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例: メイン口座、事業用口座"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>{accountType === "bank" ? "銀行名" : "カード会社"}</Label>
                <Input
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder={accountType === "bank" ? "例: 三菱UFJ銀行" : "例: 楽天カード"}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>口座番号/カード番号（下4桁）</Label>
                <Input
                  value={last4}
                  onChange={(e) => setLast4(e.target.value)}
                  placeholder="1234"
                  maxLength={4}
                />
              </div>
              <Button type="submit" className="w-full">追加</Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {accounts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Landmark className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">口座がまだ登録されていません</p>
            <p className="text-sm text-muted-foreground mt-1">
              銀行口座やクレジットカードを追加して、明細を取り込みましょう
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {accounts.map((account) => (
            <Card key={account.id}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="flex items-center gap-2">
                  {account.account_type === "bank" ? (
                    <Landmark className="h-5 w-5 text-blue-600" />
                  ) : (
                    <CreditCard className="h-5 w-5 text-purple-600" />
                  )}
                  <CardTitle className="text-base">{account.name}</CardTitle>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(account.id)}
                  className="h-8 w-8 p-0"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{account.bank_name}</p>
                {account.account_number_last4 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    ****{account.account_number_last4}
                  </p>
                )}
                <div className="flex items-center justify-between mt-3">
                  <p className="text-lg font-bold">{formatCurrency(account.balance)}</p>
                  <Badge variant={account.account_type === "bank" ? "secondary" : "outline"}>
                    {account.account_type === "bank" ? "銀行" : "クレカ"}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
