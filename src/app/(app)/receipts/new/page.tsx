"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ReceiptUpload } from "@/components/receipt-upload";
import { AccountSelect } from "@/components/account-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { processReceiptImage } from "@/lib/ocr";
import { ocrWithClaude, fileToBase64, getApiKey } from "@/lib/ai-ocr";
import { supabase } from "@/lib/supabase";
import type { OcrResult } from "@/types";
import { ArrowLeft, Sparkles, Save, Zap } from "lucide-react";
import Link from "next/link";

export default function NewReceiptPage() {
  const router = useRouter();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [useAiOcr, setUseAiOcr] = useState(true);
  const [hasApiKey, setHasApiKey] = useState(false);

  const [vendorName, setVendorName] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [accountCode, setAccountCode] = useState("");
  const [accountName, setAccountName] = useState("");

  // 初期化: API キーの有無を確認
  useState(() => {
    getApiKey().then((key) => {
      setHasApiKey(!!key);
      if (!key) setUseAiOcr(false);
    });
  });

  const handleFileSelect = async (file: File) => {
    setSelectedFile(file);
    setIsProcessing(true);
    setError(null);

    try {
      let result: OcrResult;

      if (useAiOcr && hasApiKey) {
        // Claude API で高精度読み取り
        const apiKey = await getApiKey();
        if (apiKey) {
          const { base64, mediaType } = await fileToBase64(file);
          result = await ocrWithClaude(base64, mediaType, apiKey);
        } else {
          result = await processReceiptImage(file);
        }
      } else {
        // 従来の Tesseract OCR
        result = await processReceiptImage(file);
      }

      setOcrResult(result);

      if (result.vendor_name) setVendorName(result.vendor_name);
      if (result.amount) setAmount(result.amount.toString());
      if (result.date) setDate(result.date);
      if (result.suggested_account_code) {
        setAccountCode(result.suggested_account_code);
        setAccountName(result.suggested_account_name || "");
      }
    } catch (err) {
      console.error("OCR処理に失敗しました:", err);
      setError(`読み取りに失敗しました: ${(err as Error).message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSave = async () => {
    if (!selectedFile) return;
    setIsSaving(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("認証が必要です");

      // 画像をSupabase Storageにアップロード
      const fileName = `${user.id}/${Date.now()}-${selectedFile.name}`;
      const { error: uploadError } = await supabase.storage
        .from("receipts")
        .upload(fileName, selectedFile);

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from("receipts")
        .getPublicUrl(fileName);

      // 領収書レコードを保存
      const { error: insertError } = await supabase.from("receipts").insert({
        user_id: user.id,
        image_url: urlData.publicUrl,
        ocr_text: ocrResult?.raw_text || null,
        vendor_name: vendorName || null,
        amount: amount ? parseInt(amount, 10) : null,
        date: date || null,
        account_code: accountCode || null,
        account_name: accountName || null,
        status: "processed",
      });

      if (insertError) throw insertError;

      router.push("/receipts");
    } catch (error) {
      console.error("保存に失敗しました:", error);
      setError("保存に失敗しました。もう一度お試しください。");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAndCreateJournal = async () => {
    if (!selectedFile) return;
    setIsSaving(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("認証が必要です");

      const fileName = `${user.id}/${Date.now()}-${selectedFile.name}`;
      await supabase.storage.from("receipts").upload(fileName, selectedFile);

      const { data: urlData } = supabase.storage
        .from("receipts")
        .getPublicUrl(fileName);

      // 領収書を保存
      const { data: receipt, error: insertError } = await supabase
        .from("receipts")
        .insert({
          user_id: user.id,
          image_url: urlData.publicUrl,
          ocr_text: ocrResult?.raw_text || null,
          vendor_name: vendorName || null,
          amount: amount ? parseInt(amount, 10) : null,
          date: date || null,
          account_code: accountCode || null,
          account_name: accountName || null,
          status: "confirmed",
        })
        .select()
        .single();

      if (insertError) throw insertError;

      // 仕訳を自動作成
      const journalDate = date || new Date().toISOString().split("T")[0];
      const amountNum = amount ? parseInt(amount, 10) : 0;

      const { data: journal, error: journalError } = await supabase
        .from("journals")
        .insert({
          user_id: user.id,
          date: journalDate,
          description: `${vendorName || "不明"} - ${accountName || "経費"}`,
          receipt_id: receipt.id,
        })
        .select()
        .single();

      if (journalError) throw journalError;

      // 仕訳明細（借方: 経費、貸方: 現金）
      const taxAmount = Math.floor((amountNum * 10) / 110);
      await supabase.from("journal_lines").insert([
        {
          journal_id: journal.id,
          account_code: accountCode || "699",
          account_name: accountName || "雑費",
          debit_amount: amountNum,
          credit_amount: 0,
          tax_code: "P10",
          tax_amount: taxAmount,
        },
        {
          journal_id: journal.id,
          account_code: "100",
          account_name: "現金",
          debit_amount: 0,
          credit_amount: amountNum,
          tax_code: "OUT",
          tax_amount: 0,
        },
      ]);

      router.push("/journals");
    } catch (error) {
      console.error("保存に失敗しました:", error);
      setError("保存に失敗しました。もう一度お試しください。");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Link href="/receipts">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">領収書を登録</h1>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">画像をアップロード</CardTitle>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                <Zap className="h-3.5 w-3.5" />
                AI読み取り
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={useAiOcr && hasApiKey}
                onClick={() => setUseAiOcr(!useAiOcr)}
                disabled={!hasApiKey}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                  useAiOcr && hasApiKey ? "bg-primary" : "bg-muted"
                } ${!hasApiKey ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <span
                  className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    useAiOcr && hasApiKey ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </label>
          </div>
          {!hasApiKey && (
            <p className="text-xs text-muted-foreground mt-1">
              AI読み取りを使うには <Link href="/settings" className="underline text-primary">設定</Link> で Claude API キーを登録してください
            </p>
          )}
        </CardHeader>
        <CardContent>
          <ReceiptUpload onFileSelect={handleFileSelect} isProcessing={isProcessing} />
        </CardContent>
      </Card>

      {ocrResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              {useAiOcr && hasApiKey ? (
                <Zap className="h-4 w-4 text-primary" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {useAiOcr && hasApiKey ? "AI 読み取り結果" : "OCR 読み取り結果"}
              <span className="text-xs font-normal text-muted-foreground">（必ず確認してください）</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {ocrResult.suggested_account_name && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary">自動分類</Badge>
                <span className="text-sm">{ocrResult.suggested_account_name}</span>
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1">
                <Label>店名・取引先</Label>
                <Input
                  value={vendorName}
                  onChange={(e) => setVendorName(e.target.value)}
                  placeholder="店名を入力"
                />
              </div>

              <div className="space-y-1">
                <Label>金額</Label>
                <Input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0"
                />
              </div>

              <div className="space-y-1">
                <Label>日付</Label>
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <Label>勘定科目</Label>
                <AccountSelect
                  value={accountCode}
                  onValueChange={(code, name) => {
                    setAccountCode(code);
                    setAccountName(name);
                  }}
                />
              </div>
            </div>

            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                OCR生テキストを表示
              </summary>
              <pre className="mt-2 p-3 bg-muted rounded-lg text-xs whitespace-pre-wrap max-h-40 overflow-y-auto">
                {ocrResult.raw_text}
              </pre>
            </details>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <div className="flex gap-2 pt-2">
              <Button onClick={() => { setError(null); handleSave(); }} disabled={isSaving} variant="outline">
                <Save className="h-4 w-4 mr-1" />
                領収書のみ保存
              </Button>
              <Button onClick={() => { setError(null); handleSaveAndCreateJournal(); }} disabled={isSaving}>
                <Save className="h-4 w-4 mr-1" />
                保存して仕訳も作成
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
