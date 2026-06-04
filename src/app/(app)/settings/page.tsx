"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Database,
  HardDriveDownload,
  HardDriveUpload,
  FolderOpen,
  HelpCircle,
  Trash2,
  FileDown,
  Upload,
  FileText,
  KeyRound,
  CheckCircle2,
  Loader2,
  Download,
  RefreshCw,
  FileSpreadsheet,
  AlertCircle,
} from "lucide-react";
import { cleanupOrphanReceiptFiles, openReceiptsFolder } from "@/lib/receipts";
import {
  getLicenseKey,
  saveLicenseKey,
  verifyLicense,
  probeApiServer,
  hasAiOcrConsent,
  setAiOcrConsent,
} from "@/lib/ai-ocr";
import {
  checkAutoUpdate,
  downloadAndInstallUpdate,
  getAutoUpdaterStatus,
  type AutoUpdaterStatus,
} from "@/lib/auto-updater";
import { checkReadiness, type ReadinessReport } from "@/lib/etax/readiness";
import { AiOcrQuotaBanner } from "@/components/ai-ocr-quota-banner";
import Link from "next/link";

type Stats = {
  journals: number;
  receipts: number;
  invoices: number;
  partners: number;
  fixedAssets: number;
};

type LicenseInfo = {
  valid: boolean;
  plan?: string;
  status?: string;
  expires_at?: string;
  monthly_limit?: number;
  used_this_month?: number;
  reason?: string;
};

