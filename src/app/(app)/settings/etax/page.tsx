"use client";

/**
 * e-Tax 向け納税者情報設定ページ。
 *
 * ここで入力した内容は XTX 生成時に IT 部 (納税者情報共通部分)
 * に展開される。入力項目の並びは確定申告書上の順序に概ね揃える。
 *
 * 保存先: app_settings テーブルの id="taxpayer_info" に JSON で格納。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Save, AlertCircle, CheckCircle2 } from "lucide-react";
import {
  loadTaxpayerInfo,
  saveTaxpayerInfo,
  emptyTaxpayerInfo,
  validateTaxpayer,
  splitErrors,
  type TaxpayerInfo,
  type EraName,
} from "@/lib/etax";

export default function EtaxSettingsPage() {
  const [form, setForm] = useState<TaxpayerInfo>(emptyTaxpayerInfo());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const existing = await loadTaxpayerInfo();
      if (existing) setForm(existing);
      setLoaded(true);
    })();
  }, []);

  const u = <K extends keyof TaxpayerInfo>(k: K, v: TaxpayerInfo[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  const validation = loaded ? splitErrors(validateTaxpayer(form)) : null;

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await saveTaxpayerInfo(form);
      setMessage("保存しました");
      setTimeout(() => setMessage(null), 2500);
    } catch (e) {
      setMessage(`保存に失敗: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return <div className="text-muted-foreground">読込中...</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/settings/">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              戻る
            </Button>
          </Link>
          <h1 className="text-2xl font-bold">e-Tax 納税者情報</h1>
        </div>
        <Button onClick={handleSave} disabled={saving}>
          <Save className="h-4 w-4 mr-1" />
          保存
        </Button>
      </div>

      {message && (
        <div className="rounded-md border px-4 py-2 text-sm bg-blue-50 border-blue-200 text-blue-800">
          {message}
        </div>
      )}

      {validation && validation.errors.length > 0 && (
        <div className="rounded-md border px-4 py-3 bg-red-50 border-red-200 text-red-800">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="space-y-1 text-sm">
              <p className="font-medium">必須項目が未入力です ({validation.errors.length}件)</p>
              <ul className="list-disc pl-4">
                {validation.errors.slice(0, 6).map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {validation && validation.errors.length === 0 && (
        <div className="rounded-md border px-4 py-2 text-sm bg-green-50 border-green-200 text-green-800 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          入力完了。e-Tax 送信に必要な情報はそろっています。
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">本人情報</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <Label>氏名（漢字）</Label>
            <Input
              value={form.name}
              onChange={(e) => u("name", e.target.value)}
              placeholder="長澤 寛太"
            />
          </div>
          <div>
            <Label>氏名フリガナ</Label>
            <Input
              value={form.name_kana}
              onChange={(e) => u("name_kana", e.target.value)}
              placeholder="ナガサワ カンタ"
            />
          </div>

          <div>
            <Label>郵便番号 (7桁)</Label>
            <Input
              value={form.postal_code}
              onChange={(e) => u("postal_code", e.target.value)}
              placeholder="1000001"
              maxLength={10}
            />
          </div>
          <div>
            <Label>電話番号</Label>
            <Input
              value={form.phone}
              onChange={(e) => u("phone", e.target.value)}
              placeholder="090-1234-5678"
            />
          </div>

          <div className="col-span-2">
            <Label>住所</Label>
            <Input
              value={form.address}
              onChange={(e) => u("address", e.target.value)}
              placeholder="東京都千代田区千代田1-1-1"
            />
          </div>

          <div className="col-span-2 grid grid-cols-4 gap-2">
            <div>
              <Label>生年 元号</Label>
              <Select
                value={form.birthday_wareki.era}
                onValueChange={(v) =>
                  u("birthday_wareki", { ...form.birthday_wareki, era: v as EraName })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="明治">明治</SelectItem>
                  <SelectItem value="大正">大正</SelectItem>
                  <SelectItem value="昭和">昭和</SelectItem>
                  <SelectItem value="平成">平成</SelectItem>
                  <SelectItem value="令和">令和</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>生年</Label>
              <Input
                type="number"
                value={form.birthday_wareki.yy}
                onChange={(e) =>
                  u("birthday_wareki", {
                    ...form.birthday_wareki,
                    yy: parseInt(e.target.value || "0", 10),
                  })
                }
                min={1}
                max={99}
              />
            </div>
            <div>
              <Label>月</Label>
              <Input
                type="number"
                value={form.birthday_wareki.mm}
                onChange={(e) =>
                  u("birthday_wareki", {
                    ...form.birthday_wareki,
                    mm: parseInt(e.target.value || "0", 10),
                  })
                }
                min={1}
                max={12}
              />
            </div>
            <div>
              <Label>日</Label>
              <Input
                type="number"
                value={form.birthday_wareki.dd}
                onChange={(e) =>
                  u("birthday_wareki", {
                    ...form.birthday_wareki,
                    dd: parseInt(e.target.value || "0", 10),
                  })
                }
                min={1}
                max={31}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">事業情報</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <Label>職業</Label>
            <Input
              value={form.shokugyo || ""}
              onChange={(e) => u("shokugyo", e.target.value)}
              placeholder="ソフトウェアエンジニア"
            />
          </div>
          <div>
            <Label>屋号</Label>
            <Input
              value={form.yago || ""}
              onChange={(e) => u("yago", e.target.value)}
              placeholder="長澤事務所"
            />
          </div>
          <div className="col-span-2">
            <Label>事業内容</Label>
            <Input
              value={form.jigyo_naiyo || ""}
              onChange={(e) => u("jigyo_naiyo", e.target.value)}
              placeholder="Webシステム受託開発"
            />
          </div>
          <div>
            <Label>事業所名 (屋号と同じなら空欄可)</Label>
            <Input
              value={form.jigyosho_nm || ""}
              onChange={(e) => u("jigyosho_nm", e.target.value)}
            />
          </div>
          <div>
            <Label>事業所電話 (自宅と同じなら空欄可)</Label>
            <Input
              value={form.jigyosho_phone || ""}
              onChange={(e) => u("jigyosho_phone", e.target.value)}
            />
          </div>
          <div>
            <Label>事業所郵便番号</Label>
            <Input
              value={form.jigyosho_postal || ""}
              onChange={(e) => u("jigyosho_postal", e.target.value)}
            />
          </div>
          <div className="col-span-2">
            <Label>事業所住所</Label>
            <Input
              value={form.jigyosho_address || ""}
              onChange={(e) => u("jigyosho_address", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">税務署・e-Tax 情報</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <Label>所轄税務署コード (5桁)</Label>
            <Input
              value={form.zeimusho_cd}
              onChange={(e) => u("zeimusho_cd", e.target.value)}
              placeholder="01101"
              maxLength={5}
            />
            <p className="text-xs text-muted-foreground mt-1">
              国税庁サイトの「税務署の所在地・案内」で確認できます。
            </p>
          </div>
          <div>
            <Label>所轄税務署名</Label>
            <Input
              value={form.zeimusho_nm}
              onChange={(e) => u("zeimusho_nm", e.target.value)}
              placeholder="麹町"
            />
          </div>

          <div className="col-span-2">
            <Label>利用者識別番号 (16桁)</Label>
            <Input
              value={form.riyosha_shikibetsu_bango}
              onChange={(e) => u("riyosha_shikibetsu_bango", e.target.value)}
              placeholder="1234567812345678"
              maxLength={20}
            />
            <p className="text-xs text-muted-foreground mt-1">
              e-Tax 利用開始届出書を提出した際に発行された16桁の番号。
              freee 等から e-Tax 送信したことがあれば持っています。
              不明な場合は e-Tax サイトの「利用者識別番号等の通知」で再発行可能。
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-md bg-muted/50 border p-4 text-xs space-y-1 text-muted-foreground">
        <p className="font-medium text-foreground">🔐 プライバシーについて</p>
        <p>
          この情報はローカルDB (kaikei.db) にのみ保存されます。利用者識別番号・マイナンバー等は
          クラウドには送信されません。バックアップ ZIP にも含まれるので、取扱いに注意してください。
        </p>
      </div>
    </div>
  );
}
