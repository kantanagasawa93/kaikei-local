"use client";

import { useCallback, useRef, useState } from "react";
import { Upload, ImagePlus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { db } from "@/lib/localDb";

type Props = {
  onImported?: () => void;
  className?: string;
};

/**
 * ドラッグ＆ドロップ + ファイル選択 で領収書画像を追加する共通エリア。
 * macOSのFinderや写真アプリからのDnDに対応する。
 *
 * 写真アプリから直接ドラッグした場合、OSはブラウザにFileオブジェクトとして渡してくれる
 * （image/jpegなど）。画像データはアプリのdataDirのreceiptsフォルダに保存される。
 */
export function ReceiptDropZone({ onImported, className }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setBusy(true);
      setMessage(null);
      let added = 0;
      let skipped = 0;
      try {
        const { writeFile, mkdir, BaseDirectory } = await import("@tauri-apps/plugin-fs");

        try {
          await mkdir("receipts", { baseDir: BaseDirectory.AppData, recursive: true });
        } catch {}

        for (const file of files) {
          if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
            continue;
          }
          const buf = new Uint8Array(await file.arrayBuffer());

          // SHA-256 ファイルハッシュで重複検知
          const hashBuf = await crypto.subtle.digest("SHA-256", buf as BufferSource);
          const hashHex = Array.from(new Uint8Array(hashBuf))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");

          const { data: existing } = await db
            .from("receipts")
            .select("id")
            .eq("file_hash", hashHex);
          if (existing && existing.length > 0) {
            skipped++;
            continue;
          }

          const ext =
            (file.name.includes(".") ? file.name.split(".").pop() : null) ||
            (file.type === "application/pdf" ? "pdf" : "jpg");
          const safeName = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
          const relPath = `receipts/${safeName}`;
          await writeFile(relPath, buf, { baseDir: BaseDirectory.AppData });

          await db.from("receipts").insert({
            image_url: `local://${relPath}`,
            vendor_name: null,
            amount: null,
            date: new Date().toISOString().split("T")[0],
            status: "pending",
            doc_type: file.type === "application/pdf" ? "other" : "receipt",
            file_hash: hashHex,
          });
          added++;
        }
        if (added === 0 && skipped > 0) {
          setMessage(`すでに登録済み: ${skipped}件（重複スキップ）`);
        } else if (skipped > 0) {
          setMessage(`${added}件を登録、${skipped}件は既存（重複スキップ）`);
        } else {
          setMessage(`${added}件を登録しました`);
        }
        onImported?.();
      } catch (e) {
        console.error(e);
        setMessage("取り込みに失敗しました（デスクトップアプリ版でのみ動作します）");
      } finally {
        setBusy(false);
      }
    },
    [onImported]
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files || []);
      await importFiles(files);
    },
    [importFiles]
  );

  const handleFileInput = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      await importFiles(files);
      if (inputRef.current) inputRef.current.value = "";
    },
    [importFiles]
  );

  return (
    <div
      className={cn(
        "rounded-xl border-2 border-dashed transition-colors",
        dragOver
          ? "border-primary bg-primary/5"
          : "border-border hover:border-primary/50 hover:bg-muted/30",
        className
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="w-full p-8 text-center flex flex-col items-center gap-3 cursor-pointer"
        disabled={busy}
      >
        {busy ? (
          <Loader2 className="h-10 w-10 text-primary animate-spin" />
        ) : (
          <ImagePlus className="h-10 w-10 text-muted-foreground" />
        )}
        <div className="space-y-1">
          <p className="text-base font-medium">
            {busy ? "取り込み中..." : "領収書をドラッグ＆ドロップ"}
          </p>
          <p className="text-sm text-muted-foreground">
            Finder や 写真アプリから直接ドラッグできます。クリックしてファイルを選ぶこともできます。
          </p>
          <p className="text-xs text-muted-foreground flex items-center gap-1 justify-center">
            <Upload className="h-3 w-3" />
            JPG / PNG / HEIC / PDF 対応
          </p>
        </div>
        {message && (
          <p className="text-sm font-medium text-primary">{message}</p>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,application/pdf"
        onChange={handleFileInput}
        className="hidden"
      />
    </div>
  );
}
