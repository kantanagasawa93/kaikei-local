"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ArrowLeft,
  Upload,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Link2,
  FileArchive,
} from "lucide-react";
import {
  importEvidenceZip,
  matchJournalsAndReceipts,
  getEvidenceCoverage,
  type BulkImportResult,
  type MatchResult,
  type CoverageStats,
} from "@/lib/evidence-import";

export default function EvidenceImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [importResult, setImportResult] = useState<BulkImportResult | null>(null);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [coverage, setCoverage] = useState<CoverageStats | null>(null);

  useEffect(() => {
    loadCoverage();
  }, []);

  async function loadCoverage() {
    setCoverage(await getEvidenceCoverage());
  }

  async function handleImport(f: File) {
    setFile(f);
    setImporting(true);
    setImportResult(null);
    setMatchResult(null);
    try {
      const res = await importEvidenceZip(f);
      setImportResult(res);
      // 自動的に続けてマッチング実行
      if (res.imported > 0) {
        setMatching(true);
        const m = await matchJournalsAndReceipts({
          onlyThisIds: res.receipts.map((r) => r.id),
        });
        setMatchResult(m);
        setMatching(false);
      }
      await loadCoverage();
    } catch (e) {
      alert(`インポート失敗: ${(e as Error).message}`);
    } finally {
      setImporting(false);
      setMatching(false);
    }
  }

  async function handleMatchAll() {
    setMatching(true);
    try {
      const m = await matchJournalsAndReceipts();
      setMatchResult(m);
      await loadCoverage();
    } finally {
      setMatching(false);
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
        <h1 className="text-2xl font-bold">証憑（領収書画像・PDF）一括インポート</h1>
      </div>

      {/* カバー率 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-primary" />
            証憑カバー率（電子帳簿保存法対応の目安）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {coverage ? (
            <>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-4 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all ${
                      coverage.coveragePercent >= 80
                        ? "bg-green-500"
                        : coverage.coveragePercent >= 50
                        ? "bg-yellow-500"
                        : "bg-red-500"
                    }`}
                    style={{ width: `${coverage.coveragePercent}%` }}
                  />
                </div>
                <span className="font-bold text-lg tabular-nums">
                  {coverage.coveragePercent}%
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-muted-foreground">仕訳 総数</p>
                  <p className="font-medium">{coverage.totalJournals}件</p>
                </div>
                <div>
                  <p className="text-muted-foreground">証憑あり</p>
                  <p className="font-medium text-green-700">
                    {coverage.journalsWithReceipt}件
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">証憑なし</p>
                  <p className={`font-medium ${coverage.journalsWithoutReceipt > 0 ? "text-red-700" : ""}`}>
                    {coverage.journalsWithoutReceipt}件
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">孤立領収書</p>
                  <p className="font-medium">{coverage.receiptsOrphan}件</p>
                </div>
              </div>
              {coverage.journalsWithoutReceipt > 0 && (
                <p className="text-xs text-yellow-800 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
                  <AlertTriangle className="h-3.5 w-3.5 inline mr-1" />
                  証憑なしの仕訳が {coverage.journalsWithoutReceipt} 件あります。
                  電子帳簿保存法では電子取引の証憑は電子データ保存が必須、紙保存も原則不可（個人・法人とも）。
                  freee 等から ZIP をダウンロードしてここから取り込み、全件証憑ありを目指しましょう。
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">読み込み中...</p>
          )}
        </CardContent>
      </Card>

      {/* ZIP取込 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileArchive className="h-5 w-5" />
            ZIP取込（freee ファイルボックス等）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            freee →「ファイルボックス」または外部クラウドからダウンロードした領収書・請求書の ZIP ファイルを
            ここに置くだけで、内容を展開して画像/PDF を全件 KAIKEI LOCAL に取り込みます。
            重複（同じ SHA-256 ハッシュ）は自動スキップ、取込後は既存仕訳と自動マッチングを試行します。
          </p>

          <div
            className="rounded-xl border-2 border-dashed p-8 text-center cursor-pointer hover:bg-muted/30"
            onClick={() => document.getElementById("zip-input")?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) await handleImport(f);
            }}
          >
            <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="font-medium">
              {importing
                ? "展開中..."
                : matching
                ? "マッチング中..."
                : "ZIP をドラッグ＆ドロップ or クリックして選択"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              対応: jpg/jpeg/png/heic/webp/gif/tiff/pdf を含む .zip
            </p>
            {file && <p className="text-primary mt-2 text-xs">選択中: {file.name}</p>}
          </div>
          <input
            id="zip-input"
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await handleImport(f);
              if (e.target) e.target.value = "";
            }}
          />

          {(importing || matching) && (
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              {importing ? "画像を展開中..." : "仕訳と照合中..."}
            </div>
          )}

          {importResult && (
            <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm space-y-1">
              <p className="font-medium text-green-900">
                ✅ 取込結果: 新規 {importResult.imported} / 重複スキップ {importResult.skipped}
              </p>
              {importResult.errors.length > 0 && (
                <details className="text-xs text-red-700">
                  <summary>エラー {importResult.errors.length}件</summary>
                  <div className="mt-1 max-h-32 overflow-auto">
                    {importResult.errors.slice(0, 30).map((e, i) => (
                      <div key={i}>{e}</div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {matchResult && (
            <div className="rounded-md bg-blue-50 border border-blue-200 p-3 text-sm space-y-1">
              <p className="font-medium text-blue-900">
                🔗 マッチング結果: 新規紐付け {matchResult.matched}件 /
                マッチなし仕訳 {matchResult.unmatchedJournals}件 /
                孤立領収書 {matchResult.orphanReceipts}件
              </p>
              {matchResult.details.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer">
                    紐付け詳細（上位10件）
                  </summary>
                  <div className="mt-1 max-h-40 overflow-auto space-y-0.5">
                    {matchResult.details.slice(0, 10).map((d, i) => (
                      <div key={i}>
                        <b>{d.date}</b> / {d.amount.toLocaleString()}円 /
                        日付差 {d.dateDiff}日 /
                        {d.confidence === "exact" ? "完全一致" : "近接一致"}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 再マッチング */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Link2 className="h-4 w-4" />
            証憑と仕訳を再マッチング
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">
            既に取り込み済みの証憑と、紐付けされていない仕訳を全件再マッチングします。
            日付 ±3 日 + 金額完全一致 の条件で自動紐付けします。
          </p>
          <Button onClick={handleMatchAll} disabled={matching || importing} variant="outline">
            {matching ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Link2 className="h-4 w-4 mr-1" />
            )}
            全件再マッチング実行
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
