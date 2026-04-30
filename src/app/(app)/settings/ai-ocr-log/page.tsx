"use client";

/**
 * AI OCR 送信履歴ビュアー (Phase 4)
 *
 * 「どの画像を Claude API に送ったか」をユーザが後から検証できるよう、
 * ai_ocr_log を時系列で表示する。プライバシーポリシー上の透明性のため
 * 必須のページ。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Send, ChevronRight, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/localDb";

interface LogRow {
  id: string;
  inbox_id: string | null;
  receipt_id: string | null;
  sent_at: string;
  endpoint: string;
  bytes_sent: number | null;
  result_summary: string | null;
  error: string | null;
}

export default function AiOcrLogPage() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [filter, setFilter] = useState<"all" | "errors">("all");

  useEffect(() => {
    void (async () => {
      const { data } = await db
        .from("ai_ocr_log")
        .select("*")
        .order("sent_at", { ascending: false })
        .limit(200);
      let rows = (data as LogRow[] | null) ?? [];
      if (filter === "errors") {
        rows = rows.filter((r) => r.error);
      }
      setLogs(rows);
    })();
  }, [filter]);

  const totalBytes = logs.reduce((sum, l) => sum + (l.bytes_sent ?? 0), 0);
  const errCount = logs.filter((l) => l.error).length;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Link href="/settings/photo-scan">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Send className="h-6 w-6" />
            AI OCR 送信履歴
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Claude API に送信した画像のログ (透明性のため公開)
          </p>
        </div>
      </div>

      <Card className="border-blue-200 bg-blue-50/40">
        <CardContent className="pt-6 text-sm">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-2xl font-bold">{logs.length}</div>
              <div className="text-xs text-muted-foreground">送信回数</div>
            </div>
            <div>
              <div className="text-2xl font-bold">
                {(totalBytes / 1024 / 1024).toFixed(1)} MB
              </div>
              <div className="text-xs text-muted-foreground">送信データ量</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-red-700">{errCount}</div>
              <div className="text-xs text-muted-foreground">エラー件数</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <button
          onClick={() => setFilter("all")}
          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
            filter === "all"
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background hover:bg-muted"
          }`}
        >
          すべて
        </button>
        <button
          onClick={() => setFilter("errors")}
          className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
            filter === "errors"
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background hover:bg-muted"
          }`}
        >
          エラーのみ
        </button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">直近の送信</CardTitle>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {filter === "errors"
                ? "エラーはありません"
                : "まだ送信履歴がありません"}
            </p>
          ) : (
            <div className="space-y-1">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-start gap-3 p-2 rounded border bg-card text-sm"
                >
                  <div className="flex-shrink-0 pt-0.5">
                    {log.error ? (
                      <AlertCircle className="h-4 w-4 text-red-600" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-muted-foreground">
                      {new Date(log.sent_at).toLocaleString("ja-JP")}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground truncate">
                      {log.endpoint} (
                      {log.bytes_sent ? `${(log.bytes_sent / 1024).toFixed(0)}KB` : "-"})
                    </div>
                    {log.result_summary && (
                      <div className="text-sm mt-0.5">{log.result_summary}</div>
                    )}
                    {log.error && (
                      <div className="text-[12px] text-red-700 mt-1 line-clamp-2">
                        エラー: {log.error}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
