"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Smartphone, Wifi, RefreshCw, Check, Info } from "lucide-react";
import { db } from "@/lib/localDb";

type LanInfo = { url: string; qr_svg: string; token: string };
type PendingUpload = { filename: string; relative_path: string; received_at: string };

export default function PhoneUploadPage() {
  const [info, setInfo] = useState<LanInfo | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        setIsTauri(true);
        const i = (await invoke("get_lan_upload_info")) as LanInfo | null;
        setInfo(i);
      } catch {
        setIsTauri(false);
      } finally {
        setLoading(false);
      }
    })();

    const t = setInterval(async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const p = (await invoke("list_pending_lan_uploads")) as PendingUpload[];
        if (p.length > 0) setPending((prev) => [...prev, ...p]);
      } catch {}
    }, 3000);
    return () => clearInterval(t);
  }, []);

  async function handleRegister(up: PendingUpload) {
    await db.from("receipts").insert({
      image_url: `local://${up.relative_path}`,
      vendor_name: null,
      amount: null,
      date: new Date().toISOString().split("T")[0],
      status: "pending",
      doc_type: "receipt",
    });
    setPending((prev) => prev.filter((p) => p.relative_path !== up.relative_path));
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
            受信した画像
            <Badge variant="secondary">{pending.length}件</Badge>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                try {
                  const { invoke } = await import("@tauri-apps/api/core");
                  const p = (await invoke("list_pending_lan_uploads")) as PendingUpload[];
                  if (p.length > 0) setPending((prev) => [...prev, ...p]);
                } catch {}
              }}
            >
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
              {pending.map((p) => (
                <div key={p.relative_path} className="border rounded-lg p-3 space-y-2">
                  <div className="text-xs truncate">{p.filename}</div>
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => handleRegister(p)}
                  >
                    <Check className="h-3 w-3 mr-1" />
                    領収書として登録
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
