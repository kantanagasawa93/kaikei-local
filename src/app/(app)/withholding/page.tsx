"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { ReceiptUpload } from "@/components/receipt-upload";
import { processWithholdingSlip, type WithholdingOcrResult } from "@/lib/withholding-ocr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Plus, FileText, Trash2, Sparkles, Save } from "lucide-react";
import type { WithholdingSlip } from "@/types";

export default function WithholdingPage() {
  const currentYear = new Date().getFullYear();
  const [slips, setSlips] = useState<WithholdingSlip[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [ocrResult, setOcrResult] = useState<WithholdingOcrResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  // フォーム
  const [year, setYear] = useState(currentYear - 1);
  const [payerName, setPayerName] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [withholdingTax, setWithholdingTax] = useState("");
  const [socialInsurance, setSocialInsurance] = useState("");
  const [lifeInsurance, setLifeInsurance] = useState("");
  const [earthquakeInsurance, setEarthquakeInsurance] = useState("");
  const [housingLoan, setHousingLoan] = useState("");

  useEffect(() => {
    loadSlips();
  }, []);

  async function loadSlips() {
    const { data } = await supabase
      .from("withholding_slips")
      .select("*")
      .order("year", { ascending: false });
    if (data) setSlips(data);
  }

  const handleFileSelect = async (file: File) => {
    setSelectedFile(file);
    setIsProcessing(true);
    try {
      const result = await processWithholdingSlip(file);
      setOcrResult(result);
      if (result.payer_name) setPayerName(result.payer_name);
      if (result.payment_amount) setPaymentAmount(result.payment_amount.toString());
      if (result.withholding_tax) setWithholdingTax(result.withholding_tax.toString());
      if (result.social_insurance) setSocialInsurance(result.social_insurance.toString());
    } catch (error) {
      console.error("OCR処理に失敗しました:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  async function handleSave() {
    setIsSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    let imageUrl: string | null = null;
    if (selectedFile) {
      const fileName = `${user.id}/withholding/${Date.now()}-${selectedFile.name}`;
      await supabase.storage.from("receipts").upload(fileName, selectedFile);
      const { data } = supabase.storage.from("receipts").getPublicUrl(fileName);
      imageUrl = data.publicUrl;
    }

    await supabase.from("withholding_slips").insert({
      user_id: user.id,
      year,
      payer_name: payerName || null,
      payment_amount: parseInt(paymentAmount) || 0,
      withholding_tax: parseInt(withholdingTax) || 0,
      social_insurance: parseInt(socialInsurance) || 0,
      life_insurance_deduction: parseInt(lifeInsurance) || 0,
      earthquake_insurance_deduction: parseInt(earthquakeInsurance) || 0,
      housing_loan_deduction: parseInt(housingLoan) || 0,
      image_url: imageUrl,
      ocr_text: ocrResult?.raw_text || null,
    });

    // リセット
    setPayerName("");
    setPaymentAmount("");
    setWithholdingTax("");
    setSocialInsurance("");
    setLifeInsurance("");
    setEarthquakeInsurance("");
    setHousingLoan("");
    setOcrResult(null);
    setSelectedFile(null);
    setDialogOpen(false);
    setIsSaving(false);
    loadSlips();
  }

  async function handleDelete(id: string) {
    if (!confirm("この源泉徴収票を削除しますか？")) return;
    await supabase.from("withholding_slips").delete().eq("id", id);
    setSlips((prev) => prev.filter((s) => s.id !== id));
  }

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(amount);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">源泉徴収票</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 h-9 px-4 py-2 cursor-pointer">
            <Plus className="h-4 w-4" />
            追加
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>源泉徴収票を登録</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <ReceiptUpload onFileSelect={handleFileSelect} isProcessing={isProcessing} />

              {ocrResult && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Sparkles className="h-4 w-4" />
                  OCRで読み取った値が自動入力されました
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label>年度</Label>
                  <Input type="number" value={year} onChange={(e) => setYear(parseInt(e.target.value))} />
                </div>
                <div className="space-y-1">
                  <Label>支払者名</Label>
                  <Input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="会社名" />
                </div>
                <div className="space-y-1">
                  <Label>支払金額</Label>
                  <Input type="number" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label>源泉徴収税額</Label>
                  <Input type="number" value={withholdingTax} onChange={(e) => setWithholdingTax(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label>社会保険料等の金額</Label>
                  <Input type="number" value={socialInsurance} onChange={(e) => setSocialInsurance(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label>生命保険料の控除額</Label>
                  <Input type="number" value={lifeInsurance} onChange={(e) => setLifeInsurance(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label>地震保険料の控除額</Label>
                  <Input type="number" value={earthquakeInsurance} onChange={(e) => setEarthquakeInsurance(e.target.value)} placeholder="0" />
                </div>
                <div className="space-y-1">
                  <Label>住宅借入金等特別控除額</Label>
                  <Input type="number" value={housingLoan} onChange={(e) => setHousingLoan(e.target.value)} placeholder="0" />
                </div>
              </div>

              <Button onClick={handleSave} disabled={isSaving} className="w-full">
                <Save className="h-4 w-4 mr-1" />
                {isSaving ? "保存中..." : "保存"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {slips.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">源泉徴収票がまだありません</p>
            <p className="text-sm text-muted-foreground mt-1">
              画像をアップロードするとOCRで自動読み取りします
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>年度</TableHead>
                  <TableHead>支払者</TableHead>
                  <TableHead className="text-right">支払金額</TableHead>
                  <TableHead className="text-right">源泉徴収税額</TableHead>
                  <TableHead className="text-right">社会保険料</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {slips.map((slip) => (
                  <TableRow key={slip.id}>
                    <TableCell>{slip.year}年</TableCell>
                    <TableCell>{slip.payer_name || "-"}</TableCell>
                    <TableCell className="text-right">{formatCurrency(slip.payment_amount)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(slip.withholding_tax)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(slip.social_insurance)}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(slip.id)} className="h-8 w-8 p-0">
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-bold">
                  <TableCell colSpan={2}>合計</TableCell>
                  <TableCell className="text-right">{formatCurrency(slips.reduce((s, sl) => s + sl.payment_amount, 0))}</TableCell>
                  <TableCell className="text-right">{formatCurrency(slips.reduce((s, sl) => s + sl.withholding_tax, 0))}</TableCell>
                  <TableCell className="text-right">{formatCurrency(slips.reduce((s, sl) => s + sl.social_insurance, 0))}</TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
