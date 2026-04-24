"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Receipt,
  BookOpen,
  BarChart3,
  FileSignature,
  Shield,
  ArrowRight,
  Check,
  UserCircle,
} from "lucide-react";
import {
  loadTaxpayerInfo,
  saveTaxpayerInfo,
  emptyTaxpayerInfo,
  normalizeRiyoshaId,
  type TaxpayerInfo,
} from "@/lib/etax";

const STEPS = [
  {
    icon: Shield,
    title: "ようこそ KAIKEI LOCAL へ",
    description:
      "個人事業主のための確定申告アプリ。データは全てこのMacのローカルに保存されます。クラウドへの送信は一切ありません。",
    color: "text-blue-600",
  },
  {
    icon: Receipt,
    title: "領収書をためる",
    description:
      "Finder や 写真アプリから直接ドラッグ＆ドロップ。スマホで撮った写真はQRコードから送信できます（同じWi-Fi内）。",
    color: "text-green-600",
  },
  {
    icon: BookOpen,
    title: "仕訳は半自動",
    description:
      "銀行やクレカのCSVを取り込めば、自動登録ルールが勘定科目を推測。使うほど正答率が上がります。",
    color: "text-purple-600",
  },
  {
    icon: FileSignature,
    title: "請求書もここで",
    description:
      "適格請求書（インボイス）フォーマットのPDFを出力。取引先マスタ連携で宛名自動入力。",
    color: "text-orange-600",
  },
  {
    icon: BarChart3,
    title: "確定申告を楽に",
    description:
      "仕訳から青色申告決算書の数字を自動集計。所得税・消費税を計算し、e-Tax 用 XTX / PDF を出力します。",
    color: "text-red-600",
  },
] as const;

// スライド数
const SLIDE_COUNT = STEPS.length;
// 基本情報入力ステップのインデックス (スライドの後)
const INFO_STEP = SLIDE_COUNT;

