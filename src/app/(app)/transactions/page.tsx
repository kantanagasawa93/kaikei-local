"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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
import { findMatchingRule, recordRuleApplication } from "@/lib/auto-rules";
import {
  BankTxAlreadyHandledError,
  importBankTransactions,
  journalizeBankTransaction,
} from "@/lib/bank-journal";
import type { BankAccount, BankTransaction } from "@/types";

export default function TransactionsPage() {
  const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [parsedData, setParsedData] = useState<ParsedTransaction[]>([]);
  const [importing, setImporting] = useState(false);
  const [monthFilter, setMonthFilter] = useState("");
  // 仕訳作成の二重押し防止 (明細 id 単位)
  const busyIds = useRef<Set<string>>(new Set());

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
    if (!selectedAccountId || parsedData.length === 0 || importing) return;
    setImporting(true);
    try {
      const res = await importBankTransactions(selectedAccountId, parsedData);
      setParsedData([]);
      toast.success(
        res.skipped > 0
          ? `${res.added} 件を取り込みました（取込済みの ${res.skipped} 件は重複のため除外）`
          : `${res.added} 件を取り込みました`,
      );
    } catch (e) {
      toast.error(`取り込みに失敗しました: ${(e as Error)?.message || String(e)}`);
    } finally {
      setImporting(false);
      await loadTransactions();
    }
  }

  async function handleCreateJournal(transaction: BankTransaction) {
    if (busyIds.current.has(transaction.id)) return;
    busyIds.current.add(transaction.id);
    try {
      const account = bankAccounts.find((a) => a.id === transaction.bank_account_id);
      await journalizeBankTransaction(transaction, account);
    } catch (e) {
      if (e instanceof BankTxAlreadyHandledError) toast.info(e.message);
      else toast.error(`仕訳を作成できませんでした: ${(e as Error)?.message || String(e)}`);
    } finally {
      busyIds.current.delete(transaction.id);
      await loadTransactions();
    }
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
