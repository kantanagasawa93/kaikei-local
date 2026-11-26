"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Smartphone, Wifi, RefreshCw, Check, Info, Trash2, Loader2 } from "lucide-react";
import {
  discardPhoneUpload,
  findRegisteredReceiptFiles,
  registerPhoneUpload,
} from "@/lib/receipts";
import { confirmDialog } from "@/lib/confirm";
import { toast } from "@/lib/toast";

type LanInfo = { url: string; qr_svg: string; token: string };
type PendingUpload = { filename: string; relative_path: string; received_at: string };

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  return (e as Error)?.message || String(e);
}

function formatReceivedAt(secs: string): string {
  const n = Number(secs);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PhoneUploadPage() {
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [isTauri, setIsTauri] = useState(false);
  // 処理中のファイル (二重クリックで同じ写真を 2 回登録しないため)
  const [working, setWorking] = useState<Set<string>>(new Set());
  const workingRef = useRef<Set<string>>(new Set());

  /**
   * 受信済みで未登録のファイル一覧を取り直す。
   *
   * 一覧は receipts/ フォルダの実ファイルから毎回組み立てる (Rust 側) ので、
   * このページを離れても・アプリを再起動しても消えない。
   * 以前はメモリ上のキューを「読んだら消す」方式で取り出して React の state に
   * 置いていたため、登録前にページを離れると受信した写真が一覧から消えていた。
   */
  const refresh = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const all = (await invoke("list_pending_lan_uploads")) as PendingUpload[];
      const registered = await findRegisteredReceiptFiles(all.map((p) => p.relative_path));
      setPending(all.filter((p) => !registered.has(p.relative_path)));
    } catch {
      /* Tauri 外 / 一時的な DB エラー: 次の更新でまた取り直す */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        // LAN サーバはこのページを開いた時に初めて起動する
        const i = (await invoke("get_lan_upload_info")) as LanInfo | null;
        if (cancelled) return;
        setIsTauri(true);
        setInfo(i);
        await refresh();
      } catch {
        if (!cancelled) setIsTauri(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const t = setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refresh]);

  const begin = (rel: string): boolean => {
    if (workingRef.current.has(rel)) return false;
    workingRef.current.add(rel);
    setWorking(new Set(workingRef.current));
    return true;
  };
  const end = (rel: string) => {
    workingRef.current.delete(rel);
    setWorking(new Set(workingRef.current));
  };

  async function handleRegister(up: PendingUpload) {
    if (!begin(up.relative_path)) return;
    try {
      const outcome = await registerPhoneUpload(up.relative_path);
      if (outcome === "duplicate") {
        toast.info("同じ画像が登録済みだったため、重複として片付けました");
      } else if (outcome === "added_pdf_unrendered") {
        toast.info("PDF を画像化できなかったため、PDF のまま登録しました");
      } else {
        toast.success("領収書として登録しました");
      }
      await refresh();
    } catch (e) {
      toast.error(`登録に失敗しました: ${errText(e)}`);
    } finally {
      end(up.relative_path);
    }
  }

  async function handleDiscard(up: PendingUpload) {
    if (!(await confirmDialog("この受信画像を破棄します。元に戻せません。よろしいですか？", "破棄"))) {
      return;
    }
    if (!begin(up.relative_path)) return;
    try {
      await discardPhoneUpload(up.relative_path);
      await refresh();
    } catch (e) {
      toast.error(`破棄に失敗しました: ${errText(e)}`);
    } finally {
      end(up.relative_path);
    }
  }

  if (loading) {
    return <div className="text-muted-foreground">読込中...</div>;
  }

  if (!isTauri) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <Smartphone className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">
            この機能はデスクトップアプリ版 (KAIKEI LOCAL) で動作します。
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">スマホから領収書を取り込む</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Wifi className="h-5 w-5" />
            同じWi-Fiのスマホで QR をスキャン
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {info ? (
            <div className="flex flex-col md:flex-row gap-6 items-center">
              <div
                className="w-56 h-56 border rounded-lg bg-white flex items-center justify-center"
                dangerouslySetInnerHTML={{ __html: info.qr_svg }}
              />
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">アクセスURL</p>
                <p className="font-mono text-xs break-all">{info.url}</p>
                <p className="text-sm text-muted-foreground mt-4">
                  ① デスクトップPCとスマホを同じWi-Fiに繋ぐ<br />
                  ② スマホのカメラでQRを読む<br />
                  ③ 写真を撮って送信
                </p>
                <div className="flex items-center gap-2 text-xs text-muted-foreground mt-3">
                  <Wifi className="h-3 w-3" />
                  データはLAN内のみ。インターネットには出ません。
                </div>
                <p className="text-xs text-muted-foreground">
                  受け付けはこのページを最初に開いた時に始まり、アプリを終了すると止まります。
                  QR の URL を知っている端末だけが送信できます。
                </p>
              </div>
            </div>
          ) : (
            <p className="text-muted-foreground">LANサーバ情報を取得できませんでした。</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <div className="flex items-start gap-3">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground">
              <strong>別のWi-Fiでも取り込みたい場合</strong>：iCloud写真で同期された写真を
              Mac の写真アプリから直接ドラッグ＆ドロップで追加できます
              （ダッシュボード or 領収書ページのドロップゾーンに）。
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            受信した画像（未登録）
            <Badge variant="secondary">{pending.length}件</Badge>
            <Button size="sm" variant="ghost" onClick={() => void refresh()} title="更新">
              <RefreshCw className="h-4 w-4" />
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              スマホから送信するとここに表示されます。
            </p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {pending.map((p) => {
                const busy = working.has(p.relative_path);
                return (
                  <div key={p.relative_path} className="border rounded-lg p-3 space-y-2">
                    <div className="text-xs truncate" title={p.filename}>
                      {p.filename}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatReceivedAt(p.received_at)}
                    </div>
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={busy}
                      onClick={() => handleRegister(p)}
                    >
                      {busy ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <Check className="h-3 w-3 mr-1" />
                      )}
                      領収書として登録
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full text-muted-foreground"
                      disabled={busy}
                      onClick={() => handleDiscard(p)}
                    >
                      <Trash2 className="h-3 w-3 mr-1" />
                      破棄
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
