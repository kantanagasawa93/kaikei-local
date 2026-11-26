"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { resolveLocalImageUrl } from "@/lib/localDb";
import { JournalForm, type JournalLineInput } from "@/components/journal-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Sparkles, Wand2, Image as ImageIcon, X, ExternalLink } from "lucide-react";
import Link from "next/link";
import { receiptIdsFromInbox, rejournalize } from "@/lib/auto-journal";
import { toast } from "@/lib/toast";
import { confirmDialog } from "@/lib/confirm";
import { replaceJournal } from "@/lib/journal-save";

/** 編集画面で参照する、元領収書の軽量ビュー。 */
type ReceiptLite = {
  id: string;
  image_url: string | null;
  amount: number | null;
  vendor_name: string | null;
  date: string | null;
};

/** journal_lines を DB から読んだときの行の型。 */
type JournalLineRow = {
  account_code: string;
  account_name: string;
  debit_amount: number;
  credit_amount: number;
  tax_code: string | null;
  tax_amount: number | null;
  partner_id: string | null;
  memo: string | null;
};

function EditInner() {
  const params = useSearchParams();
  const router = useRouter();
  const id = params.get("id");
  const [loading, setLoading] = useState(true);
  const [initialData, setInitialData] = useState<{
    date: string;
    description: string;
    lines: JournalLineInput[];
  } | null>(null);
  // 領収書が紐付いているか (右側に写真を出す)
  const [hasReceipt, setHasReceipt] = useState(false);
  // ㉭ Round 12: 受信箱の写真から作られた仕訳にだけ「再仕訳化」を出す。
  // 領収書登録ページから作った仕訳にも receipt_id は付くが、戻す先の写真が無い。
  const [fromInbox, setFromInbox] = useState(false);
  // 元領収書 (写真を見ながら入力・保存できるように編集画面へ表示する)
  const [receipt, setReceipt] = useState<ReceiptLite | null>(null);
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [rejournalizing, setRejournalizing] = useState(false);

  // 再仕訳化ボタンのハンドラ
  async function handleRejournalize() {
    if (!id || rejournalizing) return;
    const ok = await confirmDialog(
      "写真をもう一度 AI OCR で読み取り、その結果でこの仕訳を作り直します。\n\n" +
        "・ここで手で直した科目や金額は、読み取り結果で置き換わります\n" +
        "・読み取りに失敗した場合、今の仕訳はそのまま残ります\n\n" +
        "続行しますか?",
    );
    if (!ok) return;
    setRejournalizing(true);
    try {
      await rejournalize(id);
      toast.success("AI OCR で再仕訳化しました");
      router.push("/journals");
    } catch (e) {
      toast.error(`再仕訳化に失敗: ${(e as Error).message}`);
      setRejournalizing(false);
    }
  }

  useEffect(() => {
    // 画像 Blob URL は unmount / id 変更時に revoke する
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      if (!id) {
        if (!cancelled) setLoading(false);
        return;
      }
      const { data: journal } = await supabase
        .from("journals")
        .select("*")
        .eq("id", id)
        .single();
      if (!journal) {
        if (!cancelled) setLoading(false);
        return;
      }
      const { data: lines } = await supabase
        .from("journal_lines")
        .select("*")
        .eq("journal_id", id);

      if (cancelled) return;
      setInitialData({
        date: journal.date,
        description: journal.description,
        lines: ((lines || []) as JournalLineRow[]).map((l) => ({
          account_code: l.account_code,
          account_name: l.account_name,
          debit_amount: l.debit_amount,
          credit_amount: l.credit_amount,
          tax_code: l.tax_code || "OUT",
          tax_amount: l.tax_amount || 0,
          partner_id: l.partner_id || null,
          memo: l.memo || null,
        })),
      });
      setHasReceipt(!!journal.receipt_id);
      if (journal.receipt_id) {
        try {
          const linked = await receiptIdsFromInbox([journal.receipt_id]);
          if (!cancelled) setFromInbox(linked.has(journal.receipt_id));
        } catch {
          /* 判定できない時はボタンを出さないだけ */
        }
      }

      // 元領収書 (画像 + OCR 参考値) を読み込む
      if (journal.receipt_id) {
        const { data: r } = await supabase
          .from("receipts")
          .select("id, image_url, amount, vendor_name, date")
          .eq("id", journal.receipt_id)
          .single();
        if (!cancelled && r) {
          setReceipt(r as ReceiptLite);
          if ((r as ReceiptLite).image_url) {
            const resolved = await resolveLocalImageUrl((r as ReceiptLite).image_url);
            if (cancelled) {
              if (resolved) URL.revokeObjectURL(resolved);
            } else {
              objectUrl = resolved;
              setImgSrc(resolved);
            }
          }
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id]);

  const handleSubmit = async (data: {
    date: string;
    description: string;
    lines: JournalLineInput[];
  }) => {
    if (!id) return;
    // 新しい明細を入れてから古い明細を消す (失敗しても元の明細が残る)。
    // 失敗時は例外になり、フォームがエラーを表示する。
    await replaceJournal(id, data);
    router.push("/journals");
  };

  if (loading) {
    return <div className="text-center py-12 text-muted-foreground">読み込み中...</div>;
  }

  if (!initialData) {
    return <div className="text-center py-12 text-muted-foreground">仕訳が見つかりません</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 flex-wrap">
        <Link href="/journals">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            戻る
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">仕訳を編集</h1>
        {/* ㉭ Round 12: 受信箱由来の仕訳のみに「AI OCR で再仕訳化」を出す.
            押すと journal+receipt 削除 → photo_inbox を receipt 状態に戻し →
            autoJournalizeOne で再仕訳。誤操作の救済は仕訳帳の Undo で。 */}
        {fromInbox && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleRejournalize}
            disabled={rejournalizing}
            className="ml-auto"
            title="写真を AI OCR で読み直して、この仕訳を作り直す"
          >
            <Wand2 className={`h-4 w-4 mr-1 ${rejournalizing ? "animate-pulse" : ""}`} />
            {rejournalizing ? "再仕訳化中..." : "AI OCR で再仕訳化"}
          </Button>
        )}
      </div>

      {/* 領収書があれば「フォーム | 領収書画像」の 2 カラム。写真を見ながら
          金額・科目を確認して保存できる。無ければ従来どおり 1 カラム。 */}
      <div
        className={
          hasReceipt
            ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]"
            : "max-w-3xl"
        }
      >
        <div className="space-y-6 min-w-0">
          {/* ㉝ Round 9: auto 分割サマリー */}
          <AutoSplitSummary lines={initialData.lines} />

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">仕訳の編集</CardTitle>
            </CardHeader>
            <CardContent>
              <JournalForm onSubmit={handleSubmit} initialData={initialData} />
            </CardContent>
          </Card>
        </div>

        {hasReceipt && <ReceiptPanel receipt={receipt} imgSrc={imgSrc} />}
      </div>
    </div>
  );
}

