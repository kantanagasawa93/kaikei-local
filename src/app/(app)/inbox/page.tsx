"use client";

/**
 * 写真自動取込「受信箱」ページ
 *
 * - macOS の写真ライブラリ (iCloud 同期含む) から取り込まれた写真候補を一覧
 * - 状態: candidate (未判定) / receipt (領収書) / not_receipt / imported / dismissed
 * - 各行で "領収書として登録" / "違う" / "破棄" のアクション
 *
 * 注: Phase 1 ではユーザが手動で「今すぐスキャン」を押す。Vision OCR や
 * 自動仕訳は Phase 2〜4 で順次有効化される。
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Inbox as InboxIcon,
  RefreshCw,
  Camera,
  Settings,
  AlertCircle,
  Check,
  X as XIcon,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  scanNow,
  listInbox,
  setInboxState,
  getAuthStatus,
  type AuthStatus,
  type InboxRow,
} from "@/lib/photo-scanner";
import { toast } from "@/lib/toast";

export default function InboxPage() {
  const router = useRouter();
  const [items, setItems] = useState<InboxRow[]>([]);
  const [auth, setAuth] = useState<AuthStatus>("unknown");
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<InboxRow["state"] | "all">("candidate");

  const refresh = async () => {
    setAuth(await getAuthStatus());
    setItems(await listInbox(filter === "all" ? undefined : filter));
  };

  useEffect(() => {
    void refresh();
  }, [filter]);

  const handleScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const result = await scanNow("manual");
      if (result.newPhotos > 0) {
        toast.success(`新規 ${result.newPhotos} 枚を取り込みました`);
      } else if (result.scanned === 0) {
        toast.info("新規の写真はありませんでした");
      } else {
        toast.info(`${result.scanned} 枚スキャン (新規はありません)`);
      }
      await refresh();
    } catch (e) {
      toast.error(`スキャン失敗: ${(e as Error).message}`);
    } finally {
      setScanning(false);
    }
  };

  const markReceipt = async (id: string) => {
    await setInboxState(id, "receipt");
    await refresh();
  };
  const markNotReceipt = async (id: string) => {
    await setInboxState(id, "not_receipt");
    await refresh();
  };
  const dismiss = async (id: string) => {
    await setInboxState(id, "dismissed");
    await refresh();
  };

  const isAuthorized = auth === "authorized" || auth === "limited";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <InboxIcon className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">写真受信箱</h1>
            <p className="text-sm text-muted-foreground">
              iCloud 写真から自動で見つけた領収書候補
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Link href="/settings/photo-scan">
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-1" />
              設定
            </Button>
          </Link>
          <Button onClick={handleScan} disabled={scanning || !isAuthorized}>
            <RefreshCw className={`h-4 w-4 mr-1 ${scanning ? "animate-spin" : ""}`} />
            {scanning ? "スキャン中..." : "今すぐスキャン"}
          </Button>
        </div>
      </div>

      {!isAuthorized && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="pt-6 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="space-y-2 flex-1">
              <p className="text-sm">
                写真ライブラリへのアクセスが許可されていません (status:{" "}
                <code className="bg-white px-1 rounded">{auth}</code>)
              </p>
              <p className="text-xs text-muted-foreground">
                設定ページからアクセス権を許可してください。許可しなくても、
                ドラッグ&ドロップやスマホ取込からの登録はそのまま使えます。
              </p>
              <div>
                <Link href="/settings/photo-scan">
                  <Button size="sm" variant="outline">
                    <Settings className="h-3.5 w-3.5 mr-1" />
                    アクセスを許可する
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2 flex-wrap">
        {[
          { key: "candidate", label: "未判定", color: "default" },
          { key: "receipt", label: "領収書", color: "secondary" },
          { key: "imported", label: "取り込み済", color: "secondary" },
          { key: "not_receipt", label: "違う", color: "outline" },
          { key: "dismissed", label: "破棄", color: "outline" },
          { key: "all", label: "すべて", color: "outline" },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key as InboxRow["state"] | "all")}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
              filter === f.key
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background hover:bg-muted"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            <Camera className="h-10 w-10 mx-auto mb-3 opacity-30" />
            {filter === "candidate"
              ? "未判定の写真はありません。「今すぐスキャン」を押すと最近の写真を取り込みます。"
              : "該当する写真はありません。"}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {items.map((it) => (
            <InboxCard
              key={it.id}
              row={it}
              onMarkReceipt={() => markReceipt(it.id)}
              onMarkNotReceipt={() => markNotReceipt(it.id)}
              onDismiss={() => dismiss(it.id)}
              onOpenForReceipt={() => {
                // 既存の領収書登録フローに乗せる
                // file_path をクエリで渡し、receipts/new で fetch して使う設計は Phase 4 で
                router.push(`/receipts/new?inbox=${it.id}`);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function InboxCard({
  row,
  onMarkReceipt,
  onMarkNotReceipt,
  onDismiss,
  onOpenForReceipt,
}: {
  row: InboxRow;
  onMarkReceipt: () => void;
  onMarkNotReceipt: () => void;
  onDismiss: () => void;
  onOpenForReceipt: () => void;
}) {
  // file:// URL は Tauri webview から asset プロトコル経由で参照する
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!row.file_path) return;
    void (async () => {
      try {
        const { convertFileSrc } = await import("@tauri-apps/api/core");
        setSrc(convertFileSrc(row.file_path!));
      } catch {
        // fallback: そのまま表示できないが UI は崩さない
      }
    })();
  }, [row.file_path]);

  return (
    <Card className="overflow-hidden flex flex-col">
      <div className="aspect-[4/3] bg-muted relative">
        {src ? (
          <img src={src} alt="" className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
            画像読み込み中...
          </div>
        )}
        {row.receipt_score !== null && (
          <Badge
            variant="secondary"
            className="absolute top-2 right-2 text-[10px] font-mono"
          >
            score {row.receipt_score.toFixed(2)}
          </Badge>
        )}
        <Badge variant="outline" className="absolute top-2 left-2 text-[10px] bg-background/80 backdrop-blur-sm">
          {row.state}
        </Badge>
      </div>
      <CardContent className="p-3 space-y-2 flex-1 flex flex-col">
        <div className="text-xs text-muted-foreground">
          {row.taken_at ? new Date(row.taken_at).toLocaleString("ja-JP") : "-"}
        </div>
        {row.ocr_text && (
          <div className="text-[11px] text-muted-foreground line-clamp-2 leading-tight">
            {row.ocr_text.slice(0, 80)}
          </div>
        )}
        <div className="flex flex-wrap gap-1 mt-auto pt-2">
          {row.state === "candidate" && (
            <>
              <Button size="sm" variant="default" onClick={onMarkReceipt} className="text-xs px-2 h-7">
                <Check className="h-3 w-3 mr-1" />
                領収書
              </Button>
              <Button size="sm" variant="outline" onClick={onMarkNotReceipt} className="text-xs px-2 h-7">
                <XIcon className="h-3 w-3 mr-1" />
                違う
              </Button>
            </>
          )}
          {row.state === "receipt" && (
            <Button size="sm" onClick={onOpenForReceipt} className="text-xs px-2 h-7 w-full">
              <ArrowRight className="h-3 w-3 mr-1" />
              登録に進む
            </Button>
          )}
          {(row.state === "not_receipt" || row.state === "candidate") && (
            <Button size="sm" variant="ghost" onClick={onDismiss} className="text-xs px-2 h-7">
              破棄
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
