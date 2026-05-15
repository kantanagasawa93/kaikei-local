"use client";

/**
 * Round 28: Gemini Free Tier の本日利用枠超過を伝えるバナー.
 *
 * /inbox /receipts/new /invoices/from-po /settings の上部に常時マウントし、
 * quota 状態を 5 分おきに見直す。超過中なら琥珀色のバナーで
 *   - リセットまでの残り時間
 *   - 課金有効化への外部リンク
 * を案内する。
 */

import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { getQuotaState } from "@/lib/ai-ocr-quota";

interface BannerState {
  exhausted: boolean;
  hoursLeft?: number;
  resetStr?: string;
}

export function AiOcrQuotaBanner() {
  const [state, setState] = useState<BannerState | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const s = await getQuotaState();
        if (cancelled) return;
        setState({
          exhausted: s.exhausted,
          hoursLeft: s.hoursUntilReset,
          resetStr: s.nextReset?.toLocaleString("ja-JP", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
        });
      } catch {
        if (!cancelled) setState({ exhausted: false });
      }
    };
    void check();
    const id = setInterval(() => void check(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!state?.exhausted) return null;

  const hours = state.hoursLeft ?? 0;
  // 1 時間未満は分単位で表示する方が分かりやすい
  const remaining =
    hours < 1
      ? `あと約 ${Math.max(1, Math.round(hours * 60))} 分`
      : `あと約 ${hours.toFixed(1)} 時間`;

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm shadow-sm">
      <p className="font-medium text-amber-900 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
        AI OCR の本日利用枠を超過しています
      </p>
      <p className="text-xs text-amber-800 mt-1 leading-relaxed">
        Gemini API の Free Tier 枠 (1 日 20 回) を使い切りました。
        <b className="mx-1">{remaining}</b>
        ({state.resetStr} 頃) に自動リセットされます。
        それまで AI 読み取り (受信箱の自動仕訳・発注書 OCR) は使えません。
      </p>
      <p className="text-xs text-amber-800 mt-2">
        恒久対応:{" "}
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noreferrer"
          className="underline inline-flex items-center gap-0.5 font-medium"
        >
          Google AI Studio で API key の課金を有効化
          <ExternalLink className="h-3 w-3" />
        </a>
        {" "}すると無制限に使えます (個人事業主の利用量なら月数円〜数十円)。
      </p>
    </div>
  );
}
