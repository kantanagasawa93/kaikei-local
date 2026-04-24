"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Upload, Check, X, CreditCard } from "lucide-react";
import { type ParsedTransaction } from "@/lib/csv-import";
import { parseBankOrCardCsvBytes } from "@/lib/bank-csv";
import { toast } from "@/lib/toast";
import { findAccountCodeByName, getAccountByCode } from "@/lib/accounts";
import { findMatchingRule, recordRuleApplication } from "@/lib/auto-rules";
import type { BankAccount, BankTransaction } from "@/types";

export default function TransactionsPage() {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [parsedData, setParsedData] = useState<ParsedTransaction[]>([]);
  const [importing, setImporting] = useState(false);
  const [monthFilter, setMonthFilter] = useState("");

  useEffect(() => {
    loadBankAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) loadTransactions();
  }, [selectedAccountId]);

  async function loadBankAccounts() {
    const { data } = await supabase.from("bank_accounts").select("*").order("created_at");
    if (data) {
      setBankAccounts(data);
      if (data.length > 0 && !selectedAccountId) {
        setSelectedAccountId(data[0].id);
      }
    }
  }

  async function loadTransactions() {
    const { data } = await supabase
      .from("bank_transactions")
      .select("*")
      .eq("bank_account_id", selectedAccountId)
      .order("date", { ascending: false });
    if (data) setTransactions(data);
  }

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Shift_JIS 対応のため ArrayBuffer で読み取って parseBankOrCardCsvBytes に渡す
    const bytes = await file.arrayBuffer();
    const account = bankAccounts.find((a) => a.id === selectedAccountId);
    const kind: "bank" | "card" =
      account?.account_type === "credit_card" ? "card" : "bank";
    const result = parseBankOrCardCsvBytes(bytes, kind);
    setParsedData(result.transactions);

    const encLabel = result.encoding === "shift_jis" ? " [Shift_JIS 自動変換]" : "";
    if (result.transactions.length === 0) {
      toast.error("CSV を解釈できませんでした。対応銀行の形式か確認してください。");
    } else if (result.fallback) {
      toast.info(
        `汎用パーサで ${result.transactions.length} 件を読み込みました${encLabel}。銀行自動判別に失敗したので取引先名が一部崩れる可能性があります。`
      );
    } else {
      toast.success(
        `${result.bankName} として ${result.transactions.length} 件を読み込みました${encLabel}。`
      );
    }
  }, [bankAccounts, selectedAccountId]);

  async function handleImport() {
    if (!selectedAccountId || parsedData.length === 0) return;
    setImporting(true);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const records = parsedData.map((t) => ({
      bank_account_id: selectedAccountId,
      user_id: user.id,
      date: t.date,
      description: t.description,
      amount: t.amount,
      balance_after: t.balance_after,
      is_income: t.is_income,
      category: t.suggested_account_name,
      status: "unmatched" as const,
    }));

    await supabase.from("bank_transactions").insert(records);
    setParsedData([]);
    loadTransactions();
    setImporting(false);
  }

  async function handleCreateJournal(transaction: BankTransaction) {
    const account = bankAccounts.find((a) => a.id === transaction.bank_account_id);
    const isBank = account?.account_type === "bank";

    // 自動登録ルールで推測
    const matched = await findMatchingRule(transaction);

    // 仕訳作成
    const { data: journal } = await supabase
      .from("journals")
      .insert({
        date: transaction.date,
        description: transaction.description,
      })
      .select()
      .single();

    if (!journal) return;

    if (transaction.is_income) {
      // 入金: 借方=普通預金、貸方=売上
      const revCode = matched?.action_type === "suggest_journal" ? matched.account_code || "400" : "400";
      const revName = matched?.account_name || "売上高";
      const taxCode = matched?.tax_code || "S10";
      const taxAmount = Math.floor((transaction.amount * 10) / 110);
      await supabase.from("journal_lines").insert([
        { journal_id: journal.id, account_code: "110", account_name: "普通預金", debit_amount: transaction.amount, credit_amount: 0, tax_code: "OUT", tax_amount: 0 },
        { journal_id: journal.id, account_code: revCode, account_name: revName, debit_amount: 0, credit_amount: transaction.amount, tax_code: taxCode, tax_amount: taxAmount },
      ]);
    } else {
      // 出金: 借方=経費科目、貸方=普通預金 or 未払金(クレカ)
      const creditAccount = isBank
        ? { code: "110", name: "普通預金" }
        : { code: "210", name: "未払金" };

      // ルール > suggestAccount から来た科目名 > 雑費 の優先順位
      let expenseCode: string = "699";
      let expenseName: string = "雑費";
      let taxCode: string = "P10";
      if (matched?.account_code) {
        expenseCode = matched.account_code;
        expenseName = matched.account_name || getAccountByCode(matched.account_code)?.name || "雑費";
        if (matched.tax_code) taxCode = matched.tax_code;
      } else if (transaction.category) {
        expenseCode = findAccountCodeByName(transaction.category) || "699";
        expenseName = transaction.category || "雑費";
      }

      await supabase.from("journal_lines").insert([
        { journal_id: journal.id, account_code: expenseCode, account_name: expenseName, debit_amount: transaction.amount, credit_amount: 0, tax_code: taxCode, tax_amount: Math.floor((transaction.amount * 10) / 110) },
        { journal_id: journal.id, account_code: creditAccount.code, account_name: creditAccount.name, debit_amount: 0, credit_amount: transaction.amount, tax_code: "OUT", tax_amount: 0 },
      ]);
    }

    // ステータス更新
    await supabase
      .from("bank_transactions")
      .update({ status: "matched", journal_id: journal.id })
      .eq("id", transaction.id);

    // ルール採用履歴を記録（ユーザが明示的に仕訳作成 = 採用）
    if (matched) {
      await recordRuleApplication(matched.id, transaction.id, true);
    }

    loadTransactions();
  }

  async function handleIgnoreWithRuleReject(tx: BankTransaction) {
    const matched = await findMatchingRule(tx);
    if (matched) {
      await recordRuleApplication(matched.id, tx.id, false);
    }
    await handleIgnore(tx.id);
  }

  async function handleIgnore(id: string) {
    await supabase.from("bank_transactions").update({ status: "ignored" }).eq("id", id);
    loadTransactions();
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(amount);

  const filteredTransactions = transactions.filter(
    (t) => !monthFilter || t.date.startsWith(monthFilter)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">明細取込</h1>
      </div>

      {/* 口座選択 + CSVインポート */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">CSV取込</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4">
            <div className="flex-1">
              <Select value={selectedAccountId} onValueChange={(v) => v && setSelectedAccountId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="口座を選択" />
                </SelectTrigger>
                <SelectContent>
                  {bankAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} ({a.bank_name})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Input
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="w-64"
              />
            </div>
          </div>

          {parsedData.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {parsedData.length}件の取引を検出しました
              </p>
              <div className="max-h-60 overflow-y-auto border rounded-lg">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>日付</TableHead>
                      <TableHead>摘要</TableHead>
                      <TableHead className="text-right">金額</TableHead>
                      <TableHead>推定科目</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parsedData.slice(0, 20).map((t, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs">{t.date}</TableCell>
                        <TableCell className="text-sm">{t.description}</TableCell>
                        <TableCell className={`text-right text-sm ${t.is_income ? "text-green-600" : ""}`}>
                          {t.is_income ? "+" : "-"}{formatCurrency(t.amount)}
                        </TableCell>
                        <TableCell>
                          {t.suggested_account_name && (
                            <Badge variant="secondary" className="text-xs">
                              {t.suggested_account_name}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {parsedData.length > 20 && (
                <p className="text-xs text-muted-foreground">
                  他 {parsedData.length - 20}件...
                </p>
              )}
              <Button onClick={handleImport} disabled={importing}>
                <Upload className="h-4 w-4 mr-1" />
                {importing ? "取込中..." : `${parsedData.length}件を取込`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 取込済み明細 */}
      <div className="flex gap-2">
        <Input
          type="month"
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="w-44"
        />
      </div>

      {filteredTransactions.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CreditCard className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              明細がありません。CSVファイルをアップロードして取り込んでください。
            </p>
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
                  <TableHead className="text-right">金額</TableHead>
                  <TableHead>ステータス</TableHead>
                  <TableHead className="w-28">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTransactions.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="text-sm">{t.date}</TableCell>
                    <TableCell>
                      <p className="text-sm">{t.description}</p>
                      {t.category && (
                        <Badge variant="secondary" className="text-xs mt-1">
                          {t.category}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className={`text-right font-medium ${t.is_income ? "text-green-600" : ""}`}>
                      {t.is_income ? "+" : "-"}{formatCurrency(t.amount)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          t.status === "matched" ? "default" :
                          t.status === "ignored" ? "outline" : "secondary"
                        }
                      >
                        {t.status === "matched" ? "仕訳済" :
                         t.status === "ignored" ? "除外" : "未処理"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {t.status === "unmatched" && (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCreateJournal(t)}
                            className="h-7 text-xs"
                          >
                            <Check className="h-3 w-3 mr-1" />
                            仕訳
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleIgnoreWithRuleReject(t)}
                            className="h-7 text-xs"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
