"use client";

/**
 * AI OCR データ送信の明示同意ダイアログ。
 *
 * 領収書画像を外部サーバー (api.kaikei-local.com) に送信し
 * Google Gemini で解析するため、初回利用時に一度だけ表示する。
 * 合意は app_settings.ai_ocr_consent に保持され、次回以降はスキップ。
 *
 * 使い方:
 *   const [needsConsent, setNeedsConsent] = useState(false);
 *   const runOcr = async () => {
 *     if (!(await hasAiOcrConsent())) { setNeedsConsent(true); return; }
 *     // ... 実 OCR 処理
 *   };
 *   <AiOcrConsentDialog
 *     open={needsConsent}
 *     onAgree={async () => { await setAiOcrConsent(true); setNeedsConsent(false); await runOcr(); }}
 *     onDecline={() => setNeedsConsent(false)}
 *   />
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ExternalLink } from "lucide-react";

export function AiOcrConsentDialog({
  open,
  onAgree,
  onDecline,
}: {
  open: boolean;
  onAgree: () => void;
  onDecline: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onDecline(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-blue-600" />
            AI 読み取りのデータ送信について
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm space-y-3 py-2">
          <p>
            領収書の AI 読み取り機能を使うには、画像データを外部サーバーに送信する必要があります。初回のみ同意をお願いします。
          </p>

          <div className="rounded-md border bg-muted/40 p-3 space-y-1.5 text-xs">
            <p><b>送信先:</b> <code>api.kaikei-local.com</code> → Google Gemini 2.5 Flash</p>
            <p><b>送信する内容:</b> 領収書画像 (base64) のみ。氏名・住所・利用者識別番号などの納税者情報は一切送信しません。</p>
            <p><b>保存:</b> サーバー側で解析後に即座に破棄。AI の学習にも使われません。</p>
            <p><b>通信:</b> HTTPS 暗号化済み</p>
            <p><b>任意性:</b> AI 読み取りを使わず、手動で仕訳登録することもできます。</p>
          </div>

          <p className="text-xs text-muted-foreground">
            詳しくは
            <a
              href="/legal"
              className="underline inline-flex items-center gap-0.5 ml-1"
            >
              プライバシーポリシー
              <ExternalLink className="h-3 w-3" />
            </a>
            をご確認ください。設定画面からいつでも同意を撤回できます。
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onDecline}>
            同意しない (手動入力で使う)
          </Button>
          <Button onClick={onAgree}>
            同意して AI 読み取りを使う
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
