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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Package } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { DEFAULT_ACCOUNTS, getAccountByCode } from "@/lib/accounts";
import { straightLineYear, bookValueAtYearEnd } from "@/lib/depreciation";
import type { FixedAsset } from "@/types";

const ASSET_ACCOUNT_CODES = ["160", "161", "162", "163", "164", "165"];

type DepMethod = "straight_line" | "none";
const emptyForm: {
  name: string;
  asset_account_code: string;
  acquisition_date: string;
  acquisition_cost: number;
  useful_life_years: number;
  depreciation_method: DepMethod;
  business_ratio: number;
  residual_value: number;
} = {
  name: "",
  asset_account_code: "163",
  acquisition_date: new Date().toISOString().split("T")[0],
  acquisition_cost: 0,
  useful_life_years: 4,
  depreciation_method: "straight_line",
  business_ratio: 100,
  residual_value: 0,
};

export default function FixedAssetsPage() {
  const [assets, setAssets] = useState<FixedAsset[]>([]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data } = await supabase
      .from("fixed_assets")
      .select("*")
      .order("acquisition_date", { ascending: false });
    if (data) setAssets(data);
  }

  async function handleSave() {
    if (!form.name || !form.acquisition_cost) return;
    setSaving(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setSaving(false);
      return;
    }
    const account = getAccountByCode(form.asset_account_code);
    await supabase.from("fixed_assets").insert({
      user_id: user.id,
      name: form.name,
      asset_account_code: form.asset_account_code,
      acquisition_date: form.acquisition_date,
      acquisition_cost: form.acquisition_cost,
      useful_life_years:
        form.depreciation_method === "none" ? null : form.useful_life_years,
      depreciation_method: form.depreciation_method,
      business_ratio: form.business_ratio,
      residual_value: form.residual_value,
    });
    setForm(emptyForm);
    setOpen(false);
    setSaving(false);
    load();
    // suppress lint for unused variable
    void account;
  }

  async function handleDelete(id: string) {
    if (!confirm("この固定資産を削除しますか？")) return;
    await supabase.from("fixed_assets").delete().eq("id", id);
    load();
  }

  const rows = assets.map((a) => {
    const depreciation = straightLineYear(a, year);
    const bookValue = bookValueAtYearEnd(a, year);
    const bookValueBefore = bookValueAtYearEnd(a, year - 1);
    const businessDepreciation = Math.floor((depreciation * a.business_ratio) / 100);
    return { ...a, depreciation, bookValue, bookValueBefore, businessDepreciation };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      acquisition: acc.acquisition + r.acquisition_cost,
      bookValueBefore: acc.bookValueBefore + r.bookValueBefore,
      depreciation: acc.depreciation + r.depreciation,
      businessDepreciation: acc.businessDepreciation + r.businessDepreciation,
    }),
    { acquisition: 0, bookValueBefore: 0, depreciation: 0, businessDepreciation: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">固定資産台帳</h1>
        <div className="flex gap-2">
          <Select value={String(year)} onValueChange={(v) => v && setYear(parseInt(v, 10))}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 2 + i).map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}年度
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            固定資産を登録
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">固定資産がまだ登録されていません。</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ステータス</TableHead>
                  <TableHead>取得日</TableHead>
                  <TableHead>資産名</TableHead>
                  <TableHead>勘定科目</TableHead>
                  <TableHead className="text-right">取得価額</TableHead>
                  <TableHead className="text-right">償却前残高</TableHead>
                  <TableHead className="text-right">減価償却費</TableHead>
                  <TableHead className="text-right">事業分</TableHead>
                  <TableHead className="text-right">期末残高</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow className="bg-muted/30 font-semibold">
                  <TableCell colSpan={4}>{rows.length}件の合計</TableCell>
                  <TableCell className="text-right">
                    {totals.acquisition.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {totals.bookValueBefore.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {totals.depreciation.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {totals.businessDepreciation.toLocaleString()}
                  </TableCell>
                  <TableCell colSpan={2}></TableCell>
                </TableRow>
                {rows.map((r) => {
                  const isDepreciating =
                    r.depreciation_method !== "none" && r.depreciation > 0;
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Badge
                          variant={isDepreciating ? "default" : "outline"}
                          className="text-xs"
                        >
                          {r.depreciation_method === "none"
                            ? "償却なし"
                            : isDepreciating
                              ? "償却中"
                              : "償却済"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{r.acquisition_date}</TableCell>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {getAccountByCode(r.asset_account_code)?.name || "-"}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.acquisition_cost.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.bookValueBefore.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.depreciation.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {r.businessDepreciation.toLocaleString()}
                        {r.business_ratio < 100 && (
                          <span className="text-xs ml-1">({r.business_ratio}%)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.bookValue.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleDelete(r.id)}
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
            <DialogTitle>固定資産を登録</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>資産名 *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="例: MacBook Pro 14インチ"
              />
            </div>
            <div>
              <Label>勘定科目</Label>
              <Select
                value={form.asset_account_code}
                onValueChange={(v) => v && setForm({ ...form, asset_account_code: v })}
              >
                <SelectTrigger>
                  <SelectValue>
                    {getAccountByCode(form.asset_account_code)?.name ?? form.asset_account_code}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {DEFAULT_ACCOUNTS.filter((a) =>
                    ASSET_ACCOUNT_CODES.includes(a.code)
                  ).map((a) => (
                    <SelectItem key={a.code} value={a.code}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>取得日 *</Label>
                <Input
                  type="date"
                  value={form.acquisition_date}
                  onChange={(e) =>
                    setForm({ ...form, acquisition_date: e.target.value })
                  }
                />
              </div>
              <div>
                <Label>取得価額 *</Label>
                <Input
                  type="number"
                  value={form.acquisition_cost || ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      acquisition_cost: parseInt(e.target.value, 10) || 0,
                    })
                  }
                />
              </div>
            </div>
            <div>
              <Label>償却方法</Label>
              <Select
                value={form.depreciation_method}
                onValueChange={(v) =>
                  v && setForm({ ...form, depreciation_method: v as typeof form.depreciation_method })
                }
              >
                <SelectTrigger>
                  <SelectValue>
                    {form.depreciation_method === "straight_line" ? "定額法" : "償却なし（土地など）"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="straight_line">定額法</SelectItem>
                  <SelectItem value="none">償却なし（土地など）</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.depreciation_method !== "none" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>耐用年数</Label>
                  <Input
                    type="number"
                    value={form.useful_life_years}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        useful_life_years: parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
                <div>
                  <Label>事業利用率(%)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={form.business_ratio}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        business_ratio: parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              キャンセル
            </Button>
            <Button
              onClick={handleSave}
              disabled={!form.name || !form.acquisition_cost || saving}
            >
              {saving ? "保存中..." : "登録"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
