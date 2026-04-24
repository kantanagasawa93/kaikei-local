"use client";

/**
 * e-Tax 向け納税者情報設定ページ。
 *
 * ここで入力した内容は XTX 生成時に IT 部 (納税者情報共通部分)
 * に展開される。入力項目の並びは確定申告書上の順序に概ね揃える。
 *
 * 保存先: app_settings テーブルの id="taxpayer_info" に JSON で格納。
 */

import { useEffect, useMemo, useState } from "react";
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
import {
  ArrowLeft,
  Save,
  AlertCircle,
  CheckCircle2,
  FlaskConical,
  Search,
  Loader2,
} from "lucide-react";
import {
  loadTaxpayerInfo,
  saveTaxpayerInfo,
  emptyTaxpayerInfo,
  validateTaxpayer,
  splitErrors,
  toFieldMap,
  normalizePostal,
  normalizePhone,
  normalizeRiyoshaId,
  type TaxpayerInfo,
  type EraName,
  type ValidationError,
} from "@/lib/etax";
import {
  lookupPostalCode,
  formatAddress,
  type ZipCloudResult,
} from "@/lib/zipcloud";

/**
 * 動作確認用プリセット (scripts/gen_real_xtx.mjs と同値)。
 * 開発者本人の EatScene 事業所データ — 申告実績あり。
 */
const SAMPLE_TAXPAYER: TaxpayerInfo = {
  zeimusho_cd: "10107",
  zeimusho_nm: "香椎",
  name: "永澤幹太",
  name_kana: "ナガサワ カンタ",
  birthday_wareki: { era: "平成", yy: 5, mm: 1, dd: 29 },
  postal_code: "8130045",
  address: "福岡県福岡市東区みどりが丘3-12-10",
  phone: "08017746358",
  yago: "EatScene",
  shokugyo: "個人事業主",
  jigyo_naiyo: "飲食",
  riyosha_shikibetsu_bango: "1737122600932098",
};

/**
 * フィールド直下にエラーメッセージを1件表示する小コンポーネント。
 */
function FieldError({ errors }: { errors?: ValidationError[] }) {
  if (!errors || errors.length === 0) return null;
  const msg = errors[0].message;
  const isWarn = errors[0].severity === "warning";
  return (
    <p
      className={`text-xs mt-1 ${
        isWarn ? "text-yellow-700" : "text-red-600"
      }`}
    >
      {msg}
    </p>
  );
}

/**
 * 必須マーク付きラベル。
 */
function ReqLabel({
  children,
  required,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <Label>
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </Label>
  );
}

