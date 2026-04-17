"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { db, resolveLocalImageUrl } from "@/lib/localDb";
import { formatSqliteDate } from "@/lib/date-utils";
import { deleteReceipt } from "@/lib/receipts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Trash2 } from "lucide-react";
import Link from "next/link";
import type { Receipt } from "@/types";

function ReceiptDetailInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const id = searchParams.get("id");

  useEffect(() => {
    if (id) loadReceipt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadReceipt() {
    if (!id) return;
    const { data } = await db.from("receipts").select("*").eq("id", id).single();
    if (data) {
      const r = data as Receipt;
      setReceipt(r);
      if (r.image_url) {
        const resolved = await resolveLocalImageUrl(r.image_url);
        setImgSrc(resolved);
      }
    }
  }

  async function handleDelete() {
    if (!id || !confirm("この領収書を削除しますか？画像ファイルも削除されます。")) return;
    await deleteReceipt(id);
    router.push("/receipts");
  }

  if (!receipt) {
    return <div className="text-center py-12 text-muted-foreground">読み込み中...</div>;
  }

  const formatCurrency = (amount: number | null) =>
    amount != null
      ? new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(amount)
      : "-";

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/receipts">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-4 w-4 mr-1" />
              戻る
            </Button>
          </Link>
          <h1 className="text-2xl font-bold">領収書詳細</h1>
        </div>
        <Button variant="destructive" size="sm" onClick={handleDelete}>
          <Trash2 className="h-4 w-4 mr-1" />
          削除
        </Button>
      </div>

      {imgSrc && (
        <Card>
          <CardContent className="p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imgSrc}
              alt="領収書画像"
              className="max-h-96 rounded-lg object-contain mx-auto"
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">詳細情報</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">店名・取引先</p>
              <p className="font-medium">{receipt.vendor_name || "-"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">金額</p>
              <p className="font-medium text-lg">{formatCurrency(receipt.amount)}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">日付</p>
              <p className="font-medium">{receipt.date || "-"}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">勘定科目</p>
              <p className="font-medium">
                {receipt.account_name ? (
                  <Badge variant="secondary">{receipt.account_name}</Badge>
                ) : (
                  "-"
                )}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">ステータス</p>
              <Badge>{receipt.status}</Badge>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">登録日</p>
              <p className="font-medium">
                {formatSqliteDate(receipt.created_at)}
              </p>
            </div>
          </div>

          {receipt.ocr_text && (
            <details className="pt-2">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                OCR読み取りテキスト
              </summary>
              <pre className="mt-2 p-3 bg-muted rounded-lg text-xs whitespace-pre-wrap max-h-40 overflow-y-auto">
                {receipt.ocr_text}
              </pre>
            </details>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function ReceiptDetailPage() {
  return (
    <Suspense fallback={<div className="text-center py-12 text-muted-foreground">読み込み中...</div>}>
      <ReceiptDetailInner />
    </Suspense>
  );
}
