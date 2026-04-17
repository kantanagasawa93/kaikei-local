"use client";

import { useState, useCallback } from "react";
import { Upload, Camera, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ReceiptUploadProps {
  onFileSelect: (file: File) => void;
  isProcessing?: boolean;
}

export function ReceiptUpload({ onFileSelect, isProcessing }: ReceiptUploadProps) {
  const [dragActive, setDragActive] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const handleFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) return;
      const reader = new FileReader();
      reader.onload = (e) => setPreview(e.target?.result as string);
      reader.readAsDataURL(file);
      onFileSelect(file);
    },
    [onFileSelect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (e.dataTransfer.files[0]) {
        handleFile(e.dataTransfer.files[0]);
      }
    },
    [handleFile]
  );

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={cn(
          "border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
          dragActive
            ? "border-primary bg-primary/5"
            : "border-muted-foreground/25 hover:border-primary/50"
        )}
        onClick={() => document.getElementById("receipt-file-input")?.click()}
      >
        {isProcessing ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-10 w-10 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">OCR処理中...</p>
          </div>
        ) : preview ? (
          <div className="flex flex-col items-center gap-2">
            <img
              src={preview}
              alt="レシートプレビュー"
              className="max-h-64 rounded-lg object-contain"
            />
            <p className="text-sm text-muted-foreground">
              クリックまたはドラッグで画像を変更
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Upload className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm font-medium">
              領収書の画像をドラッグ&ドロップ
            </p>
            <p className="text-xs text-muted-foreground">
              またはクリックしてファイルを選択
            </p>
          </div>
        )}
      </div>

      <input
        id="receipt-file-input"
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.[0]) handleFile(e.target.files[0]);
        }}
      />

      <div className="flex gap-2 md:hidden">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => {
            const input = document.getElementById("receipt-file-input") as HTMLInputElement;
            if (input) {
              input.setAttribute("capture", "environment");
              input.click();
            }
          }}
        >
          <Camera className="h-4 w-4 mr-2" />
          カメラで撮影
        </Button>
      </div>
    </div>
  );
}
