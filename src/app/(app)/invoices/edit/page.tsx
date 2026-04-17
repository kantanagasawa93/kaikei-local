"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/localDb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { ArrowLeft, Plus, Trash2, FileDown, Send, CheckCircle2 } from "lucide-react";
import { TAX_CLASSES, calculateTax } from "@/lib/tax-classes";
import { exportInvoicePdf } from "@/lib/invoice-pdf";
import { downloadBlob } from "@/lib/pdf-export";
import type { Invoice, InvoiceItem, IssuerSettings, Partner } from "@/types";

type ItemInput = {
  id?: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  tax_code: string;
};

function newItem(): ItemInput {
  return { description: "", quantity: 1, unit: "式", unit_price: 0, tax_code: "S10" };
}

function EditInner() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get("id");

  const [loading, setLoading] = useState(true);
  const [partners, setPartners] = useState<Partner[]>([]);
  const [issuer, setIssuer] = useState<IssuerSettings | null>(null);

  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split("T")[0]);
  const [dueDate, setDueDate] = useState("");
  const [partnerId, setPartnerId] = useState<string>("");
  const [partnerName, setPartnerName] = useState("");
  const [partnerAddress, setPartnerAddress] = useState("");
  const [subject, setSubject] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<Invoice["status"]>("draft");
  const [items, setItems] = useState<ItemInput[]>([newItem()]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const [pRes, iRes] = await Promise.all([
        db.from("partners").select("*").order("name"),
        db.from("issuer_settings").select("*").eq("id", "singleton").single(),
      ]);
      if (pRes.data) setPartners(pRes.data);
      if (iRes.data) setIssuer(iRes.data as IssuerSettings);

      if (id) {
        const { data: inv } = await db.from("invoices").select("*").eq("id", id).single();
        if (inv) {
          const i = inv as Invoice;
          setInvoiceNumber(i.invoice_number);
          setIssueDate(i.issue_date);
          setDueDate(i.due_date || "");
          setPartnerId(i.partner_id || "");
          setPartnerName(i.partner_name);
          setPartnerAddress(i.partner_address || "");
          setSubject(i.subject || "");
          setNotes(i.notes || "");
          setStatus(i.status);
        }
        const { data: itemRows } = await db
          .from("invoice_items")
          .select("*")
          .eq("invoice_id", id)
          .order("sort_order");
        if (itemRows && itemRows.length > 0) {
          setItems(
            (itemRows as InvoiceItem[]).map((r) => ({
              id: r.id,
              description: r.description,
              quantity: r.quantity,
              unit: r.unit || "",
              unit_price: r.unit_price,
              tax_code: r.tax_code || "S10",
            }))
          );
        }
      } else {
        // 自動採番: INV-YYYYMMDD-XXX
        const today = new Date().toISOString().replace(/-/g, "").slice(0, 8);
        const { data: existing } = await db
          .from("invoices")
          .select("invoice_number")
          .order("issue_date", { ascending: false })
          .limit(1);
        let seq = 1;
        if (existing && existing.length > 0) {
          const last = existing[0].invoice_number as string;
          const m = last.match(/(\d+)$/);
          if (m) seq = parseInt(m[1], 10) + 1;
        }
        setInvoiceNumber(`INV-${today}-${String(seq).padStart(3, "0")}`);

        if (iRes.data?.default_payment_terms_days) {
          const d = new Date();
          d.setDate(d.getDate() + iRes.data.default_payment_terms_days);
          setDueDate(d.toISOString().split("T")[0]);
        }
      }
      setLoading(false);
    })();
  }, [id]);

  // 請求書明細は「税抜」の unit_price 入力を想定する
  const totals = useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    for (const it of items) {
      const amt = Math.floor(it.quantity * it.unit_price);
      subtotal += amt;
      tax += calculateTax(amt, it.tax_code);
    }
    return { subtotal, tax, total: subtotal + tax };
  }, [items]);

  const updateItem = (idx: number, patch: Partial<ItemInput>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const handleSelectPartner = useCallback(
    (pid: string) => {
      if (pid === "__none__") {
        setPartnerId("");
        return;
      }
      setPartnerId(pid);
      const p = partners.find((x) => x.id === pid);
      if (p) {
        setPartnerName(p.name);
        if (p.address) setPartnerAddress(p.address);
      }
    },
    [partners]
  );

  const handleSave = async (newStatus?: Invoice["status"]) => {
    if (!invoiceNumber || !partnerName || items.length === 0) return;
    setSaving(true);
    const saveStatus = newStatus || status;
    const payload = {
      invoice_number: invoiceNumber,
      issue_date: issueDate,
      due_date: dueDate || null,
      partner_id: partnerId || null,
      partner_name: partnerName,
      partner_address: partnerAddress || null,
      subject: subject || null,
      subtotal: totals.subtotal,
      tax_amount: totals.tax,
      total_amount: totals.total,
      status: saveStatus,
      notes: notes || null,
      updated_at: new Date().toISOString(),
      sent_at: saveStatus === "sent" || saveStatus === "paid" ? new Date().toISOString() : null,
      paid_at: saveStatus === "paid" ? new Date().toISOString() : null,
    };

    let savedId = id;
    if (id) {
      await db.from("invoices").update(payload).eq("id", id);
    } else {
      const ins = await db.from("invoices").insert(payload);
      savedId = (ins.data as { id: string }[])?.[0]?.id ?? null;
    }

    if (savedId) {
      await db.from("invoice_items").delete().eq("invoice_id", savedId);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const amount = Math.floor(it.quantity * it.unit_price);
        await db.from("invoice_items").insert({
          invoice_id: savedId,
          sort_order: i,
          description: it.description,
          quantity: it.quantity,
          unit: it.unit || null,
          unit_price: it.unit_price,
          amount,
          tax_code: it.tax_code,
          tax_amount: calculateTax(amount, it.tax_code),
        });
      }
    }
    setSaving(false);
    setStatus(saveStatus);
    if (!id && savedId) {
      router.replace(`/invoices/edit/?id=${savedId}`);
    }
  };

  const handleDownloadPdf = async () => {
    const invoice: Invoice = {
      id: id || "tmp",
      invoice_number: invoiceNumber,
      issue_date: issueDate,
      due_date: dueDate || null,
      partner_id: partnerId || null,
      partner_name: partnerName,
      partner_address: partnerAddress || null,
      subject: subject || null,
      subtotal: totals.subtotal,
      tax_amount: totals.tax,
      total_amount: totals.total,
      status,
      sent_at: null,
      paid_at: null,
      notes: notes || null,
      journal_id: null,
      created_at: "",
      updated_at: "",
    };
    const itemRows: InvoiceItem[] = items.map((it, idx) => {
      const amount = Math.floor(it.quantity * it.unit_price);
      return {
        id: it.id || `tmp-${idx}`,
        invoice_id: id || "tmp",
        sort_order: idx,
        description: it.description,
        quantity: it.quantity,
        unit: it.unit || null,
        unit_price: it.unit_price,
        amount,
        tax_code: it.tax_code,
        tax_amount: calculateTax(amount, it.tax_code),
      };
    });
    const bytes = await exportInvoicePdf(invoice, itemRows, issuer);
    downloadBlob(bytes, `${invoiceNumber}.pdf`);
  };

  if (loading) {
    return <div className="text-muted-foreground">読込中...</div>;
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/invoices/">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              戻る
            </Button>
          </Link>
          <h1 className="text-2xl font-bold">{id ? "請求書を編集" : "新規請求書"}</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleDownloadPdf}>
            <FileDown className="h-4 w-4 mr-1" />
            PDF出力
          </Button>
          <Button variant="outline" onClick={() => handleSave("sent")} disabled={saving}>
            <Send className="h-4 w-4 mr-1" />
            送付済にする
          </Button>
          <Button variant="outline" onClick={() => handleSave("paid")} disabled={saving}>
            <CheckCircle2 className="h-4 w-4 mr-1" />
            入金済にする
          </Button>
          <Button onClick={() => handleSave()} disabled={saving}>
            {saving ? "保存中..." : "保存"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本情報</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div>
            <Label>請求書番号</Label>
            <Input value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
          </div>
          <div>
            <Label>発行日</Label>
            <Input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </div>
          <div>
            <Label>お支払期日</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div className="md:col-span-3">
            <Label>件名</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="例: 2025年5月分 Webサイト運用保守料" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">取引先</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div>
            <Label>取引先マスタから選択</Label>
            <Select value={partnerId || "__none__"} onValueChange={(v) => v && handleSelectPartner(v)}>
              <SelectTrigger>
                <SelectValue placeholder="取引先を選択">
                  {partnerId ? partners.find((p) => p.id === partnerId)?.name ?? "取引先を選択" : "（手動入力）"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">（手動入力）</SelectItem>
                {partners.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>宛名</Label>
            <Input value={partnerName} onChange={(e) => setPartnerName(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <Label>住所</Label>
            <Input value={partnerAddress} onChange={(e) => setPartnerAddress(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">明細</CardTitle>
          <Button size="sm" variant="outline" onClick={() => setItems([...items, newItem()])}>
            <Plus className="h-4 w-4 mr-1" />
            行を追加
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40%]">内容</TableHead>
                <TableHead>数量</TableHead>
                <TableHead>単位</TableHead>
                <TableHead>単価</TableHead>
                <TableHead>税区分</TableHead>
                <TableHead className="text-right">金額</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it, idx) => {
                const amount = Math.floor(it.quantity * it.unit_price);
                return (
                  <TableRow key={idx}>
                    <TableCell>
                      <Input
                        value={it.description}
                        onChange={(e) => updateItem(idx, { description: e.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={it.quantity || ""}
                        onChange={(e) => updateItem(idx, { quantity: Math.max(0, parseFloat(e.target.value) || 0) })}
                        className="w-20"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={it.unit}
                        onChange={(e) => updateItem(idx, { unit: e.target.value })}
                        className="w-16"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        value={it.unit_price || ""}
                        onChange={(e) => updateItem(idx, { unit_price: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                        className="w-28 text-right"
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={it.tax_code}
                        onValueChange={(v) => v && updateItem(idx, { tax_code: v })}
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue>
                            {TAX_CLASSES.find((t) => t.code === it.tax_code)?.name ?? it.tax_code}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {TAX_CLASSES.filter(
                            (t) => t.kind === "taxable_sales" || t.kind === "out_of_scope" || t.kind === "non_taxable"
                          ).map((t) => (
                            <SelectItem key={t.code} value={t.code}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      ¥{amount.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setItems(items.filter((_, i) => i !== idx))}
                        disabled={items.length <= 1}
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

      <Card>
        <CardContent className="p-4 space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">小計</span>
            <span>¥{totals.subtotal.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">うち消費税</span>
            <span>¥{totals.tax.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-lg font-bold pt-2 border-t">
            <span>合計</span>
            <span>¥{totals.total.toLocaleString()}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">備考</CardTitle>
        </CardHeader>
        <CardContent>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm"
            placeholder="振込先、備考など"
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default function InvoiceEditPage() {
  return (
    <Suspense fallback={<div className="text-muted-foreground">読込中...</div>}>
      <EditInner />
    </Suspense>
  );
}