export default function EtaxSettingsPage() {
  const [form, setForm] = useState<TaxpayerInfo>(emptyTaxpayerInfo());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 一度でも保存/変更を試みた後のみ、フィールドエラーを表示する
  const [dirty, setDirty] = useState(false);
  // 郵便番号検索中フラグ
  const [zipLookup, setZipLookup] = useState(false);
  // 検索で複数町域が返った場合に、ユーザーに選ばせるための候補リスト
  const [zipCandidates, setZipCandidates] = useState<ZipCloudResult[]>([]);

  useEffect(() => {
    (async () => {
      const existing = await loadTaxpayerInfo();
      if (existing) {
        setForm(existing);
        setDirty(true); // 既存データあれば最初からエラー表示
      }
      setLoaded(true);
    })();
  }, []);

  const u = <K extends keyof TaxpayerInfo>(k: K, v: TaxpayerInfo[K]) => {
    setForm((p) => ({ ...p, [k]: v }));
    if (!dirty) setDirty(true);
  };

  const validationErrors = useMemo(
    () => (loaded ? validateTaxpayer(form) : []),
    [form, loaded]
  );
  const validation = useMemo(
    () => splitErrors(validationErrors),
    [validationErrors]
  );
  const fieldMap = useMemo(
    () => toFieldMap(validationErrors),
    [validationErrors]
  );

  const handleSave = async () => {
    setDirty(true);
    if (validation.errors.length > 0) {
      setMessage("必須項目が未入力です。赤字の項目を確認してください。");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      // 保存時に数字系フィールドを正規化してから書き込み
      const normalized: TaxpayerInfo = {
        ...form,
        postal_code: normalizePostal(form.postal_code),
        phone: normalizePhone(form.phone),
        riyosha_shikibetsu_bango: normalizeRiyoshaId(form.riyosha_shikibetsu_bango),
        jigyosho_postal: form.jigyosho_postal
          ? normalizePostal(form.jigyosho_postal)
          : form.jigyosho_postal,
        jigyosho_phone: form.jigyosho_phone
          ? normalizePhone(form.jigyosho_phone)
          : form.jigyosho_phone,
      };
      await saveTaxpayerInfo(normalized);
      setForm(normalized);
      setMessage("保存しました");
      setTimeout(() => setMessage(null), 2500);
    } catch (e) {
      setMessage(`保存に失敗: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  /**
   * 郵便番号から住所を検索。
   * - 候補1件 かつ 住所空 → 自動挿入
   * - 候補1件 かつ 住所入力済 → confirm で上書き確認
   * - 候補2件以上 → 下部に候補リストを表示、ユーザーが選択
   */
  const handleZipLookup = async () => {
    const digits = normalizePostal(form.postal_code);
    if (digits.length !== 7) {
      setMessage("郵便番号は7桁すべて入力してください。");
      return;
    }
    setZipLookup(true);
    setMessage(null);
    setZipCandidates([]);
    try {
      const results = await lookupPostalCode(digits);
      if (results.length === 0) {
        setMessage(
          "該当する住所が見つかりませんでした。郵便番号をご確認ください。"
        );
        return;
      }
      if (results.length > 1) {
        setZipCandidates(results);
        setMessage(
          `この郵便番号には ${results.length} 町域あります。下のリストから選んでください。`
        );
        return;
      }
      // 候補1件のみ
      applyZipCandidate(results[0]);
    } catch (e) {
      setMessage(`郵便番号検索に失敗: ${(e as Error).message}`);
    } finally {
      setZipLookup(false);
    }
  };

  const applyZipCandidate = (r: ZipCloudResult) => {
    const newAddr = formatAddress(r);
    if (
      form.address.trim() &&
      form.address !== newAddr &&
      !window.confirm(
        `住所を「${newAddr}」に置き換えます。よろしいですか？\n（建物名・部屋番号は再入力してください）`
      )
    ) {
      return;
    }
    setForm((p) => ({ ...p, address: newAddr }));
    setDirty(true);
    setZipCandidates([]);
    setMessage(
      `${newAddr} を設定しました。建物名・号室などがあれば追記してください。`
    );
  };

  const handleLoadSample = () => {
    if (
      !window.confirm(
        "入力中の内容を破棄して、開発者サンプル (EatScene / 永澤幹太) を読み込みます。よろしいですか？"
      )
    ) {
      return;
    }
    setForm(SAMPLE_TAXPAYER);
    setDirty(true);
    setMessage("サンプルを読み込みました。保存ボタンを押すと反映されます。");
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
        <div className="flex gap-2">
          {process.env.NODE_ENV !== "production" && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleLoadSample}
              title="開発者サンプル (EatScene) を読み込む [開発ビルドのみ]"
            >
              <FlaskConical className="h-4 w-4 mr-1" />
              サンプル
            </Button>
          )}
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4 mr-1" />
            保存
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        ここに入力した内容は <code className="px-1 bg-muted rounded">e-Tax</code>{" "}
        提出ページで XTX ファイルを生成する際に使われます。
        <span className="text-red-500 ml-1">*</span>
        は必須項目です。
      </p>

      {message && (
        <div className="rounded-md border px-4 py-2 text-sm bg-blue-50 border-blue-200 text-blue-800">
          {message}
        </div>
      )}

      {dirty && validation.errors.length > 0 && (
        <div className="rounded-md border px-4 py-3 bg-red-50 border-red-200 text-red-800">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <div className="space-y-1 text-sm">
              <p className="font-medium">
                必須項目が未入力です ({validation.errors.length}件)
              </p>
              <ul className="list-disc pl-4">
                {validation.errors.slice(0, 6).map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
      {dirty && validation.errors.length === 0 && (
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
            <ReqLabel required>氏名（漢字）</ReqLabel>
            <Input
              value={form.name}
              onChange={(e) => u("name", e.target.value)}
              placeholder="永澤 幹太"
            />
            {dirty && <FieldError errors={fieldMap["taxpayer.name"]} />}
          </div>
          <div>
            <ReqLabel required>氏名フリガナ</ReqLabel>
            <Input
              value={form.name_kana}
              onChange={(e) => u("name_kana", e.target.value)}
              placeholder="ナガサワ カンタ"
            />
            {dirty && <FieldError errors={fieldMap["taxpayer.name_kana"]} />}
          </div>

          <div>
            <ReqLabel required>郵便番号 (7桁)</ReqLabel>
            <div className="flex gap-1">
              <Input
                value={form.postal_code}
                onChange={(e) =>
                  u("postal_code", normalizePostal(e.target.value))
                }
                placeholder="8130045"
                maxLength={7}
                inputMode="numeric"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleZipLookup}
                disabled={
                  zipLookup || normalizePostal(form.postal_code).length !== 7
                }
                title="郵便番号から住所を検索 (zipcloud)"
              >
                {zipLookup ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
              </Button>
            </div>
            {dirty && <FieldError errors={fieldMap["taxpayer.postal_code"]} />}
          </div>
          <div>
            <ReqLabel required>電話番号</ReqLabel>
            <Input
              value={form.phone}
              onChange={(e) => u("phone", normalizePhone(e.target.value))}
              placeholder="090-1234-5678"
              inputMode="tel"
            />
            {dirty && <FieldError errors={fieldMap["taxpayer.phone"]} />}
          </div>

          <div className="col-span-2">
            <ReqLabel required>住所</ReqLabel>
            <Input
              value={form.address}
              onChange={(e) => u("address", e.target.value)}
              placeholder="福岡県福岡市東区みどりが丘3-12-10"
            />
            {dirty && <FieldError errors={fieldMap["taxpayer.address"]} />}
            {zipCandidates.length > 0 && (
              <div className="mt-2 rounded-md border bg-muted/30 p-2 space-y-1">
                <p className="text-xs text-muted-foreground mb-1">
                  候補を選択（あなたの町域をクリック）:
                </p>
                {zipCandidates.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => applyZipCandidate(r)}
                    className="block w-full text-left text-sm px-2 py-1.5 rounded hover:bg-background border"
                  >
                    {formatAddress(r)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="col-span-2 grid grid-cols-4 gap-2">
            <div>
              <ReqLabel required>生年 元号</ReqLabel>
              <Select
                value={form.birthday_wareki.era}
                onValueChange={(v) =>
                  u("birthday_wareki", {
                    ...form.birthday_wareki,
                    era: v as EraName,
                  })
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
              <ReqLabel required>生年</ReqLabel>
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
              <ReqLabel required>月</ReqLabel>
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
              <ReqLabel required>日</ReqLabel>
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
            {dirty && (
              <div className="col-span-4">
                <FieldError
                  errors={
                    fieldMap["taxpayer.birthday_wareki"] ||
                    fieldMap["taxpayer.birthday_wareki.yy"] ||
                    fieldMap["taxpayer.birthday_wareki.mm"] ||
                    fieldMap["taxpayer.birthday_wareki.dd"]
                  }
                />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">事業情報</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div>
            <ReqLabel>職業</ReqLabel>
            <Input
              value={form.shokugyo || ""}
              onChange={(e) => u("shokugyo", e.target.value)}
              placeholder="個人事業主 / ソフトウェアエンジニア など"
            />
          </div>
          <div>
            <ReqLabel>屋号</ReqLabel>
            <Input
              value={form.yago || ""}
              onChange={(e) => u("yago", e.target.value)}
              placeholder="EatScene"
            />
            {dirty && <FieldError errors={fieldMap["taxpayer.yago"]} />}
          </div>
          <div className="col-span-2">
            <ReqLabel>事業内容</ReqLabel>
            <Input
              value={form.jigyo_naiyo || ""}
              onChange={(e) => u("jigyo_naiyo", e.target.value)}
              placeholder="飲食 / Webシステム受託開発 など"
            />
          </div>
          <div>
            <ReqLabel>事業所名</ReqLabel>
            <Input
              value={form.jigyosho_nm || ""}
              onChange={(e) => u("jigyosho_nm", e.target.value)}
              placeholder="屋号と同じなら空欄で可"
            />
          </div>
          <div>
            <ReqLabel>事業所電話</ReqLabel>
            <Input
              value={form.jigyosho_phone || ""}
              onChange={(e) =>
                u("jigyosho_phone", normalizePhone(e.target.value))
              }
              placeholder="自宅と同じなら空欄で可"
              inputMode="tel"
            />
          </div>
          <div>
            <ReqLabel>事業所郵便番号</ReqLabel>
            <Input
              value={form.jigyosho_postal || ""}
              onChange={(e) =>
                u("jigyosho_postal", normalizePostal(e.target.value))
              }
              maxLength={7}
              inputMode="numeric"
            />
          </div>
          <div className="col-span-2">
            <ReqLabel>事業所住所</ReqLabel>
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
            <ReqLabel required>所轄税務署コード (5桁)</ReqLabel>
            <Input
              value={form.zeimusho_cd}
              onChange={(e) =>
                u("zeimusho_cd", e.target.value.replace(/\D/g, "").slice(0, 5))
              }
              placeholder="10107"
              maxLength={5}
              inputMode="numeric"
            />
            <p className="text-xs text-muted-foreground mt-1">
              国税庁サイトの「税務署の所在地・案内」で確認できます。
            </p>
            {dirty && <FieldError errors={fieldMap["taxpayer.zeimusho_cd"]} />}
          </div>
          <div>
            <ReqLabel required>所轄税務署名</ReqLabel>
            <Input
              value={form.zeimusho_nm}
              onChange={(e) => u("zeimusho_nm", e.target.value)}
              placeholder="香椎"
            />
            {dirty && <FieldError errors={fieldMap["taxpayer.zeimusho_nm"]} />}
          </div>

          <div className="col-span-2">
            <ReqLabel required>利用者識別番号 (16桁)</ReqLabel>
            <Input
              value={form.riyosha_shikibetsu_bango}
              onChange={(e) =>
                u("riyosha_shikibetsu_bango", normalizeRiyoshaId(e.target.value))
              }
              placeholder="1234567890123456"
              maxLength={16}
              inputMode="numeric"
            />
            <p className="text-xs text-muted-foreground mt-1">
              e-Tax 利用開始届出書を提出した際に発行された16桁の番号。
              freee 等から e-Tax 送信したことがあれば持っています。
              不明な場合は e-Tax サイトの「利用者識別番号等の通知」で再発行可能。
            </p>
            {dirty && (
              <FieldError
                errors={fieldMap["taxpayer.riyosha_shikibetsu_bango"]}
              />
            )}
          </div>
        </CardContent>
      </Card>

      <div className="rounded-md bg-muted/50 border p-4 text-xs space-y-1 text-muted-foreground">
        <p className="font-medium text-foreground">🔐 プライバシーについて</p>
        <p>
          この情報はローカルDB (kaikei.db) にのみ保存されます。利用者識別番号・マイナンバー等は
          クラウドには送信されません。バックアップ ZIP にも含まれるので、取扱いに注意してください。
        </p>
        <p>
          郵便番号の住所検索 (🔍 ボタン) を押した時のみ、外部の
          zipcloud.ibsnet.co.jp に郵便番号が送信されます。名前・住所・識別番号は送信されません。
        </p>
      </div>
    </div>
  );
}
