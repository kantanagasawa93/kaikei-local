"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Upload, FileDown, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import {
  parseJournalFile,
  parseGeneric,
  parseCsvLines,
  decodeCsvBytes,
  detectFormat,
  type ImportFormat,
  type ParseResult,
  type GenericMapping,
} from "@/lib/journal-import";
import { commitParsedJournals } from "@/lib/journal-commit";

const FORMAT_LABELS: Record<ImportFormat, string> = {
  moneyforward: "マネーフォワード クラウド会計",
  yayoi: "弥生会計 / やよいの青色申告（弥生インポート形式）",
  freee: "freee 会計 (freee汎用形式 101列)",
  zaimu_oen: "財務応援R4",
  mjs: "MJS かんたんクラウド会計",
  pca: "PCA 会計",
  obc: "勘定奉行 i / V",
  icsdb: "ICSdb",
  generic: "汎用CSV（列マッピング指定）",
  unknown: "不明",
};

export default function JournalImportPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [format, setFormat] = useState<ImportFormat>("unknown");
  const [manualFormat, setManualFormat] = useState<ImportFormat | "auto">("auto");
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [genericMap, setGenericMap] = useState<GenericMapping>({
    dateCol: 0,
    debitAccountCol: 1,
    debitAmountCol: 2,
    creditAccountCol: 3,
    creditAmountCol: 4,
    memoCol: 5,
    hasHeader: true,
  });

  async function handleFileSelect(f: File) {
    setFile(f);
    setCommitMsg(null);
    const buf = new Uint8Array(await f.arrayBuffer());
    const text = decodeCsvBytes(buf);
    const parsed = parseCsvLines(text);
    setRows(parsed);
    const auto = detectFormat(parsed);
    setFormat(auto);
    setManualFormat("auto");
    // 自動で即パース
    const pr = await parseJournalFile(f);
    setParseResult(pr);
  }

  async function repParse() {
    if (!file) return;
    const fmt: ImportFormat | undefined = manualFormat === "auto" ? undefined : manualFormat;
    let pr: ParseResult;
    if (fmt === "generic") {
      const buf = new Uint8Array(await file.arrayBuffer());
      const text = decodeCsvBytes(buf);
      const parsed = parseCsvLines(text);
      pr = parseGeneric(parsed, genericMap);
      pr.format = "generic";
    } else {
      pr = await parseJournalFile(file, fmt);
    }
    setParseResult(pr);
  }

  async function handleCommit() {
    if (!parseResult || parseResult.journals.length === 0) return;
    if (
      !confirm(
        `${parseResult.journals.length}件の仕訳を KAIKEI LOCAL に取り込みます。\n同じ日付・摘要の仕訳が既にある場合はスキップします。`
      )
    )
      return;
    setCommitting(true);
    try {
      const res = await commitParsedJournals(parseResult.journals, { dedupe: true });
      const warningText = res.warnings.length > 0 ? `\n警告 ${res.warnings.length}件` : "";
      setCommitMsg(
        `${res.inserted}件を登録、${res.skipped}件はスキップ（重複 or 明細なし）${warningText}`
      );
    } catch (e) {
      setCommitMsg(`取り込み失敗: ${(e as Error).message}`);
    } finally {
      setCommitting(false);
    }
  }

  const previewJournals = useMemo(
    () => (parseResult?.journals || []).slice(0, 10),
    [parseResult]
  );

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-4">
        <Link href="/journals">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">他ソフトから仕訳 CSV を取り込み</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileDown className="h-5 w-5" />
            対応フォーマット
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <b>マネーフォワード クラウド会計</b>: 仕訳帳インポート用26列CSV（公式サンプル形式）。ヘッダ必須、UTF-8想定。
            </li>
            <li>
              <b>弥生会計 / やよいの青色申告</b>: 「弥生インポート形式」CSV（Shift-JIS、ヘッダなし、識別フラグ方式）。エクスポート時に「弥生インポート形式」を選んでください。
            </li>
            <li>
              <b>freee 会計</b>: 現在サンプル取得中（Phase B）。暫定で汎用マッピングで取り込めます。
            </li>
            <li>
              <b>汎用CSV</b>: 任意のCSVを列マッピング指定で取り込み可能。
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">ファイルを選択</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div
            className="rounded-xl border-2 border-dashed p-8 text-center hover:bg-muted/30 cursor-pointer"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={async (e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) await handleFileSelect(f);
            }}
          >
            <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm font-medium">CSV / TXT をドラッグ&ドロップ or クリックして選択</p>
            <p className="text-xs text-muted-foreground">最大1ファイル。UTF-8 / Shift-JIS 自動判定。</p>
            {file && (
              <p className="text-sm text-primary mt-3 font-medium">選択中: {file.name}</p>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await handleFileSelect(f);
            }}
          />
        </CardContent>
      </Card>

      {file && rows && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">判定結果とフォーマット選択</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              自動判定: <b>{FORMAT_LABELS[format]}</b>（{rows.length}行）
            </p>
            <div className="flex items-center gap-2">
              <label className="w-32">形式</label>
              <select
                value={manualFormat}
                onChange={(e) => setManualFormat(e.target.value as ImportFormat | "auto")}
                className="flex-1 rounded-md border bg-background px-3 py-1.5"
              >
                <option value="auto">自動判定を使う ({FORMAT_LABELS[format]})</option>
                <option value="freee">freee 会計 (freee汎用形式 101列)</option>
                <option value="moneyforward">マネーフォワード クラウド会計</option>
                <option value="yayoi">弥生会計 / やよいの青色申告</option>
                <option value="zaimu_oen">財務応援R4</option>
                <option value="mjs">MJS かんたんクラウド会計</option>
                <option value="pca">PCA 会計</option>
                <option value="obc">勘定奉行 i / V</option>
                <option value="icsdb">ICSdb</option>
                <option value="generic">汎用CSV (列マッピング指定)</option>
              </select>
              <Button size="sm" variant="outline" onClick={repParse}>再解析</Button>
            </div>

            {manualFormat === "generic" && (
              <div className="rounded-md bg-muted p-3 space-y-2">
                <p className="font-medium">列マッピング (0 始まり)</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={genericMap.hasHeader}
                      onChange={(e) =>
                        setGenericMap((m) => ({ ...m, hasHeader: e.target.checked }))
                      }
                    />
                    1行目はヘッダ
                  </label>
                  {(
                    [
                      ["dateCol", "日付列"],
                      ["debitAccountCol", "借方勘定列"],
                      ["debitAmountCol", "借方金額列"],
                      ["creditAccountCol", "貸方勘定列"],
                      ["creditAmountCol", "貸方金額列"],
                      ["memoCol", "摘要列"],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="flex items-center gap-2">
                      <span className="w-20">{label}</span>
                      <input
                        type="number"
                        min={0}
                        value={(genericMap[k as keyof GenericMapping] as number | undefined) ?? 0}
                        onChange={(e) =>
                          setGenericMap((m) => ({
                            ...m,
                            [k]: parseInt(e.target.value, 10) || 0,
                          }))
                        }
                        className="w-16 rounded border px-2 py-1"
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {parseResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">プレビュー（最初の10件）</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm mb-3">
              解析結果: <b>{parseResult.journals.length}</b> 仕訳
              {parseResult.errors.length > 0 && (
                <span className="text-red-600 ml-3">
                  エラー {parseResult.errors.length} 件
                </span>
              )}
              {parseResult.warnings.length > 0 && (
                <span className="text-yellow-600 ml-3">
                  警告 {parseResult.warnings.length} 件
                </span>
              )}
            </div>

            {parseResult.errors.length > 0 && (
              <div className="mb-3 rounded-md bg-red-50 border border-red-200 p-3 text-xs text-red-800 max-h-40 overflow-auto">
                {parseResult.errors.slice(0, 20).map((err, i) => (
                  <div key={i}>{err}</div>
                ))}
              </div>
            )}

            {parseResult.warnings.length > 0 && (
              <details className="mb-3 rounded-md bg-yellow-50 border border-yellow-200 p-3 text-xs text-yellow-800">
                <summary className="cursor-pointer">警告 {parseResult.warnings.length} 件</summary>
                <div className="mt-2 max-h-40 overflow-auto">
                  {parseResult.warnings.slice(0, 50).map((w, i) => (
                    <div key={i}>{w}</div>
                  ))}
                </div>
              </details>
            )}

            {previewJournals.length > 0 && (
              <div className="overflow-auto text-xs">
                <table className="w-full">
                  <thead className="text-left bg-muted">
                    <tr>
                      <th className="p-2">日付</th>
                      <th className="p-2">摘要</th>
                      <th className="p-2">借方</th>
                      <th className="p-2">貸方</th>
                      <th className="p-2 text-right">金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewJournals.map((j, i) => (
                      <tr key={i} className="border-b">
                        <td className="p-2">{j.date}</td>
                        <td className="p-2">{j.description || "-"}</td>
                        <td className="p-2">
                          {j.lines
                            .filter((l) => l.debit_amount > 0)
                            .map((l) => l.account_name)
                            .join(" / ") || "-"}
                        </td>
                        <td className="p-2">
                          {j.lines
                            .filter((l) => l.credit_amount > 0)
                            .map((l) => l.account_name)
                            .join(" / ") || "-"}
                        </td>
                        <td className="p-2 text-right">
                          {j.lines
                            .reduce((s, l) => s + l.debit_amount, 0)
                            .toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parseResult.journals.length > 10 && (
                  <p className="text-xs text-muted-foreground mt-2">
                    ... ほか {parseResult.journals.length - 10} 件
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {parseResult && parseResult.journals.length > 0 && (
        <div className="flex items-center gap-3">
          <Button
            size="lg"
            onClick={handleCommit}
            disabled={committing || parseResult.errors.length > 0}
          >
            {committing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-2" />
            )}
            {committing ? "取り込み中..." : `${parseResult.journals.length}件を KAIKEI LOCAL に取り込む`}
          </Button>
          {commitMsg && (
            <p className="text-sm flex items-center gap-1">
              <AlertCircle className="h-4 w-4" />
              {commitMsg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
