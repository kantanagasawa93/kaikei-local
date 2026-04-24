"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Upload, Loader2, CheckCircle2, Users, BookOpen } from "lucide-react";
import {
  readCsvFile,
  parseFreeeAccountsCsv,
  commitAccounts,
  parseFreeePartnersCsv,
  commitPartners,
  type ParsedAccount,
  type ParsedPartner,
} from "@/lib/master-import";

type TabKey = "accounts" | "partners";

export default function MasterImportPage() {
  const [tab, setTab] = useState<TabKey>("accounts");

  const [accFile, setAccFile] = useState<File | null>(null);
  const [accParsed, setAccParsed] = useState<ParsedAccount[] | null>(null);
  const [accUpdating, setAccUpdating] = useState(false);
  const [accMsg, setAccMsg] = useState<string | null>(null);
  const [accUpdateExisting, setAccUpdateExisting] = useState(false);

  const [ptFile, setPtFile] = useState<File | null>(null);
  const [ptParsed, setPtParsed] = useState<ParsedPartner[] | null>(null);
  const [ptUpdating, setPtUpdating] = useState(false);
  const [ptMsg, setPtMsg] = useState<string | null>(null);
  const [ptUpdateExisting, setPtUpdateExisting] = useState(false);

  async function handleAccountsFile(f: File) {
    setAccFile(f);
    setAccMsg(null);
    const rows = await readCsvFile(f);
    const parsed = parseFreeeAccountsCsv(rows);
    setAccParsed(parsed);
  }

  async function handlePartnersFile(f: File) {
    setPtFile(f);
    setPtMsg(null);
    const rows = await readCsvFile(f);
    const parsed = parseFreeePartnersCsv(rows);
    setPtParsed(parsed);
  }

  async function commitAccountsImport() {
    if (!accParsed) return;
    if (!confirm(`${accParsed.length}件の勘定科目を取り込みます。既存は${accUpdateExisting ? "上書き" : "スキップ"}します。続行しますか？`)) return;
    setAccUpdating(true);
    try {
      const res = await commitAccounts(accParsed, { updateExisting: accUpdateExisting });
      setAccMsg(`✅ 追加 ${res.added} / 更新 ${res.updated} / スキップ ${res.skipped} 件`);
    } catch (e) {
      setAccMsg(`❌ 失敗: ${(e as Error).message}`);
    } finally {
      setAccUpdating(false);
    }
  }

  async function commitPartnersImport() {
    if (!ptParsed) return;
    if (!confirm(`${ptParsed.length}件の取引先を取り込みます。既存は${ptUpdateExisting ? "上書き" : "スキップ"}します。続行しますか？`)) return;
    setPtUpdating(true);
    try {
      const res = await commitPartners(ptParsed, { updateExisting: ptUpdateExisting });
      setPtMsg(`✅ 追加 ${res.added} / 更新 ${res.updated} / スキップ ${res.skipped} 件`);
    } catch (e) {
      setPtMsg(`❌ 失敗: ${(e as Error).message}`);
    } finally {
      setPtUpdating(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Link href="/settings">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">マスタ CSV インポート</h1>
      </div>

      <div className="flex gap-2 border-b">
        <button
          type="button"
          onClick={() => setTab("accounts")}
          className={`px-4 py-2 border-b-2 ${tab === "accounts" ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
        >
          <BookOpen className="h-4 w-4 inline mr-1" />
          勘定科目
        </button>
        <button
          type="button"
          onClick={() => setTab("partners")}
          className={`px-4 py-2 border-b-2 ${tab === "partners" ? "border-primary text-primary" : "border-transparent text-muted-foreground"}`}
        >
          <Users className="h-4 w-4 inline mr-1" />
          取引先
        </button>
      </div>

      {tab === "accounts" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">勘定科目CSVの取り込み</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              freee の「マスタ・口座 → 勘定科目 → エクスポート → 勘定科目csvエクスポート」で取得したCSVをそのまま取り込めます。
              Shift-JIS, 12列の公式フォーマット対応。
            </p>

            <div
              className="rounded-xl border-2 border-dashed p-6 text-center cursor-pointer hover:bg-muted/30"
              onClick={() => document.getElementById("acc-file")?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={async (e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) await handleAccountsFile(f); }}
            >
              <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
              <p className="font-medium">勘定科目CSVをドラッグ＆ドロップ or クリック</p>
              {accFile && <p className="text-primary mt-2">選択中: {accFile.name}</p>}
            </div>
            <input
              id="acc-file"
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) await handleAccountsFile(f); }}
            />

            {accParsed && (
              <div className="space-y-2">
                <p>
                  <b>{accParsed.length}件</b>の勘定科目を解析しました
                </p>
                <div className="bg-muted rounded p-2 text-xs max-h-40 overflow-auto">
                  <table className="w-full">
                    <thead><tr><th className="text-left">勘定科目</th><th className="text-left">大分類</th><th className="text-left">小分類</th><th className="text-left">カテゴリ</th></tr></thead>
                    <tbody>
                      {accParsed.slice(0, 20).map((a, i) => (
                        <tr key={i} className="border-b border-background">
                          <td>{a.name}</td>
                          <td>{a.parent_category || "-"}</td>
                          <td>{a.sub_category || "-"}</td>
                          <td>{a.category}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {accParsed.length > 20 && <p className="mt-2">…ほか {accParsed.length - 20}件</p>}
                </div>

                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={accUpdateExisting} onChange={(e) => setAccUpdateExisting(e.target.checked)} />
                  既存の勘定科目も上書き更新する
                </label>

                <Button onClick={commitAccountsImport} disabled={accUpdating}>
                  {accUpdating ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                  勘定科目を取り込む
                </Button>

                {accMsg && <p className="text-sm font-medium">{accMsg}</p>}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {tab === "partners" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">取引先CSVの取り込み</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              freee の「マスタ・口座 → 取引先 → ⋯ メニュー → CSVエクスポート」で取得した CSV をそのまま取り込めます。
              Shift-JIS, 56列の公式フォーマット対応（適格請求書発行事業者登録番号も含む）。
            </p>

            <div
              className="rounded-xl border-2 border-dashed p-6 text-center cursor-pointer hover:bg-muted/30"
              onClick={() => document.getElementById("pt-file")?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={async (e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) await handlePartnersFile(f); }}
            >
              <Upload className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
              <p className="font-medium">取引先CSVをドラッグ＆ドロップ or クリック</p>
              {ptFile && <p className="text-primary mt-2">選択中: {ptFile.name}</p>}
            </div>
            <input
              id="pt-file"
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) await handlePartnersFile(f); }}
            />

            {ptParsed && (
              <div className="space-y-2">
                <p><b>{ptParsed.length}件</b>の取引先を解析しました</p>
                <div className="bg-muted rounded p-2 text-xs max-h-40 overflow-auto">
                  <table className="w-full">
                    <thead><tr><th className="text-left">名前</th><th className="text-left">正式名称</th><th className="text-left">電話</th><th className="text-left">登録番号</th><th>仕入先</th><th>顧客</th></tr></thead>
                    <tbody>
                      {ptParsed.slice(0, 20).map((p, i) => (
                        <tr key={i} className="border-b border-background">
                          <td>{p.name}</td>
                          <td>{p.formal_name || "-"}</td>
                          <td>{p.phone || "-"}</td>
                          <td>{p.registered_number || "-"}</td>
                          <td className="text-center">{p.is_vendor ? "✓" : ""}</td>
                          <td className="text-center">{p.is_customer ? "✓" : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {ptParsed.length > 20 && <p className="mt-2">…ほか {ptParsed.length - 20}件</p>}
                </div>

                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={ptUpdateExisting} onChange={(e) => setPtUpdateExisting(e.target.checked)} />
                  既存の取引先も上書き更新する
                </label>

                <Button onClick={commitPartnersImport} disabled={ptUpdating}>
                  {ptUpdating ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <CheckCircle2 className="h-4 w-4 mr-1" />}
                  取引先を取り込む
                </Button>

                {ptMsg && <p className="text-sm font-medium">{ptMsg}</p>}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
