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
import { Plus, Trash2, Users, Sparkles, CheckSquare, Square } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { toast } from "@/lib/toast";
import type { Partner } from "@/types";

const AUTO_LEARNED_TAG = "[auto-learned]";

/** Round 22 ⓑ: notes に [auto-learned] が含まれていれば OCR 自動学習由来 */
function isAutoLearned(p: Partner): boolean {
  return Boolean(p.notes && p.notes.includes(AUTO_LEARNED_TAG));
}

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
  // Round 22 ⓑ: auto-learned のみ表示するフィルタ + bulk select
  const [autoOnly, setAutoOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Round 25 ⓐ: partner_id → 使用件数 (receipts + journal_lines の合算)
  const [usageMap, setUsageMap] = useState<Record<string, number>>({});

  useEffect(() => {
    load();
    void loadUsage();
  }, []);

  async function loadUsage() {
    const map: Record<string, number> = {};
    try {
      const { data: rec } = await supabase
        .from("receipts")
        .select("partner_id");
      for (const r of (rec as { partner_id: string | null }[] | null) ?? []) {
        if (r.partner_id) {
          map[r.partner_id] = (map[r.partner_id] ?? 0) + 1;
        }
      }
      const { data: jl } = await supabase
        .from("journal_lines")
        .select("partner_id");
      for (const r of (jl as { partner_id: string | null }[] | null) ?? []) {
        if (r.partner_id) {
          map[r.partner_id] = (map[r.partner_id] ?? 0) + 1;
        }
      }
    } catch {
      /* DB 失敗は表示なしで続行 */
    }
    setUsageMap(map);
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Round 22 ⓑ: 一括承認 — notes から [auto-learned] 行を取り除いて「正式登録」化 */
  async function bulkApprove() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    let count = 0;
    for (const id of ids) {
      const partner = partners.find((p) => p.id === id);
      if (!partner || !isAutoLearned(partner)) continue;
      // notes から [auto-learned] と続く行を取り除く
      const cleaned = (partner.notes ?? "")
        .split("\n")
        .filter((line) => !line.includes(AUTO_LEARNED_TAG))
        .join("\n")
        .trim();
      await supabase
        .from("partners")
        .update({ notes: cleaned || null })
        .eq("id", id);
      count++;
    }
    toast.success(`${count} 件を正式登録に承認しました`);
    setSelectedIds(new Set());
    load();
  }

  async function bulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`${ids.length} 件の取引先を削除します。よろしいですか？`)) return;
    for (const id of ids) {
      await supabase.from("partners").delete().eq("id", id);
    }
    toast.success(`${ids.length} 件削除しました`);
    setSelectedIds(new Set());
    load();
  }

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

  const filtered = partners.filter((p) => {
    if (
      search &&
      !p.name.toLowerCase().includes(search.toLowerCase()) &&
      !(p.name_kana || "").toLowerCase().includes(search.toLowerCase())
    ) {
      return false;
    }
    if (autoOnly && !isAutoLearned(p)) return false;
    return true;
  });

  const autoLearnedCount = partners.filter(isAutoLearned).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">取引先マスタ</h1>
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          新規登録
        </Button>
      </div>

      <div className="flex gap-2 items-center flex-wrap">
        <Input
          placeholder="取引先名で検索"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        {/* Round 22 ⓑ: auto-learned だけ表示するトグル */}
        {autoLearnedCount > 0 && (
          <Button
            type="button"
            size="sm"
            variant={autoOnly ? "default" : "outline"}
            onClick={() => setAutoOnly((v) => !v)}
            title="OCR 自動学習で追加された取引先のみ表示"
          >
            <Sparkles className="h-3 w-3 mr-1" />
            自動学習のみ
            <Badge variant="secondary" className="ml-2 text-[10px]">
              {autoLearnedCount}
            </Badge>
          </Button>
        )}
      </div>

      {/* Round 22 ⓑ: bulk action toolbar (auto-learned 候補をまとめて承認 / 削除) */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border border-blue-200 rounded-md">
          <span className="text-sm font-medium text-blue-700">
            {selectedIds.size} 件選択中
          </span>
          <Button
            size="sm"
            variant="default"
            onClick={() => void bulkApprove()}
            title="選択した auto-learned partner を「正式登録」に承認 (notes の [auto-learned] を削除)"
          >
            <CheckSquare className="h-3 w-3 mr-1" />
            まとめて承認
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void bulkDelete()}
            title="選択した取引先を削除"
          >
            <Trash2 className="h-3 w-3 mr-1" />
            まとめて削除
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelectedIds(new Set())}
          >
            選択解除
          </Button>
        </div>
      )}

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Users className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">
              {partners.length === 0
                ? "取引先がまだ登録されていません"
                : "検索条件に一致する取引先がありません"}
            </p>
            {partners.length === 0 && (
              <Button
                className="mt-4"
                variant="outline"
                onClick={() => setOpen(true)}
              >
                <Plus className="h-4 w-4 mr-1" />
                最初の取引先を登録
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  {/* Round 22 ⓑ: bulk select checkbox 列 */}
                  <TableHead className="w-8">
                    <button
                      type="button"
                      onClick={() => {
                        const visible = filtered.map((p) => p.id);
                        const allSelected =
                          visible.length > 0 &&
                          visible.every((id) => selectedIds.has(id));
                        if (allSelected) {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            for (const id of visible) next.delete(id);
                            return next;
                          });
                        } else {
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            for (const id of visible) next.add(id);
                            return next;
                          });
                        }
                      }}
                      className="hover:opacity-70"
                      title="表示中すべて選択 / 解除"
                    >
                      {filtered.length > 0 &&
                      filtered.every((p) => selectedIds.has(p.id)) ? (
                        <CheckSquare className="h-4 w-4" />
                      ) : (
                        <Square className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                  </TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>カナ</TableHead>
                  <TableHead>登録番号</TableHead>
                  <TableHead>区分</TableHead>
                  <TableHead>連絡先</TableHead>
                  <TableHead className="w-16"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((p) => {
                  const auto = isAutoLearned(p);
                  return (
                    <TableRow
                      key={p.id}
                      className={selectedIds.has(p.id) ? "bg-blue-50/50" : undefined}
                    >
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => toggleSelected(p.id)}
                          className="hover:opacity-70"
                          aria-label={selectedIds.has(p.id) ? "選択解除" : "選択"}
                        >
                          {selectedIds.has(p.id) ? (
                            <CheckSquare className="h-4 w-4 text-primary" />
                          ) : (
                            <Square className="h-4 w-4 text-muted-foreground" />
                          )}
                        </button>
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span>{p.name}</span>
                          {auto && (
                            <Badge
                              variant="outline"
                              className="text-[10px] gap-1 bg-amber-50 border-amber-300 text-amber-800"
                              title="OCR から自動学習で追加されました — レビューしてください"
                            >
                              <Sparkles className="h-3 w-3" />
                              auto-learned
                            </Badge>
                          )}
                          {/* Round 25 ⓐ: 使用回数 Badge (0 回 = 削除候補) */}
                          {(() => {
                            const count = usageMap[p.id] ?? 0;
                            if (count === 0) {
                              return (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] bg-red-50 border-red-200 text-red-700"
                                  title="一度も仕訳・領収書で使われていません — 削除候補"
                                >
                                  未使用
                                </Badge>
                              );
                            }
                            return (
                              <Badge
                                variant="secondary"
                                className="text-[10px]"
                                title="紐付いている仕訳行 + 領収書の合計件数"
                              >
                                使用 {count}
                              </Badge>
                            );
                          })()}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {p.name_kana || "-"}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {p.registered_number || "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {p.is_customer && (
                            <Badge variant="default" className="text-xs">
                              顧客
                            </Badge>
                          )}
                          {p.is_vendor && (
                            <Badge variant="secondary" className="text-xs">
                              仕入先
                            </Badge>
                          )}
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
