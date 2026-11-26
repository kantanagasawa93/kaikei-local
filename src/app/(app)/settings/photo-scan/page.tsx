"use client";

/**
 * 写真自動取込の設定ページ
 *
 * Phase 1: アクセス権限の確認 + 手動スキャン
 * Phase 3 で「毎日 21:00 に自動スキャン」を追加予定 (LaunchAgent 登録)
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Camera,
  Lock,
  CheckCircle2,
  AlertTriangle,
  Inbox as InboxIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getAuthStatus,
  requestAuth,
  scanNow,
  getLastScanUnix,
  launchAgentStatus,
  launchAgentInstall,
  launchAgentUninstall,
  recentScanLog,
  resolveScanPeriod,
  scanPeriod,
  type AuthStatus,
  type LaunchAgentStatus,
  type PeriodScanProgress,
  type ScanLogRow,
  type ScanPeriodPreset,
} from "@/lib/photo-scanner";
import {
  countDeletableOriginals,
  deleteImportedOriginals,
  describeDeleteResult,
  getAutoDeleteOriginals,
  reconcileDeletedOriginals,
  setAutoDeleteOriginals,
} from "@/lib/photo-originals";
import { confirmDialog } from "@/lib/confirm";
import { todayLocal, addDaysToDateString } from "@/lib/date-utils";
import {
  getAutoJournalMode,
  setAutoJournalMode,
} from "@/lib/auto-journal";
import { toast } from "@/lib/toast";

export default function PhotoScanSettingsPage() {
  const [auth, setAuth] = useState<AuthStatus>("unknown");
  const [lastScan, setLastScan] = useState<number>(0);
  const [requesting, setRequesting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [agent, setAgent] = useState<LaunchAgentStatus>({ installed: false });
  const [scheduleTime, setScheduleTime] = useState<string>("21:00");
  const [agentBusy, setAgentBusy] = useState(false);
  const [logs, setLogs] = useState<ScanLogRow[]>([]);
  const [autoJournal, setAutoJournalState] = useState(false);
  // 期間を指定したスキャン
  const [periodPreset, setPeriodPreset] = useState<ScanPeriodPreset>("30d");
  const [periodFrom, setPeriodFrom] = useState<string>(() => addDaysToDateString(todayLocal(), -30));
  const [periodTo, setPeriodTo] = useState<string>(() => todayLocal());
  const [periodProgress, setPeriodProgress] = useState<PeriodScanProgress | null>(null);
  const periodAbortRef = useRef<AbortController | null>(null);
  // 写真アプリの整理 (取り込み済みの元写真を消す)
  const [deletableCount, setDeletableCount] = useState<number>(0);
  const [deletingOriginals, setDeletingOriginals] = useState(false);
  const [autoDelete, setAutoDeleteState] = useState(false);

  const refresh = async () => {
    setAuth(await getAuthStatus());
    setLastScan(await getLastScanUnix());
    const a = await launchAgentStatus();
    setAgent(a);
    if (a.time) setScheduleTime(a.time);
    setLogs(await recentScanLog(5));
    setAutoJournalState(await getAutoJournalMode());
    setAutoDeleteState(await getAutoDeleteOriginals());
    await refreshDeletable();
  };

  const refreshDeletable = async () => {
    try {
      // 利用者が写真アプリ側で自分で消した分を、先に記録へ反映する (失敗しても件数は出す)
      if ((await getAuthStatus()) === "authorized") {
        try {
          await reconcileDeletedOriginals();
        } catch (e) {
          console.warn("reconcileDeletedOriginals failed:", e);
        }
      }
      setDeletableCount(await countDeletableOriginals());
    } catch (e) {
      console.warn("countDeletableOriginals failed:", e);
    }
  };

  const handleScheduleEnable = async () => {
    setAgentBusy(true);
    try {
      const next = await launchAgentInstall(scheduleTime);
      setAgent(next);
      toast.success(`毎日 ${scheduleTime} に自動スキャンを設定しました`);
    } catch (e) {
      toast.error(`設定に失敗: ${(e as Error).message}`);
    } finally {
      setAgentBusy(false);
    }
  };

  const handleScheduleDisable = async () => {
    setAgentBusy(true);
    try {
      const next = await launchAgentUninstall();
      setAgent(next);
      toast.success("自動スキャンを停止しました");
    } catch (e) {
      toast.error(`停止に失敗: ${(e as Error).message}`);
    } finally {
      setAgentBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleRequestAuth = async () => {
    setRequesting(true);
    try {
      const result = await requestAuth();
      setAuth(result);
      if (result === "authorized" || result === "limited") {
        toast.success("写真へのアクセスを許可しました");
      } else {
        toast.error(`アクセス許可が得られませんでした (${result})`);
      }
    } finally {
      setRequesting(false);
    }
  };

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const result = await scanNow("manual");
      const parts = [
        `${result.scanned} 枚取得`,
        `新規 ${result.newPhotos} 枚`,
      ];
      if (result.receiptCount && result.receiptCount > 0) {
        parts.push(`領収書 ${result.receiptCount} 枚`);
      }
      if (result.skipped && result.skipped > 0) {
        parts.push(`明らかに対象外 ${result.skipped} 枚は除外`);
      }
      toast.success(`スキャン完了: ${parts.join(" / ")}`);
      await refresh();
    } catch (e) {
      toast.error(`スキャン失敗: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  };

  const handlePeriodScan = async () => {
    if (scanning) return;
    const period = resolveScanPeriod(periodPreset, { from: periodFrom, to: periodTo });
    if (!period) {
      toast.error("期間が正しくありません（開始日と終了日を確認してください）");
      return;
    }
    setScanning(true);
    const controller = new AbortController();
    periodAbortRef.current = controller;
    try {
      const result = await scanPeriod(period, (p) => setPeriodProgress(p), controller.signal);
      const parts = [`${result.scanned} 枚取得`, `新規 ${result.newPhotos} 枚`];
      if (result.receiptCount > 0) parts.push(`領収書 ${result.receiptCount} 枚`);
      if (result.skipped && result.skipped > 0) parts.push(`明らかに対象外 ${result.skipped} 枚は除外`);
      if (result.duplicate && result.duplicate > 0) parts.push(`重複 ${result.duplicate} 枚を統合`);
      const summary = parts.join(" / ");
      if (result.cancelled) {
        toast.info(
          `スキャンを中断しました（${result.windowsDone} / ${result.windowCount} 区間まで処理）: ${summary}`,
        );
      } else {
        toast.success(`期間のスキャン完了: ${summary}`);
      }
      if (result.errors.length > 0) {
        toast.error(`取り込めなかった写真が ${result.errors.length} 枚あります: ${result.errors[0]}`);
      }
      await refresh();
    } catch (e) {
      toast.error(`スキャン失敗: ${(e as Error).message}`);
    } finally {
      setScanning(false);
      setPeriodProgress(null);
      periodAbortRef.current = null;
    }
  };

  const handleDeleteOriginals = async () => {
    if (deletingOriginals || deletableCount === 0) return;
    const ok = await confirmDialog(
      `取り込み済みの写真 ${deletableCount} 枚を、写真アプリから削除します。\n\n` +
        "・このあと macOS の確認ダイアログが出ます。そこで「削除」を選んだ時だけ消えます。\n" +
        "・消した写真は、写真アプリの「最近削除した項目」に 30 日残ります。\n" +
        "・iCloud 写真を使っている場合は、iPhone など他の端末からも消えます。\n" +
        "・KAIKEI LOCAL に取り込んだ領収書の画像は、そのまま残ります。",
    );
    if (!ok) return;
    setDeletingOriginals(true);
    try {
      const result = await deleteImportedOriginals();
      const message = describeDeleteResult(result);
      if (result.error) toast.error(message);
      else if (result.deleted > 0 || result.alreadyGone > 0) toast.success(message);
      else toast.info(message);
    } catch (e) {
      toast.error(`写真アプリからの削除に失敗: ${(e as Error).message}`);
    } finally {
      setDeletingOriginals(false);
      await refreshDeletable();
    }
  };

  const formatDay = (unix: number) =>
    new Date(unix * 1000).toLocaleDateString("ja-JP", { year: "numeric", month: "numeric", day: "numeric" });

  const isAuthorized = auth === "authorized" || auth === "limited";

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Link href="/settings">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Camera className="h-6 w-6" />
            写真自動取込
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            iCloud 写真から領収書候補を自動で見つけます
          </p>
        </div>
      </div>

      {/* プライバシー説明 */}
      <Card className="border-blue-200 bg-blue-50/50">
        <CardContent className="pt-6 text-sm space-y-2">
          <p className="font-semibold flex items-center gap-2">
            <Lock className="h-4 w-4 text-blue-600" />
            プライバシーへのこだわり
          </p>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground text-[13px] leading-relaxed">
            <li>
              この機能は <strong>明示的にオプトイン</strong> しない限り動きません。
              許可した後も、増分スキャン (前回以降の写真のみ) で動作します。
            </li>
            <li>
              判定は <strong>すべて Mac 上で完結</strong>。
              スクリーンショット/パノラマ/HDR は事前に除外し、残った写真は{" "}
              <code className="bg-white px-1 rounded text-[11px]">VNDetectDocumentSegmentationRequest</code>{" "}
              (Apple Photos.app と同じ on-device 文書検出モデル) で
              <strong>「文書/レシート形状の写真」だけ</strong>を抽出します。
            </li>
            <li>
              文書検出を通過した写真のみ Vision OCR + キーワード分析で「領収書らしさ」を
              スコアリング。受信箱に並ぶ写真は実質的に Photos.app で「領収書」検索した
              結果に近いものになります。
            </li>
            <li>
              AI OCR への送信は、ユーザが「この写真を仕訳化する」を実行した時のみ。
              送信履歴はいつでも{" "}
              <Link href="/settings/ai-ocr-log" className="text-primary underline">
                送信履歴ページ
              </Link>{" "}
              で確認可能。
            </li>
            <li>
              いつでも 設定 → 写真自動取込 から無効化でき、その後はスキャンが
              止まります。蓄積した受信箱データはローカル DB にのみ残ります。
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* 権限ステータス */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">macOS のアクセス権限</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            {isAuthorized ? (
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            ) : auth === "denied" || auth === "restricted" ? (
              <AlertTriangle className="h-5 w-5 text-red-600" />
            ) : (
              <Camera className="h-5 w-5 text-muted-foreground" />
            )}
            <div className="flex-1">
              <div className="font-medium text-sm">
                {auth === "authorized" && "全件アクセス許可済み"}
                {auth === "limited" && "選択した写真のみアクセス許可"}
                {auth === "denied" && "拒否されています"}
                {auth === "restricted" && "管理者ポリシーで制限されています"}
                {auth === "not_determined" && "未設定 (許可ダイアログ未表示)"}
                {auth === "unsupported" && "macOS 以外のため利用不可"}
                {auth === "unknown" && "確認中..."}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                ステータス: <code className="bg-muted px-1 py-0.5 rounded">{auth}</code>
              </div>
            </div>
          </div>

          {auth === "not_determined" && (
            <Button onClick={handleRequestAuth} disabled={requesting}>
              <Camera className="h-4 w-4 mr-2" />
              {requesting ? "ダイアログ応答待ち..." : "macOS の許可ダイアログを表示"}
            </Button>
          )}

          {(auth === "denied" || auth === "restricted") && (
            <div className="text-xs text-muted-foreground space-y-2 bg-muted p-3 rounded-md">
              <p>
                許可するには <strong>システム設定 → プライバシーとセキュリティ → 写真</strong> で
                「KAIKEI LOCAL」をオンにしてください。
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  // plugin:shell|open は x-apple.systempreferences: を拒否するので専用コマンドで開く
                  try {
                    const { invoke } = await import("@tauri-apps/api/core");
                    await invoke("open_photos_privacy_settings");
                  } catch (e) {
                    console.error("open system settings failed", e);
                    toast.error(
                      "システム設定を開けませんでした。 メニューから「システム設定 → プライバシーとセキュリティ → 写真」を開いてください。",
                    );
                  }
                }}
              >
                システム設定を開く
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* スキャン実行 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">スキャン</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm">
            <div>
              前回スキャン:{" "}
              <span className="text-muted-foreground">
                {lastScan > 0 ? new Date(lastScan * 1000).toLocaleString("ja-JP") : "未実行"}
              </span>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {lastScan > 0
                ? "前回以降に撮影された写真だけが対象になります"
                : "初回は過去 7 日以内の写真をスキャンします"}
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleScan} disabled={!isAuthorized || scanning}>
              {scanning ? "スキャン中..." : "今すぐスキャン"}
            </Button>
            <Link href="/inbox">
              <Button variant="outline">
                <InboxIcon className="h-4 w-4 mr-1" />
                受信箱を見る
              </Button>
            </Link>
          </div>

          {/* 期間を指定してスキャン */}
          <div className="border-t pt-4 space-y-3">
            <div>
              <div className="text-sm font-medium">期間を指定してスキャン</div>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                前回より前に撮った写真も対象にできます。既に受信箱にある写真（取り込み済み・破棄済みを含む）は、
                もう一度は入りません。長い期間ほど時間がかかり、途中で中断できます。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={periodPreset}
                onChange={(e) => setPeriodPreset(e.target.value as ScanPeriodPreset)}
                disabled={scanning}
                className="border rounded px-2 py-1 text-sm bg-background"
                aria-label="スキャンする期間"
              >
                <option value="7d">過去 7 日</option>
                <option value="30d">過去 30 日</option>
                <option value="90d">過去 90 日</option>
                <option value="1y">過去 1 年</option>
                <option value="custom">日付を指定</option>
              </select>
              {periodPreset === "custom" && (
                <>
                  <input
                    type="date"
                    value={periodFrom}
                    max={periodTo || undefined}
                    onChange={(e) => setPeriodFrom(e.target.value)}
                    disabled={scanning}
                    className="border rounded px-2 py-1 text-sm"
                    aria-label="開始日"
                  />
                  <span className="text-sm text-muted-foreground">〜</span>
                  <input
                    type="date"
                    value={periodTo}
                    min={periodFrom || undefined}
                    onChange={(e) => setPeriodTo(e.target.value)}
                    disabled={scanning}
                    className="border rounded px-2 py-1 text-sm"
                    aria-label="終了日"
                  />
                </>
              )}
              <Button variant="outline" onClick={handlePeriodScan} disabled={!isAuthorized || scanning}>
                この期間をスキャン
              </Button>
              {periodProgress && (
                <Button variant="ghost" size="sm" onClick={() => periodAbortRef.current?.abort()}>
                  中断
                </Button>
              )}
            </div>
            {periodProgress && (
              <div className="text-xs text-muted-foreground" role="status">
                区間 {periodProgress.windowIndex} / {periodProgress.windowCount}（
                {formatDay(periodProgress.sinceUnix + 1)}〜{formatDay(periodProgress.untilUnix)}）:{" "}
                {periodProgress.total > 0
                  ? `${periodProgress.done} / ${periodProgress.total} 枚を判定中`
                  : "写真を取得中…"}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 写真アプリの整理: 取り込み済みの元写真を消す */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">写真アプリの整理</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            領収書として取り込んだ写真は、KAIKEI LOCAL の中に画像を保存しています。
            元の写真を写真アプリから消して、ライブラリをすっきりさせられます。
            対象は「取り込み済みで、領収書の画像がアプリ内に残っている写真」だけです。
          </p>
          <ul className="list-disc pl-5 space-y-1 text-xs text-muted-foreground leading-relaxed">
            <li>削除のたびに macOS の確認ダイアログが出ます（省略できません）。</li>
            <li>消した写真は、写真アプリの「最近削除した項目」に 30 日残ります。</li>
            <li>iCloud 写真を使っている場合は、iPhone など他の端末からも消えます。</li>
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <div className="text-sm">
              写真アプリに残っている取り込み済みの写真:{" "}
              <strong>{deletableCount} 枚</strong>
            </div>
            <Button
              variant="outline"
              onClick={handleDeleteOriginals}
              disabled={!isAuthorized || deletingOriginals || deletableCount === 0}
            >
              {deletingOriginals
                ? "確認ダイアログの応答待ち…"
                : `${deletableCount} 枚を写真アプリから削除`}
            </Button>
          </div>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoDelete}
              onChange={async (e) => {
                const v = e.target.checked;
                try {
                  await setAutoDeleteOriginals(v);
                  setAutoDeleteState(v);
                  toast.success(
                    v
                      ? "まとめて仕訳化したあとに、削除の確認を出すようにしました"
                      : "自動での削除の確認を止めました",
                  );
                } catch (err) {
                  toast.error(`設定の保存に失敗: ${(err as Error).message}`);
                }
              }}
              className="w-4 h-4 mt-0.5"
            />
            <span className="text-sm">
              受信箱で「領収書をすべて自動仕訳」を実行したあとに、取り込んだ写真の削除を確認する
              <span className="block text-xs text-muted-foreground">
                オフの時は、このボタンを押した時だけ削除します。
              </span>
            </span>
          </label>
          {!isAuthorized && (
            <p className="text-xs text-amber-700">
              ※ 写真へのアクセス許可が必要です。先に上のセクションで許可してください。
            </p>
          )}
        </CardContent>
      </Card>

      {/* 毎日自動スキャン (LaunchAgent) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">毎日決まった時間に自動スキャン</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            macOS の LaunchAgent に登録します。アプリを閉じていても、毎日指定時間
            になると裏でアプリが立ち上がってスキャンを実行 → 通知センターに結果が
            表示されます。
          </p>

          <div className="flex items-center gap-3">
            <label className="text-sm">毎日</label>
            <input
              type="time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              disabled={agent.installed}
              className="border rounded px-2 py-1 text-sm w-28"
            />
            <span className="text-sm">に実行</span>
          </div>

          <div className="flex items-center gap-3 pt-2">
            {agent.installed ? (
              <>
                <div className="flex items-center gap-2 text-sm text-green-700">
                  <CheckCircle2 className="h-4 w-4" />
                  有効 (毎日 {agent.time})
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={agentBusy}
                  onClick={handleScheduleDisable}
                >
                  停止する
                </Button>
              </>
            ) : (
              <Button
                disabled={agentBusy || !isAuthorized}
                onClick={handleScheduleEnable}
              >
                {agentBusy ? "登録中..." : "毎日 " + scheduleTime + " で自動化を有効化"}
              </Button>
            )}
          </div>
          {!isAuthorized && (
            <p className="text-xs text-amber-700">
              ※ 写真へのアクセス許可が必要です。先に上のセクションで許可してください。
            </p>
          )}
          {agent.plist_path && (
            <p className="text-[11px] text-muted-foreground font-mono break-all">
              plist: {agent.plist_path}
            </p>
          )}
        </CardContent>
      </Card>

      {/* 自動仕訳モード (Phase 4) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">AI 自動仕訳モード</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground leading-relaxed">
            受信箱で「領収書」状態になった写真を、毎日のスキャン後に自動で
            AI OCR にかけて仕訳まで完了させます。
            <strong className="text-foreground"> Claude API への画像送信が発生する</strong>
            ため、ライセンスキー (有料プラン) が必要です。
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            OFF の場合は受信箱に積まれた領収書を見て、ユーザがまとめて
            「領収書をすべて自動仕訳」ボタンで処理する形になります。
          </p>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={autoJournal}
              onChange={async (e) => {
                const v = e.target.checked;
                setAutoJournalState(v);
                await setAutoJournalMode(v);
                toast.success(v ? "自動仕訳モードを有効化" : "自動仕訳モードを停止");
              }}
              className="w-4 h-4"
            />
            <span className="text-sm">毎日のスキャン後に自動で AI OCR + 仕訳作成</span>
          </label>
          <Link href="/settings/ai-ocr-log" className="text-xs text-primary underline">
            AI OCR の送信履歴を確認 →
          </Link>
        </CardContent>
      </Card>

      {/* 直近のスキャンログ */}
      {logs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">直近のスキャン履歴</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-3 p-2 rounded border bg-card"
                >
                  <div className="flex-1">
                    <div className="text-xs text-muted-foreground">
                      {new Date(log.started_at).toLocaleString("ja-JP")} ·{" "}
                      <span className="font-mono">{log.trigger}</span>
                    </div>
                    <div className="text-sm mt-0.5">
                      {log.scanned_count} 枚スキャン / 領収書 {log.receipt_count} 枚
                      {log.imported_count > 0 && ` / 自動仕訳 ${log.imported_count} 件`}
                      {log.error && (
                        <span className="text-red-600 ml-2">エラー</span>
                      )}
                    </div>
                    {log.error && (
                      <div className="text-[11px] text-red-700 mt-1 line-clamp-2">
                        {log.error}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