export function Onboarding() {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);

  // 基本情報入力用 state
  const [info, setInfo] = useState<TaxpayerInfo>(emptyTaxpayerInfo());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { db } = await import("@/lib/localDb");
        const { data } = await db
          .from("app_settings")
          .select("value")
          .eq("id", "onboarding_done")
          .single();
        if (!data || data.value !== "true") {
          setShow(true);
          const existing = await loadTaxpayerInfo();
          if (existing) setInfo(existing);
        }
      } catch {
        setShow(true);
      }
    })();
  }, []);

  const markDone = async () => {
    try {
      const { db } = await import("@/lib/localDb");
      const { data } = await db
        .from("app_settings")
        .select("id")
        .eq("id", "onboarding_done")
        .single();
      if (data) {
        await db
          .from("app_settings")
          .update({ value: "true", updated_at: new Date().toISOString() })
          .eq("id", "onboarding_done");
      } else {
        await db.from("app_settings").insert({
          id: "onboarding_done",
          value: "true",
          updated_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.warn("Failed to save onboarding state:", e);
    }
  };

  const handleSkipInfo = async () => {
    await markDone();
    setShow(false);
  };

  const handleSaveInfo = async () => {
    setSaving(true);
    try {
      // 最低限の非空フィールドだけ保存 (バリデーションは設定画面で)
      await saveTaxpayerInfo(info);
      await markDone();
      setShow(false);
    } catch (e) {
      console.warn("Failed to save taxpayer info:", e);
      // エラーでも閉じる (設定画面から後で入力可能)
      await markDone();
      setShow(false);
    } finally {
      setSaving(false);
    }
  };

  if (!show) return null;

  // 基本情報入力ステップ
  if (step === INFO_STEP) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <Card className="max-w-xl w-full shadow-2xl">
          <CardContent className="p-8 space-y-5">
            <div className="flex justify-center gap-2">
              {Array.from({ length: SLIDE_COUNT + 1 }).map((_, i) => (
                <div
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${
                    i === step ? "w-8 bg-primary" : "w-4 bg-primary/40"
                  }`}
                />
              ))}
            </div>

            <div className="flex flex-col items-center text-center gap-2">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center text-blue-600">
                <UserCircle className="w-8 h-8" />
              </div>
              <h2 className="text-xl font-bold">基本情報を入力（任意）</h2>
              <p className="text-sm text-muted-foreground">
                今入力すると、請求書・確定申告書にすぐ反映されます。
                後で「設定 → e-Tax 納税者情報」から編集できます。
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-1">
                <Label className="text-xs">氏名（漢字）</Label>
                <Input
                  value={info.name}
                  onChange={(e) =>
                    setInfo((p) => ({ ...p, name: e.target.value }))
                  }
                  placeholder="永澤 幹太"
                />
              </div>
              <div className="col-span-1">
                <Label className="text-xs">氏名フリガナ</Label>
                <Input
                  value={info.name_kana}
                  onChange={(e) =>
                    setInfo((p) => ({ ...p, name_kana: e.target.value }))
                  }
                  placeholder="ナガサワ カンタ"
                />
              </div>
              <div className="col-span-1">
                <Label className="text-xs">屋号</Label>
                <Input
                  value={info.yago || ""}
                  onChange={(e) =>
                    setInfo((p) => ({ ...p, yago: e.target.value }))
                  }
                  placeholder="EatScene"
                />
              </div>
              <div className="col-span-1">
                <Label className="text-xs">職業</Label>
                <Input
                  value={info.shokugyo || ""}
                  onChange={(e) =>
                    setInfo((p) => ({ ...p, shokugyo: e.target.value }))
                  }
                  placeholder="個人事業主"
                />
              </div>
              <div className="col-span-2">
                <Label className="text-xs">
                  利用者識別番号 (e-Tax 16桁、あれば)
                </Label>
                <Input
                  value={info.riyosha_shikibetsu_bango}
                  onChange={(e) =>
                    setInfo((p) => ({
                      ...p,
                      riyosha_shikibetsu_bango: normalizeRiyoshaId(
                        e.target.value
                      ),
                    }))
                  }
                  placeholder="1234567890123456"
                  maxLength={16}
                  inputMode="numeric"
                  className="font-mono"
                />
              </div>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              この情報はローカル DB にのみ保存され、クラウドには送信されません。
            </p>

            <div className="flex gap-3 justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => setStep(SLIDE_COUNT - 1)}
              >
                戻る
              </Button>
              <Button variant="ghost" onClick={handleSkipInfo}>
                あとで入力
              </Button>
              <Button onClick={handleSaveInfo} disabled={saving}>
                <Check className="w-4 h-4 mr-1" />
                保存してはじめる
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // 通常のスライドステップ
  const current = STEPS[step];
  const isLastSlide = step === SLIDE_COUNT - 1;
  const Icon = current.icon;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="max-w-lg w-full shadow-2xl">
        <CardContent className="p-8 text-center space-y-6">
          <div className="flex justify-center gap-2">
            {Array.from({ length: SLIDE_COUNT + 1 }).map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step
                    ? "w-8 bg-primary"
                    : i < step
                      ? "w-4 bg-primary/40"
                      : "w-4 bg-muted"
                }`}
              />
            ))}
          </div>

          <div
            className={`mx-auto w-16 h-16 rounded-2xl bg-muted flex items-center justify-center ${current.color}`}
          >
            <Icon className="w-8 h-8" />
          </div>

          <div className="space-y-2">
            <h2 className="text-xl font-bold">{current.title}</h2>
            <p className="text-muted-foreground leading-relaxed">
              {current.description}
            </p>
          </div>

          <div className="flex gap-3 justify-center pt-2">
            {step > 0 && (
              <Button
                variant="outline"
                onClick={() => setStep(step - 1)}
                className="px-6"
              >
                戻る
              </Button>
            )}
            <Button onClick={() => setStep(step + 1)} className="px-8">
              {isLastSlide ? "基本情報入力へ" : "次へ"}
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          </div>

          <button
            onClick={handleSkipInfo}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            スキップ
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
