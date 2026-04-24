"use client";

/**
 * 超軽量トースト。
 * ライブラリ依存を避けるため、window CustomEvent で発火する自作実装。
 *
 * 使い方:
 *   <Toaster /> を layout.tsx に一度置く
 *   `import { toast } from "@/lib/toast"; toast.error("DB読み込み失敗")` で発火
 */

import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";

type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const EVENT_NAME = "kaikei-toast";

export function emitToast(kind: ToastKind, message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<Omit<ToastItem, "id">>(EVENT_NAME, {
      detail: { kind, message },
    })
  );
}

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let counter = 0;
    const handler = (e: Event) => {
      const ce = e as CustomEvent<Omit<ToastItem, "id">>;
      const id = ++counter;
      setItems((prev) => [...prev, { id, ...ce.detail }]);
      // 自動消去
      const ttl = ce.detail.kind === "error" ? 7000 : 4000;
      setTimeout(() => {
        setItems((prev) => prev.filter((it) => it.id !== id));
      }, ttl);
    };
    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="fixed z-[200] top-4 right-4 flex flex-col gap-2 max-w-sm w-[360px]">
      {items.map((it) => (
        <div
          key={it.id}
          className={`flex items-start gap-2 rounded-md border px-3 py-2 shadow-lg text-sm animate-in slide-in-from-right-5 ${
            it.kind === "error"
              ? "bg-red-50 border-red-200 text-red-900"
              : it.kind === "success"
                ? "bg-green-50 border-green-200 text-green-900"
                : "bg-blue-50 border-blue-200 text-blue-900"
          }`}
        >
          {it.kind === "error" ? (
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          ) : it.kind === "success" ? (
            <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0" />
          ) : (
            <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
          )}
          <p className="flex-1 leading-snug">{it.message}</p>
          <button
            className="opacity-50 hover:opacity-100"
            onClick={() =>
              setItems((prev) => prev.filter((x) => x.id !== it.id))
            }
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
