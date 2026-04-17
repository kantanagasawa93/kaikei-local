"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { db } from "@/lib/localDb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Save } from "lucide-react";
import type { IssuerSettings } from "@/types";

export default function IssuerSettingsPage() {
  const [form, setForm] = useState<Partial<IssuerSettings>>({
    business_name: "",
    owner_name: "",
    postal_code: "",
    address: "",
    phone: "",
    email: "",
    registered_number: "",
    bank_info: "",
    default_payment_terms_days: 30,
    default_notes: "",
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await db
        .from("issuer_settings")
        .select("*")
        .eq("id", "singleton")
        .single();
      if (data) setForm(data);
      setLoaded(true);
    })();
  }, []);

  const update = <K extends keyof IssuerSettings>(key: K, value: IssuerSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    const payload = { ...form, id: "singleton", updated_at: new Date().toISOString() };

    const { data: existing } = await db
      .from("issuer_settings")
      .select("id")
      .eq("id", "singleton")
      .single();

    if (existing) {
      await db.from("issuer_settings").update(payload).eq("id", "singleton");
    } else {
      await db.from("issuer_settings").insert(payload);
    }
    setSaving(false);
    setMessage("保存しました");
    setTimeout(() => setMessage(null), 2000);
  };

  if (!loaded) return <div className="text-muted-foreground">読込中...</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/invoices/">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              戻る
            </Button>
          </Link>
          <h1 className="text-2xl font-bold">発行者情報</h1>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-4 w-4 mr-1" />
          {saving ? "保存中..." : "保存"}
        </Button>
      </div>

      {message && (
        <div className="rounded-md bg-green-50 border border-green-200 text-green-800 px-4 py-2 text-sm">
          {message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">事業情報</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div>
            <Label>屋号</Label>
            <Input
              value={form.business_name || ""}
              onChange={(e) => update("business_name", e.target.value)}
              placeholder="例: サンプル商店"
            />
          </div>
          <div>
            <Label>代表者名</Label>
            <Input
              value={form.owner_name || ""}
              onChange={(e) => update("owner_name", e.target.value)}
              placeholder="例: 山田太郎"
            />
          </div>
          <div>
            <Label>郵便番号</Label>
            <Input
              value={form.postal_code || ""}
              onChange={(e) => update("postal_code", e.target.value)}
              placeholder="123-4567"
            />
          </div>
          <div>
            <Label>電話番号</Label>
            <Input
              value={form.phone || ""}
              onChange={(e) => update("phone", e.target.value)}
              placeholder="03-1234-5678"
            />
          </div>
          <div className="md:col-span-2">
            <Label>住所</Label>
            <Input
              value={form.address || ""}
              onChange={(e) => update("address", e.target.value)}
              placeholder="東京都千代田区..."
            />
          </div>
          <div>
            <Label>メール</Label>
            <Input
              type="email"
              value={form.email || ""}
              onChange={(e) => update("email", e.target.value)}
            />
          </div>
          <div>
            <Label>インボイス登録番号</Label>
            <Input
              value={form.registered_number || ""}
              onChange={(e) => update("registered_number", e.target.value)}
              placeholder="T1234567890123"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">請求書既定値</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>お支払期日（発行日から何日後）</Label>
            <Input
              type="number"
              value={form.default_payment_terms_days || 30}
              onChange={(e) =>
                update("default_payment_terms_days", parseInt(e.target.value, 10) || 30)
              }
              className="w-32"
            />
          </div>
          <div>
            <Label>振込先情報（請求書に印字されます）</Label>
            <textarea
              value={form.bank_info || ""}
              onChange={(e) => update("bank_info", e.target.value)}
              className="w-full min-h-24 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              placeholder="○○銀行 △△支店 普通 1234567 カ）サンプル"
            />
          </div>
          <div>
            <Label>既定備考</Label>
            <textarea
              value={form.default_notes || ""}
              onChange={(e) => update("default_notes", e.target.value)}
              className="w-full min-h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="お世話になっております..."
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
