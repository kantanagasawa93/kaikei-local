"use client";

import { useRef, useState } from "react";
import ReactCrop, { centerCrop, makeAspectCrop, type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Check, X, RotateCw, Crop as CropIcon, Loader2 } from "lucide-react";

type Props = {
  open: boolean;
  imageUrl: string;
  onClose: () => void;
  onCropped: (croppedBlob: Blob) => Promise<void>;
};

export function ImageCropper({ open, imageUrl, onClose, onCropped }: Props) {
  const [crop, setCrop] = useState<Crop>();
  const [completedCrop, setCompletedCrop] = useState<PixelCrop>();
  const [rotate, setRotate] = useState(0);
  const [saving, setSaving] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    // 初期クロップは画像の90%に設定
    const initialCrop = centerCrop(
      makeAspectCrop(
        { unit: "%", width: 90 },
        width / height,
        width,
        height
      ),
      width,
      height
    );
    setCrop(initialCrop);
  }

  async function handleSave() {
    if (!imgRef.current || !completedCrop) return;
    setSaving(true);
    try {
      const blob = await cropImage(imgRef.current, completedCrop, rotate);
      if (blob) await onCropped(blob);
      onClose();
    } catch (e) {
      console.error("crop save failed:", e);
      alert(`トリミング保存失敗: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[150] bg-black/70"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed inset-4 z-[151] flex items-center justify-center pointer-events-none"
          >
            <div className="bg-card border rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col pointer-events-auto">
              {/* ヘッダー */}
              <div className="flex items-center justify-between border-b px-5 py-3">
                <div className="flex items-center gap-2">
                  <CropIcon className="h-4 w-4" />
                  <h2 className="font-semibold">画像をトリミング</h2>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setRotate((r) => (r + 90) % 360)}
                  >
                    <RotateCw className="h-3.5 w-3.5 mr-1" />
                    90°回転
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onClose}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* 画像エリア */}
              <div className="flex-1 overflow-auto p-4 bg-muted/30 flex items-center justify-center">
                <ReactCrop
                  crop={crop}
                  onChange={(_, percent) => setCrop(percent)}
                  onComplete={(c) => setCompletedCrop(c)}
                  minWidth={50}
                  minHeight={50}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    ref={imgRef}
                    src={imageUrl}
                    alt="トリミング対象"
                    onLoad={onImageLoad}
                    style={{
                      maxHeight: "60vh",
                      transform: `rotate(${rotate}deg)`,
                    }}
                  />
                </ReactCrop>
              </div>

              {/* フッター */}
              <div className="flex items-center justify-between border-t px-5 py-3">
                <p className="text-xs text-muted-foreground">
                  四隅をドラッグして範囲を調整
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={onClose} disabled={saving}>
                    キャンセル
                  </Button>
                  <Button onClick={handleSave} disabled={saving || !completedCrop}>
                    {saving ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4 mr-1" />
                    )}
                    {saving ? "保存中..." : "保存"}
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

async function cropImage(
  image: HTMLImageElement,
  crop: PixelCrop,
  rotate: number
): Promise<Blob | null> {
  // naturalWidth/Height で元画像の実寸、width/height で表示寸
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const cropWidth = crop.width * scaleX;
  const cropHeight = crop.height * scaleY;

  // 回転対応
  const rad = (rotate * Math.PI) / 180;
  const rotatedCanvas = document.createElement("canvas");
  const rctx = rotatedCanvas.getContext("2d");
  if (!rctx) return null;

  // 回転した画像をまず描画
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  rotatedCanvas.width = image.naturalWidth * cos + image.naturalHeight * sin;
  rotatedCanvas.height = image.naturalWidth * sin + image.naturalHeight * cos;
  rctx.translate(rotatedCanvas.width / 2, rotatedCanvas.height / 2);
  rctx.rotate(rad);
  rctx.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);

  canvas.width = cropWidth;
  canvas.height = cropHeight;
  ctx.drawImage(
    rotatedCanvas,
    crop.x * scaleX,
    crop.y * scaleY,
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight
  );

  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => resolve(blob),
      "image/jpeg",
      0.92
    );
  });
}
