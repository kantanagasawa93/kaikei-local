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
} from "lucide-react";
import { cleanupOrphanReceiptFiles, openReceiptsFolder } from "@/lib/receipts";
import {
  getLicenseKey,
  saveLicenseKey,
  verifyLicense,
} from "@/lib/ai-ocr";
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

  // 初回ロードで既存キーを読み込み & verify
  useEffect(() => {
    (async () => {
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
          setMessage("バックアップ ZIP に kaikei.db が含まれていません");
          setBusy(false);
          return;
        }
        setMessage(
          `復元しました (DB + 領収書 ${receiptCount}件)\nアプリを再起動してください。`
        );
      } else {
        // 旧フォーマット: .db のみ
        await writeFile("kaikei.db", bytes, { baseDir: BaseDirectory.AppData });
        setMessage("復元しました。アプリを再起動してください。\n(旧フォーマットのため画像は復元されません)");
      }
    } catch (e) {
      console.error(e);
      setMessage(`復元に失敗しました: ${(e as Error).message}`);
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
    </div>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-medium mb-1">{title}</p>
      <div className="text-muted-foreground pl-4 border-l-2">{children}</div>
    </div>
  );
}
