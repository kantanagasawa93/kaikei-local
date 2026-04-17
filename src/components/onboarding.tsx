"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Receipt,
  BookOpen,
  Smartphone,
  BarChart3,
  FileSignature,
  Shield,
  ArrowRight,
  Check,
} from "lucide-react";

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
      "仕訳から青色申告決算書の数字を自動集計。所得税・消費税を計算し、PDFで出力。e-Taxサイトで提出できます。",
    color: "text-red-600",
  },
];

export function Onboarding() {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    // 初回起動チェック: app_settings テーブルで onboarding_done を確認
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
        }
      } catch {
        setShow(true);
      }
    })();
  }, []);

  const handleComplete = async () => {
    setShow(false);
    try {
      const { db } = await import("@/lib/localDb");
      // 既に行があれば更新、なければ INSERT
      const { data } = await db
        .from("app_settings")
        .select("key")
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

  if (!show) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const Icon = current.icon;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <Card className="max-w-lg w-full shadow-2xl">
        <CardContent className="p-8 text-center space-y-6">
          {/* ステップインジケーター */}
          <div className="flex justify-center gap-2">
            {STEPS.map((_, i) => (
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

          {/* アイコン */}
          <div
            className={`mx-auto w-16 h-16 rounded-2xl bg-muted flex items-center justify-center ${current.color}`}
          >
            <Icon className="w-8 h-8" />
          </div>

          {/* テキスト */}
          <div className="space-y-2">
            <h2 className="text-xl font-bold">{current.title}</h2>
            <p className="text-muted-foreground leading-relaxed">
              {current.description}
            </p>
          </div>

          {/* ボタン */}
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
            {isLast ? (
              <Button onClick={handleComplete} className="px-8">
                <Check className="w-4 h-4 mr-1" />
                はじめる
              </Button>
            ) : (
              <Button onClick={() => setStep(step + 1)} className="px-8">
                次へ
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
          </div>

          {/* スキップ */}
          {!isLast && (
            <button
              onClick={handleComplete}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              スキップ
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
