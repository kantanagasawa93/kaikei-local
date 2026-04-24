/**
 * LP用のアプリスクリーンショットを自動取得するスクリプト。
 *
 * 使い方:
 *   1. `npm run dev` で dev サーバーを http://localhost:3000 で起動
 *   2. `node scripts/capture-lp-screenshots.mjs` を実行
 *   3. site/assets/screenshots/ に PNG が書き出される
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const OUTPUT_DIR = "/Users/nagasawakanta/kaikei/site/assets/screenshots";
const BASE_URL = "http://localhost:3000";
const VIEWPORT = { width: 1440, height: 900 };

const TARGETS = [
  { key: "ai-ocr", path: "/receipts", label: "領収書一覧" },
  { key: "ai-journal", path: "/journals", label: "仕訳帳" },
  { key: "phone-capture", path: "/phone-upload", label: "スマホ取込" },
  { key: "local-storage", path: "/settings", label: "設定/バックアップ" },
  { key: "blue-return", path: "/tax-return", label: "確定申告" },
  { key: "invoice", path: "/invoices", label: "請求書" },
  { key: "etax", path: "/etax", label: "e-Tax出力" },
  { key: "journal-receipt-link", path: "/journals", label: "仕訳⇔領収書リンク" },
  { key: "migration", path: "/journals/import", label: "CSV移行" },
  { key: "bank-csv", path: "/transactions", label: "明細取込" },
  { key: "dashboard", path: "/dashboard", label: "ダッシュボード" },
];

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 2, // retina
});
const page = await ctx.newPage();

// Welcome modal を閉じる共通関数
async function dismissWelcome() {
  try {
    const skip = await page.waitForSelector('button:has-text("スキップ")', {
      timeout: 2000,
    });
    await skip.click();
    await page.waitForTimeout(400);
  } catch {
    // モーダル未表示ならスキップ
  }
}

async function capture(target) {
  // ?demo=1 を付けてページ側のモックデータを出す
  const url = BASE_URL + target.path + (target.path.includes("?") ? "&" : "?") + "demo=1";
  console.log(`[${target.key}] ${url} ...`);
  await page.goto(url, { waitUntil: "networkidle" });
  await dismissWelcome();
  await page.waitForTimeout(1200); // 画像ロード + データ描画待ち

  // LP用に邪魔なオーバーレイを消す (Next.js dev "N Issues" バッジなど)
  await page.evaluate(() => {
    // Vercel/Next.js dev toolbar
    document.querySelectorAll('[data-nextjs-toast], [data-nextjs-dialog-overlay], #__next-build-watcher, nextjs-portal').forEach((el) => el.remove());
    // 左下に固定された残件バッジ等を除去 (position:fixed で bottom + left が小さい要素)
    document.querySelectorAll('body > *').forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' && parseInt(cs.bottom) < 50 && parseInt(cs.left) < 50 && el.offsetWidth < 200 && el.offsetHeight < 60) {
        el.style.display = 'none';
      }
    });
  });
  await page.waitForTimeout(200);

  const outPath = path.join(OUTPUT_DIR, `${target.key}.png`);
  await page.screenshot({
    path: outPath,
    fullPage: false,
    clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
  });
  console.log(`  → ${outPath}`);
}

for (const t of TARGETS) {
  try {
    await capture(t);
  } catch (err) {
    console.error(`  ✗ ${t.key}: ${err.message}`);
  }
}

await browser.close();
console.log("\nDone.");
