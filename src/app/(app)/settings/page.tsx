"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Database,
  HardDriveDownload,
  HardDriveUpload,
  FolderOpen,
  HelpCircle,
  Trash2,
} from "lucide-react";
import { cleanupOrphanReceiptFiles } from "@/lib/receipts";

type Stats = {
  journals: number;
  receipts: number;
  invoices: number;
  partners: number;
  fixedAssets: number;
};

export default function SettingsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [appDir, setAppDir] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiKeySaved, setApiKeySaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { getApiKey } = await import("@/lib/ai-ocr");
        const key = await getApiKey();
        if (key) { setApiKey(key); setApiKeySaved(true); }
      } catch {}
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
          <CardTitle className="text-base">AI 読み取りプラン</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            領収書の写真から店名・金額・日付を AI で自動読み取りします。
            月 500枚までお使いいただけます。
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value.trim().toUpperCase()); setApiKeySaved(false); }}
              placeholder="KL-XXXX-XXXX-XXXX-XXXX"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
            <Button
              variant={apiKeySaved ? "outline" : "default"}
              disabled={!apiKey || apiKeySaved}
              onClick={async () => {
                const { saveLicenseKey, verifyLicense } = await import("@/lib/ai-ocr");
                const v = await verifyLicense(apiKey);
                if (!v.valid) {
                  setMessage(`ライセンスキーが無効です: ${v.reason || v.status || "unknown"}`);
                  return;
                }
                await saveLicenseKey(apiKey);
                setApiKeySaved(true);
                setMessage(`有効です。今月 ${v.used_this_month}/${v.monthly_limit}枚 利用中`);
                setTimeout(() => setMessage(null), 4000);
              }}
            >
              {apiKeySaved ? "保存済み" : "確認して保存"}
            </Button>
          </div>
          <div className="bg-muted/50 rounded-lg p-3 space-y-1 text-xs text-muted-foreground">
            <p><strong className="text-foreground">お持ちでない方へ:</strong></p>
            <p>
              <a href="https://kaikei-local.com#ai-plan" target="_blank" rel="noopener" className="underline text-primary">
                月額 980円 または 年額 9,800円で購入
              </a>
              できます（1年分2ヶ月無料）。購入後、メールでライセンスキーが届きます。
            </p>
            <p className="pt-1">ライセンスキーはこの Mac のローカルにのみ保存されます。</p>
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