/**
 * 元領収書パネル。写真 (クリックで全画面拡大) + OCR が読んだ店名/金額/日付を
 * 参考表示する。スクロールしても追従するよう sticky。
 */
function ReceiptPanel({
  receipt,
  imgSrc,
}: {
  receipt: ReceiptLite | null;
  imgSrc: string | null;
}) {
  const [zoom, setZoom] = useState(false);

  return (
    <div className="lg:sticky lg:top-4 lg:self-start">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            元の領収書
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {imgSrc ? (
            <button
              type="button"
              onClick={() => setZoom(true)}
              className="group relative block w-full overflow-hidden rounded-lg border"
              title="クリックで拡大"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imgSrc}
                alt="元の領収書"
                className="max-h-[65vh] w-full object-contain bg-muted/30"
              />
              <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                クリックで拡大
              </span>
            </button>
          ) : receipt ? (
            <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
              画像を読み込めませんでした。
              <br />
              （ファイルが移動・削除された可能性があります）
            </p>
          ) : null}

          {/* OCR が読んだ参考値 (入力の答え合わせ用) */}
          {receipt && (
            <dl className="space-y-1 text-xs">
              <RefRow label="店名" value={receipt.vendor_name} />
              <RefRow
                label="金額 (OCR)"
                value={
                  receipt.amount != null
                    ? `¥${receipt.amount.toLocaleString()}`
                    : null
                }
                strong
              />
              <RefRow label="日付" value={receipt.date} />
            </dl>
          )}

          {receipt && (
            <Link
              href={`/receipts/view?id=${receipt.id}`}
              className="inline-flex items-center gap-1 text-xs text-blue-700 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              領収書の詳細を開く
            </Link>
          )}
        </CardContent>
      </Card>

      {/* 全画面拡大オーバーレイ */}
      {zoom && imgSrc && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setZoom(false)}
          role="dialog"
          aria-label="領収書の拡大表示"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imgSrc}
            alt="元の領収書 (拡大)"
            className="max-h-full max-w-full object-contain"
          />
          <button
            type="button"
            onClick={() => setZoom(false)}
            className="absolute right-4 top-4 rounded-full bg-white/90 p-2 text-black shadow hover:bg-white"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}

function RefRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string | null;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-semibold" : ""}>{value || "-"}</dd>
    </div>
  );
}

/**
 * Round 9 ㉝: 自動分割された仕訳をハイライト表示する小さなカード。
 *
 * memo に "自動分割" が含まれる借方 line が 2 つ以上あれば「自動分割の内訳」
 * カードを出す。価格按分 / 件数按分の区別、各勘定科目の amount、共通品目を
 * 1 か所にまとめて表示するので、編集中ユーザは「なぜこの仕訳が複数行なのか」
 * が一目で分かる。
 */
function AutoSplitSummary({ lines }: { lines: JournalLineInput[] }) {
  const splitLines = lines.filter(
    (l) => l.memo && /^自動分割/.test(l.memo) && (l.debit_amount ?? 0) > 0,
  );
  if (splitLines.length < 2) return null;

  // 按分方式: memo 文字列に「価格按分」が含まれていれば price、件数按分なら count
  const method = splitLines.some((l) => l.memo?.includes("価格按分"))
    ? ("price" as const)
    : ("count" as const);

  const total = splitLines.reduce((acc, l) => acc + (l.debit_amount ?? 0), 0);

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          自動分割の内訳
          <Badge variant="secondary" className="text-[10px] font-normal">
            {method === "price" ? "価格按分" : "件数按分"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="space-y-1 text-xs">
          {splitLines.map((l, i) => {
            const ratio = total > 0 ? Math.round(((l.debit_amount ?? 0) / total) * 100) : 0;
            return (
              <li key={i} className="flex items-baseline gap-2">
                <span className="font-mono text-muted-foreground w-12 text-right">{ratio}%</span>
                <span className="font-medium min-w-[7em]">{l.account_name}</span>
                <span className="font-mono tabular-nums">¥{(l.debit_amount ?? 0).toLocaleString()}</span>
                {l.memo && (
                  <span className="text-muted-foreground text-[10px] truncate">
                    {l.memo.replace(/^自動分割\s*\(/, "(")}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[10px] text-muted-foreground">
          合計 ¥{total.toLocaleString()}。誤判定があれば下のフォームから直接編集できます。
        </p>
      </CardContent>
    </Card>
  );
}

export default function EditJournalPage() {
  return (
    <Suspense fallback={<div className="text-center py-12 text-muted-foreground">読み込み中...</div>}>
      <EditInner />
    </Suspense>
  );
}
