"use client";

import { useEffect, useState } from "react";
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
import { Plus, Trash2, Users } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Partner } from "@/types";

type PartnerForm = {
  name: string;
  name_kana: string;
  registered_number: string;
  is_customer: boolean;
  is_vendor: boolean;
  email: string;
  phone: string;
  address: string;
  notes: string;
};

const empty: PartnerForm = {
  name: "",
  name_kana: "",
  registered_number: "",
  is_customer: true,
  is_vendor: true,
  email: "",
  phone: "",
  address: "",
  notes: "",
};

export default function PartnersPage() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PartnerForm>(empty);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data } = await supabase.from("partners").select("*").order("name");
    if (data) setPartners(data);
  }

  async function handleSave() {
    if (!form.name) return;
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      return;
    }
    await supabase.from("partners").insert({
      user_id: user.id,
      name: form.name,
      name_kana: form.name_kana || null,
      registered_number: form.registered_number || null,
      is_customer: form.is_customer,
      is_vendor: form.is_vendor,
      email: form.email || null,
      phone: form.phone || null,
      address: form.address || null,
      notes: form.notes || null,
    });
    setForm(empty);
    setOpen(false);
    setSaving(false);
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("この取引先を削除しますか？")) return;
    await supabase.from("partners").delete().eq("id", id);
    load();
  }

  const filtered = partners.filter((p) =>
    !search ||
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.name_kana || "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">取引先マスタ</h1>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          新規登録
        </Button>
      </div>

      <div className="flex gap-2">
        <Input
          placeholder="取引先名で検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">取引先がまだ登録されていません。</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>カナ</TableHead>
                  <TableHead>登録番号</TableHead>
                  <TableHead>区分</TableHead>
                  <TableHead>連絡先</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.name_kana || "-"}
                    </TableCell>
                    <TableCell className="text-xs font-mono">
                      {p.registered_number || "-"}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        {p.is_customer && <Badge variant="default" className="text-xs">顧客</Badge>}
                        {p.is_vendor && <Badge variant="secondary" className="text-xs">仕入先</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.email || p.phone || "-"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDelete(p.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>取引先を登録</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>取引先名 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例: 株式会社サンプル"
              />
            </div>
            <div>
              <Label>カナ</Label>
              <Input
                value={form.name_kana}
                onChange={(e) => setForm({ ...form, name_kana: e.target.value })}
              />
            </div>
            <div>
              <Label>インボイス登録番号</Label>
              <Input
                value={form.registered_number}
                onChange={(e) =>
                  setForm({ ...form, registered_number: e.target.value })
                }
                placeholder="T1234567890123"
              />
            </div>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_customer}
                  onChange={(e) =>
                    setForm({ ...form, is_customer: e.target.checked })
                  }
                />
                顧客
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_vendor}
                  onChange={(e) =>
                    setForm({ ...form, is_vendor: e.target.checked })
                  }
                />
                仕入先
              </label>
            </div>
            <div>
              <Label>メール</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div>
              <Label>電話</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </div>
            <div>
              <Label>住所</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button onClick={handleSave} disabled={!form.name || saving}>
              {saving ? "保存中..." : "登録"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
