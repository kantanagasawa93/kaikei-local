import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Tauri は静的ファイルとして配信するので static export モードに固定する。
  // これが無いと `next build` が .next/ (server build) を作るだけで out/ が
  // 生成されず、Tauri の frontendDist (../out) が解決できなくなる。
  output: "export",

  // Tauri WebView は file:// 経由で読むので画像最適化の lazy loader を切る
  images: { unoptimized: true },

  // /receipts → out/receipts/index.html という形式で静的書き出し
  trailingSlash: true,
};

export default nextConfig;
