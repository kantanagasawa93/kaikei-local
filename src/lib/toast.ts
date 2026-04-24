/**
 * トースト通知の発火用 API。
 * 実体は src/components/toast.tsx の Toaster が `window` イベントで受け取る。
 */

import { emitToast } from "@/components/toast";

export const toast = {
  info: (message: string) => emitToast("info", message),
  success: (message: string) => emitToast("success", message),
  error: (message: string) => emitToast("error", message),
};
