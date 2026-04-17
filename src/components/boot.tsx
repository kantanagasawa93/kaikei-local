"use client";

import { useEffect } from "react";
import { installErrorReporter } from "@/lib/error-reporter";

/**
 * 起動時の1回限りのセットアップ。
 * layout.tsx からマウントされる。
 */
export function Boot() {
  useEffect(() => {
    installErrorReporter();
  }, []);
  return null;
}
