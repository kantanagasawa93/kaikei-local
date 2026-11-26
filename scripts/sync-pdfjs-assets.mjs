#!/usr/bin/env node
/**
 * pdf.js の実行時アセットを node_modules から public/ にコピーする。
 * `npm run build` / `npm run dev` の前に自動で走る (package.json の prebuild / predev)。
 *
 *   - pdf.worker.min.mjs      → public/pdf.worker.min.mjs
 *       ライブラリ本体と worker のバージョンが食い違うと pdf.js は動かないので、
 *       依存を更新した時に手でコピーし忘れる事故を防ぐ。
 *   - cmaps/, standard_fonts/ → public/pdfjs/
 *       日本語フォントを埋め込んでいない PDF は CMap が無いと文字が描画されず、
 *       領収書 PDF を画像化した時に罫線だけの画像になる。
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "node_modules", "pdfjs-dist");
const pub = path.join(root, "public");

if (!fs.existsSync(src)) {
  console.error("[sync-pdfjs-assets] node_modules/pdfjs-dist が見つかりません。npm ci を実行してください");
  process.exit(1);
}

fs.copyFileSync(
  path.join(src, "build", "pdf.worker.min.mjs"),
  path.join(pub, "pdf.worker.min.mjs"),
);

for (const dir of ["cmaps", "standard_fonts"]) {
  const dest = path.join(pub, "pdfjs", dir);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(src, dir), dest, { recursive: true });
}

const count = (d) => fs.readdirSync(path.join(pub, "pdfjs", d)).length;
console.log(
  `[sync-pdfjs-assets] worker + cmaps(${count("cmaps")}) + standard_fonts(${count("standard_fonts")}) → public/`,
);
