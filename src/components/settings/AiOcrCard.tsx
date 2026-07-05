"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import {
  getLicenseKey,
  saveLicenseKey,
  verifyLicense,
  probeApiServer,
  hasAiOcrConsent,
  setAiOcrConsent,
} from "@/lib/ai-ocr";
import { AiOcrQuotaBanner } from "@/components/ai-ocr-quota-banner";
import Link from "next/link";

type LicenseInfo = {
  valid: boolean;
  plan?: string;
  status?: string;
  expires_at?: string;
  monthly_limit?: number;
  used_this_month?: number;
  reason?: string;
};

/** 設定画面「AI 読み取り」: 同意トグル + ライセンスキー + 使用量サマリ。 */
export function AiOcrCard() {
  const [licenseInput, setLicenseInput] = useState("");
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null);
  const [licenseBusy, setLicenseBusy] = useState(false);
  const [licenseMessage, setLicenseMessage] = useState<string | null>(null);
  // API サーバー生存フラグ (未デプロイなら false)
  const [apiAlive, setApiAlive] = useState<boolean | null>(null);
  // AI へのデータ送信同意フラグ
  const [aiConsent, setAiConsent] = useState(false);

  // 初回ロードで API サーバー probe + 既存キーを読み込み & verify
  useEffect(() => {
    (async () => {
      try {
        setAiConsent(await hasAiOcrConsent());
      } catch {
        /* 取得失敗は false 扱い */
      }
      const alive = await probeApiServer();
      setApiAlive(alive);
      if (!alive) return; // API 死んでたら verify スキップ
      try {
        const key = await getLicenseKey();
        if (!key) return;
        setLicenseInput(key);
        const info = await verifyLicense(key);
        setLicenseInfo(info);
      } catch {
        // ネットワーク不通時は放置
      }
    })();
  }, []);

  const handleToggleConsent = async (next: boolean) => {
    try {
      await setAiOcrConsent(next);
      setAiConsent(next);
      setLicenseMessage(next ? "AI 読み取りに同意しました。" : "AI 読み取りの同意を撤回しました。");
    } catch {
      setLicenseMessage("エラー: 同意状態の保存に失敗しました");
    }
  };

  const handleLicenseSave = async () => {
    const key = licenseInput.trim();
    if (!key) {
      setLicenseMessage("ライセンスキーを入力してください");
      return;
    }
    setLicenseBusy(true);
    setLicenseMessage(null);
    try {
      const info = await verifyLicense(key);
      if (!info.valid) {
        setLicenseInfo(info);
        setLicenseMessage(
          `認証失敗: ${info.reason || "不明なエラー"}。キーを確認して再度お試しください。`
        );
        return;
      }
      await saveLicenseKey(key);
      setLicenseInfo(info);
      setLicenseMessage("ライセンスキーを保存・認証しました。");
      setTimeout(() => setLicenseMessage(null), 3000);
    } catch (e) {
      setLicenseMessage(`エラー: ${(e as Error).message}`);
    } finally {
      setLicenseBusy(false);
    }
  };

  const handleLicenseClear = async () => {
    if (!window.confirm("保存済みのライセンスキーを削除しますか？\n無料プラン扱いに戻ります。")) {
      return;
    }
    try {
      await saveLicenseKey("");
      setLicenseInput("");
      setLicenseInfo(null);
      setLicenseMessage("ライセンスキーを削除しました。");
      setTimeout(() => setLicenseMessage(null), 2500);
    } catch (e) {
      setLicenseMessage(`削除失敗: ${(e as Error).message}`);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          ✨ AI 読み取り
          {licenseInfo?.valid ? (
            <Badge variant="default" className="font-normal">
              {licenseInfo.plan === "yearly" ? "年額プラン" : "月額プラン"}
            </Badge>
          ) : (
            <Badge variant="outline" className="font-normal">未契約</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          領収書の写真から店名・金額・日付・勘定科目を AI が自動で読み取ります。
          領収書のドロップ時に「AI 解析＋仕訳化」トグルが ON であれば取り込んだ瞬間に処理が走ります。
        </p>

        {/* Round 28: Gemini Free Tier 上限超過バナー */}
        <AiOcrQuotaBanner />

        {/* Round 29: 今月の AI OCR 使用量 + 推定コスト */}
        <UsageStatsRow />

        {apiAlive === false && (
          <div className="rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-900">
            <b>⚠️ AI 読み取りサーバーに接続できませんでした。</b>
            <br />
            ネットワークを確認してアプリを再起動してください。復旧するまではオフラインの
            Tesseract OCR のみご利用いただけます。
          </div>
        )}

        {/* データ送信の同意 (これが OFF だと AI 読み取り / 発注書→請求書 が使えない) */}
        <div className={`rounded-md border p-3 space-y-1.5 ${aiConsent ? "" : "border-amber-300 bg-amber-50"}`}>
          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={aiConsent}
              onChange={(e) => void handleToggleConsent(e.target.checked)}
              className="h-4 w-4 mt-0.5"
            />
            <span className="text-sm">
              <b>AI 読み取りのデータ送信に同意する</b>
              <br />
              <span className={aiConsent ? "text-muted-foreground" : "text-amber-800"}>
                領収書 / 発注書の画像 (base64) のみを暗号化して AI OCR API (→ Google Gemini 2.5 Flash)
                に送信します。氏名・住所・利用者識別番号などの納税者情報は送りません。
                サーバー側で解析後に即破棄され、AI 学習にも使われません。
                {" "}<Link href="/legal" className="underline">プライバシーポリシー</Link>
              </span>
            </span>
          </label>
          {!aiConsent && (
            <p className="text-[11px] text-amber-700 pl-6">
              ※ これが OFF の間は「AI 読み取り」「発注書から請求書を作成」が使えません。
            </p>
          )}
        </div>

        {/* ライセンスキー入力欄 */}
        <div className="rounded-md border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
            <Label htmlFor="license-key" className="text-sm font-medium">
              ライセンスキー（有料プランご購入の方）
            </Label>
          </div>
          <div className="flex gap-2">
            <Input
              id="license-key"
              value={licenseInput}
              onChange={(e) => setLicenseInput(e.target.value)}
              placeholder="例: KAIKEI-XXXX-XXXX-XXXX-XXXX"
              className="font-mono text-sm"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              onClick={handleLicenseSave}
              disabled={licenseBusy}
              size="sm"
            >
              {licenseBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4 mr-1" />
              )}
              認証・保存
            </Button>
            {licenseInfo?.valid && (
              <Button
                onClick={handleLicenseClear}
                variant="ghost"
                size="sm"
                title="保存済みキーを削除"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
          {licenseMessage && (
            <p
              className={`text-xs ${
                licenseMessage.startsWith("認証失敗") ||
                licenseMessage.startsWith("エラー") ||
                licenseMessage.startsWith("削除失敗")
                  ? "text-red-600"
                  : "text-green-700"
              }`}
            >
              {licenseMessage}
            </p>
          )}
          {licenseInfo?.valid && (
            <div className="text-xs text-muted-foreground space-y-0.5 pt-1">
              <p>
                プラン:{" "}
                <b>
                  {licenseInfo.plan === "yearly"
                    ? "年額プラン (¥9,800/年)"
                    : "月額プラン (¥980/月)"}
                </b>
                {licenseInfo.expires_at && (
                  <> ・ 次回更新: {new Date(licenseInfo.expires_at).toLocaleDateString("ja-JP")}</>
                )}
              </p>
              {typeof licenseInfo.monthly_limit === "number" && (
                <p>
                  今月の利用: {licenseInfo.used_this_month ?? 0} /{" "}
                  {licenseInfo.monthly_limit} 枚 (月 500枚まで)
                </p>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            有料プランは kaikei LP から購入できます。
            ライセンスキーは購入時のメールに記載されます。
          </p>
        </div>

        {/* プラン説明 */}
        <div className="rounded-md bg-muted/50 border px-3 py-2 text-xs space-y-1">
          <p className="font-medium">📊 プラン</p>
          <p className="text-muted-foreground">
            <b>未契約 (Free):</b> Tesseract オフライン OCR のみ利用可。AI 読み取りは使えません。
          </p>
          <p className="text-muted-foreground">
            <b>月額 ¥980 / 年額 ¥9,800:</b> AI 読み取り 月 500 枚まで。
            AI エンジンは <code>Google Gemini 2.5 Flash</code>。
            画像はサーバー側で解析後に即座に破棄され、保存・AI 学習には使われません。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Round 29: 今月の AI OCR 使用量 + 推定コスト を 1 行で見せる.
 * AI 読み取りカードの上部 (バナーの直下) に出すコンパクトサマリ。
 */
function UsageStatsRow() {
  const [stats, setStats] = useState<{
    count: number;
    yen: number;
    monthKey: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { getThisMonthUsage } = await import("@/lib/ai-ocr-usage");
        const s = await getThisMonthUsage();
        if (!cancelled) {
          setStats({ count: s.count, yen: s.estimatedYen, monthKey: s.monthKey });
        }
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!stats) return null;

  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs flex items-center gap-3 flex-wrap">
      <span className="text-muted-foreground">今月の使用量 ({stats.monthKey}):</span>
      <span className="font-medium">
        <b className="font-mono">{stats.count}</b> 件
      </span>
      <span className="text-muted-foreground">推定コスト:</span>
      <span className="font-medium">
        <b className="font-mono">¥{stats.yen.toFixed(1)}</b>
      </span>
      <span className="text-[10px] text-muted-foreground ml-auto">
        ※ gemini-2.5-flash 換算 (~0.02 円/回)
      </span>
    </div>
  );
}