export default function SettingsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [appDir, setAppDir] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ライセンスキー関連
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

  useEffect(() => {
    (async () => {
      try {
        const { db } = await import("@/lib/localDb");
        const [j, r, inv, p, f] = await Promise.all([
          db.from("journals").select("id", { count: "exact", head: true }),
          db.from("receipts").select("id", { count: "exact", head: true }),
          db.from("invoices").select("id", { count: "exact", head: true }),
          db.from("partners").select("id", { count: "exact", head: true }),
          db.from("fixed_assets").select("id", { count: "exact", head: true }),
        ]);
        setStats({
          journals: j.count || 0,
          receipts: r.count || 0,
          invoices: inv.count || 0,
          partners: p.count || 0,
          fixedAssets: f.count || 0,
        });

        const { appDataDir } = await import("@tauri-apps/api/path");
        setAppDir(await appDataDir());
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  const handleCleanup = async () => {
    if (
      !confirm(
        "DBに紐付いていない画像ファイルを削除します。\n（通常は削除済み領収書のゴミファイル）"
      )
    )
      return;
    setBusy(true);
    try {
      const { removed, kept } = await cleanupOrphanReceiptFiles();
      setMessage(`整理完了: ${removed}件削除 / ${kept}件保持`);
    } catch (e) {
      setMessage(`整理に失敗: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openDataFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(appDir);
    } catch (e) {
      console.error("open failed", e);
    }
  };

  const handleBackup = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { readFile, writeFile, exists, readDir, BaseDirectory } = await import(
        "@tauri-apps/plugin-fs"
      );
      const JSZip = (await import("jszip")).default;

      const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outPath = await save({
        defaultPath: `kaikei-local-backup-${now}.zip`,
        filters: [{ name: "kaikei backup", extensions: ["zip"] }],
      });
      if (!outPath) {
        setBusy(false);
        return;
      }

      const zip = new JSZip();

      // DB 本体
      const dbExists = await exists("kaikei.db", { baseDir: BaseDirectory.AppData });
      if (!dbExists) {
        setMessage("データベースが見つかりません");
        setBusy(false);
        return;
      }
      const dbBytes = await readFile("kaikei.db", { baseDir: BaseDirectory.AppData });
      zip.file("kaikei.db", dbBytes);

      // receipts 画像ファイル
      let receiptCount = 0;
      try {
        const entries = await readDir("receipts", { baseDir: BaseDirectory.AppData });
        for (const entry of entries) {
          if (!entry.isFile) continue;
          const rel = `receipts/${entry.name}`;
          try {
            const bytes = await readFile(rel, { baseDir: BaseDirectory.AppData });
            zip.file(rel, bytes);
            receiptCount++;
          } catch (e) {
            console.warn(`skip ${rel}:`, e);
          }
        }
      } catch (e) {
        // receipts ディレクトリがまだ無い場合は無視
        console.info("receipts dir missing or empty", e);
      }

      // メタ情報
      zip.file(
        "meta.json",
        JSON.stringify(
          {
            app: "KAIKEI LOCAL",
            version: "0.1.0",
            created_at: new Date().toISOString(),
            receipt_count: receiptCount,
          },
          null,
          2
        )
      );

      const zipBytes = await zip.generateAsync({ type: "uint8array" });
      await writeFile(outPath, zipBytes);
      setMessage(`バックアップ完了: ${outPath}\nDB + 領収書 ${receiptCount}件`);
    } catch (e) {
      console.error(e);
      setMessage(`バックアップに失敗しました: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRestore = async () => {
    if (
      !confirm(
        "現在のデータは全て上書きされます。続行しますか？\n念のため事前にバックアップを取ることを推奨します。"
      )
    )
      return;
    setBusy(true);
    setMessage(null);
    // rollback 関数は catch からも見える必要があるので try の外で宣言
    let rollback: () => Promise<void> = async () => {};
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const {
        readFile,
        writeFile,
        mkdir,
        remove,
        readDir,
        BaseDirectory,
      } = await import("@tauri-apps/plugin-fs");
      const JSZip = (await import("jszip")).default;

      const selected = await open({
        multiple: false,
        filters: [
          { name: "kaikei backup", extensions: ["zip", "db"] },
        ],
      });
      if (!selected) {
        setBusy(false);
        return;
      }

      const path = typeof selected === "string" ? selected : "";
      if (!path) {
        setBusy(false);
        return;
      }

      const bytes = await readFile(path);

      // ── 復元前スナップショット ──
      // 失敗してもロールバックできるように、現在の kaikei.db を
      // kaikei.db.pre-restore にコピーしておく。
      let preRestoreCreated = false;
      try {
        const current = await readFile("kaikei.db", {
          baseDir: BaseDirectory.AppData,
        });
        await writeFile("kaikei.db.pre-restore", current, {
          baseDir: BaseDirectory.AppData,
        });
        preRestoreCreated = true;
      } catch {
        // 現DB が無い = 初回なので snapshot 不要
      }

      rollback = async () => {
        if (!preRestoreCreated) return;
        try {
          const snap = await readFile("kaikei.db.pre-restore", {
            baseDir: BaseDirectory.AppData,
          });
          await writeFile("kaikei.db", snap, {
            baseDir: BaseDirectory.AppData,
          });
        } catch {}
      };

      if (path.toLowerCase().endsWith(".zip")) {
        // ZIP 展開
        const zip = await JSZip.loadAsync(bytes);

        // 既存 receipts フォルダのファイルを削除
        try {
          const entries = await readDir("receipts", { baseDir: BaseDirectory.AppData });
          for (const entry of entries) {
            if (entry.isFile) {
              try {
                await remove(`receipts/${entry.name}`, { baseDir: BaseDirectory.AppData });
              } catch {}
            }
          }
        } catch {}

        try {
          await mkdir("receipts", { baseDir: BaseDirectory.AppData, recursive: true });
        } catch {}

        let dbRestored = false;
        let receiptCount = 0;

        for (const [name, file] of Object.entries(zip.files)) {
          if (file.dir) continue;
          const content = await file.async("uint8array");
          if (name === "kaikei.db") {
            await writeFile("kaikei.db", content, { baseDir: BaseDirectory.AppData });
            dbRestored = true;
          } else if (name.startsWith("receipts/")) {
            await writeFile(name, content, { baseDir: BaseDirectory.AppData });
            receiptCount++;
          }
          // meta.json は無視
        }

        if (!dbRestored) {
          await rollback();
          setMessage("バックアップ ZIP に kaikei.db が含まれていません。元のデータに戻しました。");
          setBusy(false);
          return;
        }
        setMessage(
          `復元しました (DB + 領収書 ${receiptCount}件)\nアプリを再起動してください。\n復元前のデータは kaikei.db.pre-restore に保存されています (問題があれば削除してリネーム)。`
        );
      } else {
        // 旧フォーマット: .db のみ
        await writeFile("kaikei.db", bytes, { baseDir: BaseDirectory.AppData });
        setMessage("復元しました。アプリを再起動してください。\n(旧フォーマットのため画像は復元されません)\n復元前のデータは kaikei.db.pre-restore に保存されています。");
      }
    } catch (e) {
      console.error(e);
      await rollback();
      setMessage(`復元に失敗しました: ${(e as Error).message}\n元のデータに自動でロールバックしました。`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">設定・データ管理</h1>

      {message && (
        <div className="rounded-md bg-blue-50 border border-blue-200 text-blue-800 px-4 py-2 text-sm whitespace-pre-wrap">
          {message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileDown className="h-4 w-4" />
            他ソフトから移行
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            freee / マネーフォワード / 弥生 などから CSV をエクスポートして KAIKEI LOCAL に取り込めます。
          </p>
          <div className="flex gap-2 flex-wrap">
            <Link href="/journals/import">
              <Button variant="outline" size="sm">
                <Upload className="h-4 w-4 mr-1" />
                仕訳帳 CSV 取込（8形式）
              </Button>
            </Link>
            <Link href="/masters/import">
              <Button variant="outline" size="sm">
                <Upload className="h-4 w-4 mr-1" />
                マスタ CSV 取込（勘定科目・取引先）
              </Button>
            </Link>
            <Link href="/evidence/import">
              <Button variant="outline" size="sm">
                <Upload className="h-4 w-4 mr-1" />
                証憑 ZIP 取込（電帳法対応）
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4" />
            e-Tax 申告情報
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            確定申告 XTX ファイル生成に必要な納税者情報（氏名・住所・税務署・利用者識別番号など）を登録します。
          </p>
          <Link href="/settings/etax/">
            <Button variant="outline" size="sm">
              <FileText className="h-4 w-4 mr-1" />
              納税者情報を設定
            </Button>
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" />
            データ概要
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stats ? (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Stat label="仕訳" value={stats.journals} />
              <Stat label="領収書" value={stats.receipts} />
              <Stat label="請求書" value={stats.invoices} />
              <Stat label="取引先" value={stats.partners} />
              <Stat label="固定資産" value={stats.fixedAssets} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">読込中...</p>
          )}
          {appDir && (
            <div className="mt-4 text-xs text-muted-foreground break-all">
              <Badge variant="outline" className="mr-2">
                データ保存先
              </Badge>
              {appDir}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">バックアップ・復元</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            全データはSQLiteファイル (<code>kaikei.db</code>) にまとまっています。
            定期的にバックアップを取り、別のMacへ移行することもできます。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleBackup} disabled={busy}>
              <HardDriveDownload className="h-4 w-4 mr-1" />
              バックアップ（ZIP）
            </Button>
            <Button onClick={handleRestore} disabled={busy} variant="outline">
              <HardDriveUpload className="h-4 w-4 mr-1" />
              復元
            </Button>
            <Button onClick={openDataFolder} variant="outline">
              <FolderOpen className="h-4 w-4 mr-1" />
              データフォルダを開く
            </Button>
            <Button onClick={openReceiptsFolder} variant="outline">
              <FolderOpen className="h-4 w-4 mr-1" />
              領収書画像フォルダを開く
            </Button>
            <Button onClick={handleCleanup} variant="outline" disabled={busy}>
              <Trash2 className="h-4 w-4 mr-1" />
              孤児ファイル整理
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            バックアップは kaikei.db と receipts/ フォルダを丸ごと ZIP に固めます。
            友達のMacに移行する場合は、この ZIP を渡してください。
          </p>
        </CardContent>
      </Card>

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

      {/* Round 28: 発行者情報 (屋号・住所・インボイス登録番号・振込先) を要約表示 */}
      <IssuerInfoCard />

      {/* Round 24 ⓒ: アップデート確認 */}
      <UpdaterCheckCard />

      {/* Round 28 ⓓ: 確定申告 準備状況 (期間外でもここから開ける) */}
      <ReadinessCard />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <HelpCircle className="h-4 w-4" />
            使い方ガイド
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <Section title="① まず発行者情報を登録">
            <p>
              「請求書 &gt; 発行者情報」から屋号・住所・インボイス登録番号などを登録してください。
              これが請求書PDFやレポートに表示されます。
            </p>
          </Section>
          <Section title="② 日々の領収書をためる">
            <p>
              ダッシュボードや「領収書」ページの上部にあるドロップゾーンに、
              FinderやmacOS写真アプリから写真をドラッグ＆ドロップで追加できます。
              スマホで撮った写真は「スマホ取込」ページのQRコードから送れます（同じWi-Fi内のみ）。
            </p>
          </Section>
          <Section title="③ 銀行・クレカ明細をCSVで取り込む">
            <p>
              「口座・クレカ」で口座を登録し、「明細取込」で銀行からダウンロードしたCSVを取り込みます。
              取り込んだ明細は「仕訳」ボタンで自動仕訳化できます。
            </p>
          </Section>
          <Section title="④ 自動登録ルールで繰り返しを効率化">
            <p>
              同じお店からの引き落としが何度も出る場合、「自動登録ルール」で
              「この文字列を含む明細は消耗品費の課対仕入10%にする」と登録すると次から自動推測されます。
              推測が採用されるたび正答率が更新されます。
            </p>
          </Section>
          <Section title="⑤ 月次推移で状況を確認">
            <p>
              「月次推移」ページで損益計算書・貸借対照表をそれぞれ月次マトリクスで確認できます。
            </p>
          </Section>
          <Section title="⑥ 家事按分は期末にまとめて">
            <p>
              「家事按分」ページで事業利用比率を設定し、年末に「再計算」ボタンを押すと、
              12/31付で按分仕訳（事業主貸への振替）が自動生成されます。
            </p>
          </Section>
          <Section title="⑦ 固定資産の減価償却">
            <p>
              「固定資産」ページで購入した備品（PC等）を登録すると、
              耐用年数・事業利用率から減価償却費が自動計算されます。
            </p>
          </Section>
          <Section title="⑧ 確定申告">
            <p>
              年末に「確定申告」ページで各種控除を入力すると所得税額が計算されます。
              「PDF出力」で内容を確認し、実際の提出は国税庁e-Taxサイトでマイナンバーカード + スマホで行います。
            </p>
          </Section>
          <Section title="⑨ 請求書発行">
            <p>
              「請求書」から新規請求書を作成。取引先を選び、明細を入力すると
              適格請求書（インボイス）形式のPDFが出力できます。
              「送付済」「入金済」でステータス管理も可能です。
            </p>
          </Section>
        </CardContent>
      </Card>

      {/* ㉻ Round 15: データ全消去カード (アンインストール補助). 二重確認で
          DELETE 文字入力を要求してから wipe_app_data Tauri command を呼ぶ */}
      <DangerZoneCard />
    </div>
  );
}

function DangerZoneCard() {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [migrations, setMigrations] = useState<
    | {
        ok: boolean;
        rows?: { version: number; description: string; success: boolean }[];
        count?: number;
      }
    | null
  >(null);

  const loadMigrations = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const res = (await invoke("migrations_status")) as typeof migrations;
      setMigrations(res);
    } catch (e) {
      console.warn("[settings] migrations_status failed:", e);
    }
  };
  // ページ初回 mount 時に migrations を取りに行く
  useEffect(() => {
    void loadMigrations();
  }, []);

  const handleWipe = async () => {
    if (busy) return;
    if (confirmText !== "DELETE") return;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const r = (await invoke("wipe_app_data")) as {
        ok: boolean;
        backup_path?: string;
        removed_size_bytes?: number;
        error?: string;
      };
      if (r.ok) {
        const mb =
          typeof r.removed_size_bytes === "number"
            ? (r.removed_size_bytes / 1024 / 1024).toFixed(1)
            : "?";
        alert(
          `データを全削除しました (${mb} MB)。\n\n` +
            `バックアップ: ${r.backup_path ?? "(なし)"}\n\n` +
            `アプリを終了して再起動してください。`,
        );
      } else {
        alert(`削除に失敗: ${r.error ?? "unknown"}`);
      }
    } catch (e) {
      alert(`削除に失敗: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setConfirmText("");
    }
  };

  return (
    <Card className="border-red-300">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 text-red-800">
          危険な操作 (アンインストール補助)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* ㉽ migrations_status: 現在の DB 適用状況をその場で確認 */}
        {migrations && migrations.rows && (
          <div className="text-xs text-muted-foreground">
            <p className="mb-1">DB マイグレーション適用状況: {migrations.count} 件</p>
            <ul className="font-mono leading-tight">
              {migrations.rows.slice(-5).map((r) => (
                <li key={r.version}>
                  v{r.version} — {r.description} {r.success ? "✓" : "✗"}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="border-t pt-3">
          <p className="text-red-700 font-medium mb-1">データ全消去</p>
          <p className="text-xs text-muted-foreground mb-2">
            kaikei.db / 領収書画像 / 写真受信箱を完全削除します。<br />
            自動でバックアップ (<code>~/Library/Application Support/dev.kaikei.app.bak-...</code>)
            が作成されますが、消した後は新規 DB として起動します。
          </p>
          <p className="text-xs mb-2">
            実行するには下のフィールドに <code className="bg-muted px-1 rounded">DELETE</code> と入力してください:
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="DELETE"
            className="border rounded px-2 py-1 text-sm font-mono mr-2"
          />
          <Button
            variant="destructive"
            size="sm"
            disabled={busy || confirmText !== "DELETE"}
            onClick={handleWipe}
          >
            {busy ? "削除中..." : "データを全削除"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-bold">{value.toLocaleString()}</p>
    </div>
  );
}

/**
 * Round 28: 発行者情報 (屋号・住所・電話・インボイス登録番号・振込先) を
 * 設定画面でもサマリ表示する。詳細編集は /invoices/settings/ にリンク。
 */
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

function IssuerInfoCard() {
  type IssuerLite = {
    business_name: string | null;
    owner_name: string | null;
    postal_code: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    registered_number: string | null;
    bank_info: string | null;
  };
  const [issuer, setIssuer] = useState<IssuerLite | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { db } = await import("@/lib/localDb");
        const { data } = await db
          .from("issuer_settings")
          .select("*")
          .eq("id", "singleton")
          .single();
        setIssuer(data as IssuerLite | null);
      } catch {
        setIssuer(null);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  if (!loaded) return null;

  const Row = ({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) => (
    <div className="flex items-start gap-3 text-sm py-1 border-b last:border-0 border-muted">
      <span className="w-28 text-xs text-muted-foreground flex-shrink-0">{label}</span>
      {value ? (
        <span className={`flex-1 ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
      ) : (
        <span className="flex-1 text-xs text-red-600">未登録</span>
      )}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" />
          発行者情報 (請求書 PDF に印字される)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {issuer ? (
          <>
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <Row label="屋号" value={issuer.business_name} />
              <Row label="氏名" value={issuer.owner_name} />
              <Row label="郵便番号" value={issuer.postal_code} />
              <Row label="住所" value={issuer.address} />
              <Row label="電話" value={issuer.phone} />
              <Row label="メール" value={issuer.email} />
              <Row label="インボイス登録番号" value={issuer.registered_number} mono />
              <Row
                label="振込先"
                value={issuer.bank_info ? issuer.bank_info.split("\n").join(" / ") : null}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              これらは請求書を PDF 出力する時に右上の「発行者」ブロックと末尾の「お振込先」枠に印字されます。
            </p>
          </>
        ) : (
          <p className="text-amber-800 bg-amber-50 border border-amber-300 rounded px-3 py-2 text-xs">
            まだ発行者情報が登録されていません。請求書を作る前に登録してください。
          </p>
        )}
        <Link href="/invoices/settings/">
          <Button variant="outline" size="sm">
            <FileText className="h-3 w-3 mr-1" />
            発行者情報を編集する
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * Round 28 ⓓ: 確定申告の準備状況カード (設定画面版).
 * ダッシュボードの同カードは 1/1〜3/15 のみ自動表示だが、こちらはボタン押下で
 * 通年いつでも開ける。年度はその時点で「進行中の年」を対象にする。
 */
function ReadinessCard() {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [loading, setLoading] = useState(false);

  const onShow = async () => {
    setLoading(true);
    try {
      // 期間外でも見たいので「進行中の年」を対象に集計する
      // (checkReadiness は now を基準に inWindow / year を決めるため、
      //  6/1 のような日付を渡すと year=現在年・inWindow=false になる)
      const probe = new Date();
      probe.setMonth(5, 1); // 6月1日 → 必ず期間外 → year は現在進行中の年
      setReport(await checkReadiness(probe));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSpreadsheet className="h-4 w-4" />
          確定申告の準備状況
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          帳簿の入力状況・要対応項目をチェックリストで確認します。
          確定申告期 (1/1〜3/15) はダッシュボードにも自動表示されますが、ここからは通年で開けます。
        </p>
        {!report && (
          <Button variant="outline" size="sm" onClick={() => void onShow()} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <FileSpreadsheet className="h-3 w-3 mr-1" />
            )}
            準備状況を見る
          </Button>
        )}
        {report && (
          <div className="rounded border border-blue-200 bg-blue-50/60 p-3 space-y-1.5">
            <p className="font-medium text-blue-900">
              {report.year} 年分 — {report.completionPct}% 完了
              {report.blockers > 0 && (
                <span className="ml-2 text-red-700">({report.blockers} 件 要対応)</span>
              )}
            </p>
            {report.checks.map((c) => {
              const icon =
                c.status === "ok" ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600 flex-shrink-0" />
                ) : c.status === "warning" ? (
                  <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
                );
              const inner = (
                <div className="flex items-start gap-2 py-1">
                  {icon}
                  <div className="flex-1">
                    <p className="font-medium">{c.label}</p>
                    <p className="text-xs text-muted-foreground">{c.detail}</p>
                  </div>
                  {c.href && <span className="text-blue-700 text-xs">→</span>}
                </div>
              );
              return c.href ? (
                <Link key={c.id} href={c.href} className="block hover:bg-blue-100/60 rounded px-1 -mx-1">
                  {inner}
                </Link>
              ) : (
                <div key={c.id} className="px-1 -mx-1">
                  {inner}
                </div>
              );
            })}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void onShow()}
              disabled={loading}
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} />
              再計算
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-medium mb-1">{title}</p>
      <div className="text-muted-foreground pl-4 border-l-2">{children}</div>
    </div>
  );
}

/**
 * Round 24 ⓒ: アップデート確認カード.
 * 起動 4 秒後の自動チェック (auto-updater が呼ぶ) に加えて、
 * 「今すぐ確認」ボタンで明示的にチェックさせる動線。
 */
function UpdaterCheckCard() {
  const [status, setStatus] = useState<AutoUpdaterStatus>(getAutoUpdaterStatus());
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // package.json の version を表示用に
    void (async () => {
      try {
        const isTauri = typeof window !== "undefined" &&
          Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
        if (isTauri) {
          const { getVersion } = await import("@tauri-apps/api/app");
          setCurrentVersion(await getVersion());
        } else {
          const pkg = (await import("../../../../package.json")).default ?? {};
          setCurrentVersion((pkg as { version?: string }).version ?? "?");
        }
      } catch {
        setCurrentVersion("?");
      }
    })();
  }, []);

  const onCheck = async () => {
    setBusy(true);
    try {
      const next = await checkAutoUpdate();
      setStatus(next);
    } finally {
      setBusy(false);
    }
  };

  const onInstall = async () => {
    setBusy(true);
    try {
      await downloadAndInstallUpdate();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Download className="h-4 w-4" />
          アプリのアップデート
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground">現在のバージョン:</span>
          <code className="font-mono">v{currentVersion || "?"}</code>
        </div>
        {status.kind === "available" && (
          <div className="rounded border border-blue-300 bg-blue-50 p-3 text-blue-900">
            <p className="font-medium">
              新しいバージョン v{status.version} が公開されています
            </p>
            {status.body && (
              <p className="text-xs mt-1 line-clamp-3">{status.body}</p>
            )}
            <Button
              size="sm"
              className="mt-2"
              onClick={() => void onInstall()}
              disabled={busy}
            >
              ダウンロードして再起動
            </Button>
          </div>
        )}
        {status.kind === "up_to_date" && (
          <div className="text-xs text-muted-foreground inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-green-600" />
            最新です (v{status.currentVersion})
          </div>
        )}
        {status.kind === "downloading" && (
          <div className="text-xs">
            ダウンロード中…{" "}
            {status.total
              ? `${Math.round((status.bytes / status.total) * 100)}%`
              : `${Math.round(status.bytes / 1024 / 1024)} MB`}
          </div>
        )}
        {status.kind === "error" && (
          <p className="text-xs text-red-700">エラー: {status.message}</p>
        )}
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onCheck()}
            disabled={busy || status.kind === "downloading"}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${busy ? "animate-spin" : ""}`} />
            今すぐ確認
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
