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
import { Plus, Trash2, Users, Sparkles, CheckSquare, Square, GitMerge, RotateCcw, Pencil, Scale, Ban, ArrowRight, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { toast } from "@/lib/toast";
import {
  detectPartnerVariants,
  mergePartnerVariant,
  undoPartnerMerge,
  getPartnerMergeUndoCount,
  getPartnerProfile,
  variantPairKey,
  getIgnoredVariantKeys,
  addIgnoredVariantKey,
  type PartnerVariantPair,
  type PartnerProfile,
} from "@/lib/partner-cleanup";
import { getAccountByCode } from "@/lib/accounts";
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
  postal_code: string;
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
  postal_code: "",
  address: "",
  notes: "",
};

export default function PartnersPage() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<PartnerForm>(empty);
  // Round 28: 編集対象の partner id (null なら新規登録)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Round 22 ⓑ: auto-learned のみ表示するフィルタ + bulk select
  const [autoOnly, setAutoOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Round 25 ⓐ: partner_id → 使用件数 (receipts + journal_lines の合算)
  const [usageMap, setUsageMap] = useState<Record<string, number>>({});
  // Round 27 ⓐ: 表記ゆれ候補ペア
  const [variantPairs, setVariantPairs] = useState<PartnerVariantPair[]>([]);
  // Round 28 ⓑ: partner 統合の Undo 可能件数
  const [mergeUndoCount, setMergeUndoCount] = useState(0);
  // Round 31: 「別物」として無視したペアキー + 見比べモーダルの状態
  const [ignoredKeys, setIgnoredKeys] = useState<Set<string>>(new Set());
  const [compare, setCompare] = useState<PartnerVariantPair | null>(null);
  const [baseProfile, setBaseProfile] = useState<PartnerProfile | null>(null);
  const [variantProfile, setVariantProfile] = useState<PartnerProfile | null>(null);
  const [loadingProfiles, setLoadingProfiles] = useState(false);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    load();
    void loadUsage();
    void getPartnerMergeUndoCount().then(setMergeUndoCount);
    void getIgnoredVariantKeys().then(setIgnoredKeys);
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

  // Round 27 ⓐ: partners + usageMap の両方が読まれた後に表記ゆれを再検出
  // Round 31: 「別物」として無視したペアは除外する
  useEffect(() => {
    if (partners.length === 0) {
      setVariantPairs([]);
      return;
    }
    const detected = detectPartnerVariants(partners, usageMap).filter(
      (p) => !ignoredKeys.has(variantPairKey(p.base.id, p.variant.id)),
    );
    setVariantPairs(detected);
  }, [partners, usageMap, ignoredKeys]);

  // Round 31: 見比べモーダルを開く (両取引先のプロファイルを読む)
  async function openCompare(pair: PartnerVariantPair) {
    setCompare(pair);
    setBaseProfile(null);
    setVariantProfile(null);
    setLoadingProfiles(true);
    try {
      const [bp, vp] = await Promise.all([
        getPartnerProfile(pair.base.id),
        getPartnerProfile(pair.variant.id),
      ]);
      setBaseProfile(bp);
      setVariantProfile(vp);
    } catch (e) {
      toast.error(`比較データの取得に失敗: ${(e as Error).message}`);
    } finally {
      setLoadingProfiles(false);
    }
  }

  // Round 31: モーダルから方向を選んで統合する (keep = 残す側)
  async function doMergeFromCompare(keep: "base" | "variant") {
    if (!compare || merging) return;
    const keepP = keep === "base" ? compare.base : compare.variant;
    const dropP = keep === "base" ? compare.variant : compare.base;
    setMerging(true);
    try {
      await mergePartnerVariant({
        variantId: dropP.id,
        baseId: keepP.id,
        variantName: dropP.name,
        baseName: keepP.name,
      });
      toast.success(`「${dropP.name}」→「${keepP.name}」に統合しました（取り消し可）`);
      setCompare(null);
      load();
      void loadUsage();
      setMergeUndoCount(await getPartnerMergeUndoCount());
    } catch (e) {
      toast.error(`統合に失敗: ${(e as Error).message}`);
    } finally {
      setMerging(false);
    }
  }

  // Round 31: 「別物」として無視 (以後このペアは表記ゆれ候補に出さない)
  async function doIgnore() {
    if (!compare) return;
    const key = variantPairKey(compare.base.id, compare.variant.id);
    try {
      await addIgnoredVariantKey(key);
      setIgnoredKeys((prev) => new Set(prev).add(key));
      toast.info("別物として登録しました（以後この組み合わせは提案しません）");
      setCompare(null);
    } catch (e) {
      toast.error(`登録に失敗: ${(e as Error).message}`);
    }
  }

  // Round 28 ⓑ: 直近の partner 統合を取り消す
  async function handleUndoMerge() {
    try {
      const r = await undoPartnerMerge();
      if (!r.restored) {
        toast.info("取り消せる統合がありません");
      } else {
        toast.success(
          `「${r.restored.variantName}」を「${r.restored.baseName}」から分離して復元しました`,
        );
        load();
        void loadUsage();
      }
      setMergeUndoCount(await getPartnerMergeUndoCount());
    } catch (e) {
      toast.error(`取り消しに失敗: ${(e as Error).message}`);
    }
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

  // Round 28: 行クリックで既存 partner を編集モードで開く
  function openEdit(p: Partner) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      name_kana: p.name_kana ?? "",
      registered_number: p.registered_number ?? "",
      is_customer: Boolean(p.is_customer),
      is_vendor: Boolean(p.is_vendor),
      email: p.email ?? "",
      phone: p.phone ?? "",
      postal_code: p.postal_code ?? "",
      address: p.address ?? "",
      notes: p.notes ?? "",
    });
    setOpen(true);
  }

  function openNew() {
    setEditingId(null);
    setForm(empty);
    setOpen(true);
  }

  function closeDialog() {
    setOpen(false);
    setEditingId(null);
    setForm(empty);
  }

  async function handleSave() {
    if (!form.name) return;
    setSaving(true);
    const payload = {
      name: form.name,
      name_kana: form.name_kana || null,
      registered_number: form.registered_number || null,
      is_customer: form.is_customer,
      is_vendor: form.is_vendor,
      email: form.email || null,
      phone: form.phone || null,
      postal_code: form.postal_code || null,
      address: form.address || null,
      notes: form.notes || null,
    };
    try {
      if (editingId) {
        // 編集モード: UPDATE
        await supabase.from("partners").update(payload).eq("id", editingId);
        toast.success(`「${form.name}」を更新しました`);
      } else {
        // 新規登録モード: INSERT
        await supabase.from("partners").insert(payload);
        toast.success(`「${form.name}」を登録しました`);
      }
    } catch (e) {
      toast.error(
        `保存に失敗: ${e instanceof Error ? e.message : String(e)}`,
      );
      setSaving(false);
      return;
    }
    setSaving(false);
    closeDialog();
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
        <Button onClick={openNew}>
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
        {/* Round 28 ⓑ: 直近の統合を取り消す */}
        {mergeUndoCount > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleUndoMerge()}
            title="直近の取引先統合を取り消して分離する"
          >
            <RotateCcw className="h-3 w-3 mr-1" />
            統合を取り消す
            <Badge variant="secondary" className="ml-2 text-[10px]">{mergeUndoCount}</Badge>
          </Button>
        )}
      </div>

      {/* Round 27 ⓐ: 表記ゆれ候補ペア (検出されたら提示、ワンクリックで統合) */}
      {variantPairs.length > 0 && (
        <Card className="border-purple-200 bg-purple-50/40">
          <CardContent className="p-4 space-y-2">
            <p className="text-sm font-medium flex items-center gap-2">
              <GitMerge className="h-4 w-4 text-purple-600" />
              表記ゆれの可能性 ({variantPairs.length} ペア)
            </p>
            <p className="text-xs text-muted-foreground">
              名前の先頭が一致する取引先ペアを検出しました。「見比べる」で取引履歴を
              並べて確認してから統合できます。
            </p>
            <div className="space-y-1">
              {variantPairs.slice(0, 5).map((p) => (
                <div
                  key={`${p.base.id}:${p.variant.id}`}
                  className="flex items-center gap-2 text-sm py-1 border-b border-purple-100 last:border-0"
                >
                  <span className="flex-1 truncate">
                    <b>{p.base.name}</b>
                    <span className="text-muted-foreground"> ({p.base.usage} 回) ↔ </span>
                    <span>{p.variant.name}</span>
                    <span className="text-muted-foreground"> ({p.variant.usage} 回)</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void openCompare(p)}
                    title="2 つの取引先の履歴を並べて見比べる"
                  >
                    <Scale className="h-3 w-3 mr-1" />
                    見比べる
                  </Button>
                </div>
              ))}
              {variantPairs.length > 5 && (
                <p className="text-[10px] text-muted-foreground pt-1">
                  …他 {variantPairs.length - 5} ペア
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Round 31: 表記ゆれ「見比べる」モーダル */}
      <Dialog
        open={compare !== null}
        onOpenChange={(o) => {
          if (!o) setCompare(null);
        }}
      >
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Scale className="h-4 w-4" />
              取引先を見比べる
            </DialogTitle>
          </DialogHeader>

          {loadingProfiles ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              取引履歴を読み込み中...
            </div>
          ) : compare ? (
            <div className="space-y-4">
              {/* 判定ヒント: 主な勘定科目が一致していれば同一の可能性が高い */}
              {(() => {
                const baseCodes = new Set(
                  (baseProfile?.topAccounts ?? []).map((a) => a.code),
                );
                const share = (variantProfile?.topAccounts ?? []).some((a) =>
                  baseCodes.has(a.code),
                );
                return (
                  <div
                    className={`rounded-md border px-3 py-2 text-xs ${
                      share
                        ? "border-green-300 bg-green-50 text-green-800"
                        : "border-amber-300 bg-amber-50 text-amber-800"
                    }`}
                  >
                    {share
                      ? "✓ 主に使う勘定科目が一致しています。同じ取引先の可能性が高いです。"
                      : "⚠ 主に使う勘定科目が異なります。別の取引先かもしれません。履歴を確認してください。"}
                  </div>
                );
              })()}

              <div className="grid grid-cols-2 gap-3">
                <ProfileColumn
                  title={compare.base.name}
                  usage={compare.base.usage}
                  profile={baseProfile}
                />
                <ProfileColumn
                  title={compare.variant.name}
                  usage={compare.variant.usage}
                  profile={variantProfile}
                />
              </div>

              <p className="text-xs text-muted-foreground">
                統合すると、選ばなかった方の領収書・仕訳の取引先がすべて残す側に
                書き換わり、選ばなかった取引先は削除されます（取り消し可）。
              </p>
            </div>
          ) : null}

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void doIgnore()}
              disabled={merging}
              className="text-muted-foreground"
            >
              <Ban className="h-3.5 w-3.5 mr-1" />
              別物として無視
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void doMergeFromCompare("variant")}
                disabled={merging || loadingProfiles}
                title={`「${compare?.base.name}」を「${compare?.variant.name}」に統合`}
              >
                {compare?.base.name}
                <ArrowRight className="h-3.5 w-3.5 mx-1" />
                {compare?.variant.name} に統合
              </Button>
              <Button
                size="sm"
                onClick={() => void doMergeFromCompare("base")}
                disabled={merging || loadingProfiles}
                title={`「${compare?.variant.name}」を「${compare?.base.name}」に統合`}
              >
                {compare?.variant.name}
                <ArrowRight className="h-3.5 w-3.5 mx-1" />
                {compare?.base.name} に統合
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                        <div className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => openEdit(p)}
                            title="この取引先を編集"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDelete(p.id)}
                            title="削除"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingId ? "取引先を編集" : "取引先を登録"}
            </DialogTitle>
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
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-1">
                <Label>郵便番号</Label>
                <Input
                  value={form.postal_code}
                  onChange={(e) =>
                    setForm({ ...form, postal_code: e.target.value })
                  }
                  placeholder="例: 100-0001"
                />
              </div>
              <div className="col-span-2">
                <Label>住所</Label>
                <Input
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="例: 東京都千代田区..."
                />
              </div>
            </div>
            <div>
              <Label>備考</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="(任意)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              キャンセル
            </Button>
            <Button onClick={handleSave} disabled={!form.name || saving}>
              {saving ? "保存中..." : editingId ? "更新" : "登録"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Round 31: 見比べモーダルの片側 (取引先 1 件) を表示する列。
 * 登録科目 / よく使う科目 / 最近の取引 (日付・摘要・科目・金額) を出し、
 * 「本当に同じ取引先か」を判断する材料にする。
 */
function ProfileColumn({
  title,
  usage,
  profile,
}: {
  title: string;
  usage: number;
  profile: PartnerProfile | null;
}) {
  const defAcc = profile?.defaultAccountCode
    ? getAccountByCode(profile.defaultAccountCode)
    : null;
  const isAuto = Boolean(profile?.notes?.includes("[auto-learned]"));

  return (
    <div className="rounded-lg border p-3 space-y-2 min-w-0">
      <div className="space-y-0.5">
        <p className="font-semibold break-words">{title}</p>
        <p className="text-xs text-muted-foreground">
          使用 {usage} 回
          {profile && profile.totalAmount > 0 && (
            <> ・ 累計 ¥{profile.totalAmount.toLocaleString()}</>
          )}
          {isAuto && (
            <Badge variant="secondary" className="ml-1 text-[10px]">
              自動学習
            </Badge>
          )}
        </p>
      </div>

      <div className="text-xs">
        <span className="text-muted-foreground">登録科目: </span>
        {defAcc ? (
          <span>
            {defAcc.code} {defAcc.name}
          </span>
        ) : (
          <span className="text-muted-foreground">未設定</span>
        )}
      </div>

      {profile && profile.topAccounts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {profile.topAccounts.map((a) => (
            <Badge key={a.code} variant="outline" className="text-[10px] font-normal">
              {a.name} ×{a.count}
            </Badge>
          ))}
        </div>
      )}

      <div>
        <p className="text-[11px] font-medium text-muted-foreground mb-1">
          最近の取引
        </p>
        {profile && profile.txns.length > 0 ? (
          <ul className="space-y-1">
            {profile.txns.map((t, i) => (
              <li key={i} className="text-[11px] leading-tight">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-muted-foreground shrink-0">
                    {t.date || "日付なし"}
                  </span>
                  <span className="font-mono tabular-nums shrink-0">
                    ¥{t.amount.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{t.label || "—"}</span>
                  {t.accountName && (
                    <span className="text-muted-foreground shrink-0">
                      {t.accountName}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted-foreground">取引履歴なし</p>
        )}
      </div>
    </div>
  );
}
