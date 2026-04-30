/**
 * freee からダウンロードした 仕訳帳/PL/BS CSV をパースして、
 * 実データの e-Tax XTX (RKO0010 / RSH0010) を生成。
 *
 * 入力:
 *   ~/Downloads/仕訳帳 freee汎用形式 （YYYY年01月~YYYY年12月）.csv
 *   ~/Downloads/試算表：損益計算書_…（…）.csv
 *   ~/Downloads/試算表：貸借対照表_…（…）.csv
 *
 * 出力:
 *   ~/Desktop/RKO0010_real.xtx
 *   ~/Desktop/RSH0010_real.xtx (消費税: 必要なら)
 *
 * 納税者情報・会計年度は設定ファイルから読み込む:
 *   優先順位: --config=<path> > ./etax-config.json > ~/.kaikei/etax-config.json
 *   存在しない場合はテンプレを書き出して exit(1)。
 *
 * CLI:
 *   --year=2025      会計年度を上書き
 *   --config=path    設定ファイルパスを明示
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildShotokuShinkokuXtx } from "../src/lib/etax/rko0010.ts";
import { buildConsumptionTaxStandardXtx } from "../src/lib/etax/rsh0010.ts";

const HOME = os.homedir();
const DOWNLOADS = path.join(HOME, "Downloads");
const DESKTOP = path.join(HOME, "Desktop");

// ──────────────────────────────────────────────────────────
// CLI / 設定ファイル
// ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : null;
};

const CONFIG_TEMPLATE = {
  fiscalYear: new Date().getFullYear() - 1,
  taxpayer: {
    zeimusho_cd: "00000",
    zeimusho_nm: "(税務署名)",
    name: "(氏名)",
    name_kana: "(セイ メイ)",
    birthday_wareki: { era: "平成", yy: 1, mm: 1, dd: 1 },
    postal_code: "0000000",
    address: "(住所)",
    phone: "00000000000",
    yago: "(屋号)",
    shokugyo: "個人事業主",
    jigyo_naiyo: "(事業内容)",
    riyosha_shikibetsu_bango: "0000000000000000",
  },
};

function resolveConfigPath() {
  const explicit = arg("config");
  if (explicit) return path.resolve(explicit);
  const cwd = path.resolve("etax-config.json");
  if (fs.existsSync(cwd)) return cwd;
  return path.join(HOME, ".kaikei", "etax-config.json");
}

const configPath = resolveConfigPath();
if (!fs.existsSync(configPath)) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(CONFIG_TEMPLATE, null, 2) + "\n");
  console.error("⚠️  設定ファイルが見つかりませんでした。テンプレを生成しました:");
  console.error("    " + configPath);
  console.error("    値を埋めて再実行してください。");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const fiscalYear = Number(arg("year")) || Number(config.fiscalYear) || new Date().getFullYear() - 1;
if (!config.taxpayer) {
  console.error("⚠️  config.taxpayer が未定義です:", configPath);
  process.exit(1);
}

console.log(`[gen_real_xtx] config: ${configPath}`);
console.log(`[gen_real_xtx] fiscal year: ${fiscalYear}`);

const PERIOD_START = `${fiscalYear}-01-01`;
const PERIOD_END = `${fiscalYear}-12-31`;

// PL/BS/仕訳帳 のファイル名にはコロンや全角括弧が混じるため、prefix + 年で探す
function findFile(prefix, mustInclude) {
  const files = fs.readdirSync(DOWNLOADS);
  return files.find((f) => f.startsWith(prefix) && (!mustInclude || f.includes(mustInclude)));
}
const yearStr = String(fiscalYear);
const plName = findFile("試算表：損益計算書", yearStr);
const bsName = findFile("試算表：貸借対照表", yearStr);
const journalName = findFile("仕訳帳", yearStr);
const plPath = plName ? path.join(DOWNLOADS, plName) : null;
const bsPath = bsName ? path.join(DOWNLOADS, bsName) : null;
const journalPath = journalName ? path.join(DOWNLOADS, journalName) : null;

if (!plPath || !bsPath) {
  console.error(`PL/BS CSV (${yearStr}) not found in ${DOWNLOADS}`);
  process.exit(1);
}
if (!journalPath) {
  console.error(`Journal CSV (${yearStr}) not found in ${DOWNLOADS}`);
  process.exit(1);
}

// ──────────────────────────────────────────────────────────
// 簡易 CSV パーサ (RFC 4180 風. ダブルクォート + カンマ + 改行対応)
// ──────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else { inQuote = false; }
      } else cur += c;
    } else {
      if (c === '"') inQuote = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") {/* ignore */}
      else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c && c.length));
}

function num(s) {
  if (!s) return 0;
  const v = parseInt(String(s).replace(/[,円]/g, ""), 10);
  return isNaN(v) ? 0 : v;
}

// ──────────────────────────────────────────────────────────
// PL を集計
// ──────────────────────────────────────────────────────────
const plRows = parseCSV(fs.readFileSync(plPath, "utf-8"));
console.log("PL rows:", plRows.length);

// 構造: [大分類, 中分類, コード, 科目名, , 借方, 貸方, 期末, 構成比]
// 大分類は r[0] または r[1] のどちらかに入る (freee CSV の癖)
let section = "";
const plExpense = {};
let uriage = 0;
let shiire = 0;
for (const r of plRows) {
  // 大分類更新 (集計行 "...計" は section を変えない)
  const cat0 = (r[0] || "").trim();
  const cat1 = (r[1] || "").trim();
  for (const cat of [cat0, cat1]) {
    if (/^(収入金額|売上原価|経費|売上総利益|営業損益|差引損益|繰戻額等|繰入額等)$/.test(cat)) {
      section = cat;
    }
  }
  // 科目名は r[3] か、空なら r[2]、それも空なら r[1] (中分類はずれる)
  let name = (r[3] || "").trim();
  if (!name || /^\d+$/.test(name)) name = (r[2] || "").trim();
  if (/^\d+$/.test(name)) name = "";
  const matsu = num(r[7]);
  if (!name || !matsu) continue;
  if (name === "売上高") uriage = matsu;
  else if (name === "仕入高") shiire = matsu;
  else if (section === "経費") plExpense[name] = matsu;
}
console.log("売上高:", uriage, "/ 仕入高:", shiire);
console.log("経費科目数:", Object.keys(plExpense).length);
console.log("経費内訳:", plExpense);

// ──────────────────────────────────────────────────────────
// BS を集計 → BalanceSheetData
// ──────────────────────────────────────────────────────────
const bsRows = parseCSV(fs.readFileSync(bsPath, "utf-8"));
console.log("BS rows:", bsRows.length);

const bsAccounts = {};
for (const r of bsRows) {
  // [区分, 中区分, サブ, コード, 科目名, ..., 期首, 借方, 貸方, 期末, 構成比]
  // ただしカラムずれあり。科目名は最後の数字以外のカラムを取る
  const cells = r;
  // 期末額は通常後ろから3番目 or 2番目
  let kimatsu = 0;
  let name = "";
  for (let i = cells.length - 3; i >= 0; i--) {
    const v = num(cells[i]);
    const s = (cells[i] || "").trim();
    if (v !== 0) {
      // この値が「期末」と仮定 (構成比は %.%% 形式なので除外)
      if (/^-?\d+$/.test(s)) {
        kimatsu = v;
        // 科目名はこの左側で文字列のもの
        for (let j = i - 1; j >= 0; j--) {
          const sj = (cells[j] || "").trim();
          if (sj && !/^-?\d/.test(sj)) { name = sj; break; }
        }
        break;
      }
    }
  }
  if (name && name !== "" && Math.abs(kimatsu) > 0) {
    bsAccounts[name] = kimatsu;
  }
}

// ──────────────────────────────────────────────────────────
// 仕訳帳 → 月別売上仕入
// ──────────────────────────────────────────────────────────
const journalText = fs.readFileSync(journalPath, "utf-8");
const journalRows = parseCSV(journalText);
console.log("Journal rows:", journalRows.length);

const header = journalRows[0];
const ix = (col) => header.indexOf(col);
const I_DATE = ix("取引日");
const I_KARI_KAMOKU = ix("借方勘定科目");
const I_KARI_AMOUNT = ix("借方金額");
const I_KASHI_KAMOKU = ix("貸方勘定科目");
const I_KASHI_AMOUNT = ix("貸方金額");

const monthly = Array.from({ length: 12 }, () => ({ income: 0, cost: 0 }));
let totalSalesFromJournal = 0;
for (let i = 1; i < journalRows.length; i++) {
  const r = journalRows[i];
  if (!r[I_DATE]) continue;
  const m = parseInt(r[I_DATE].split("/")[1], 10) - 1;
  if (m < 0 || m > 11) continue;
  const kashi = (r[I_KASHI_KAMOKU] || "").trim();
  const kari = (r[I_KARI_KAMOKU] || "").trim();
  const kashiAmt = num(r[I_KASHI_AMOUNT]);
  const kariAmt = num(r[I_KARI_AMOUNT]);
  if (kashi === "売上高") { monthly[m].income += kashiAmt; totalSalesFromJournal += kashiAmt; }
  if (kari === "売上高")  { monthly[m].income -= kariAmt;  totalSalesFromJournal -= kariAmt; }
  if (kari === "仕入高")  { monthly[m].cost   += kariAmt;  }
  if (kashi === "仕入高") { monthly[m].cost   -= kashiAmt; }
}
console.log("月別売上集計合計:", totalSalesFromJournal, "(PLの売上:", uriage, ")");

// ──────────────────────────────────────────────────────────
// freee 経費科目名 → kaikei BlueReturnData フィールド
// ──────────────────────────────────────────────────────────
const expenseMap = {
  // 標準科目
  "租税公課": "sozeikoka",
  "荷造運賃": "nitsukuriunchin",
  "水道光熱費": "suidokonetsu",
  "旅費交通費": "ryohikotsu",
  "通信費": "tsushin",
  "広告宣伝費": "kokoku",
  "接待交際費": "settai",
  "損害保険料": "songai_hoken",
  "修繕費": "shuzen",
  "消耗品費": "shomohin",
  "減価償却費": "genka_shokyaku",
  "福利厚生費": "fukuri_kosei",
  "給料賃金": "kyuryo_chinkin",
  "外注工賃": "gaichu_kochin",
  "利子割引料": "rishi_waribiki",
  "地代家賃": "chidai_yachin",
  "貸倒金": "kashidaore",
  "雑費": "zappi",
  // freee特有の名称
  "交際費": "settai",
  "外注費": "gaichu_kochin",
  // 雑費に寄せる
  "研修費": "zappi",
  "支払手数料": "zappi",
  "車両費": "zappi",
  "会議費": "zappi",
  "新聞図書費": "zappi",
};

// ──────────────────────────────────────────────────────────
// XTX 入力データ構築
// ──────────────────────────────────────────────────────────
const blue = {
  jigyo_kikan_jiko_from: PERIOD_START,
  jigyo_kikan_itaru_to: PERIOD_END,
  uriage: uriage,
  shiire: shiire,
  monthly: monthly,
  bs: {
    kimatsu_date: PERIOD_END,
    genkin_kimatsu: bsAccounts["現金"] || 0,
    sonota_yokin_kimatsu: (bsAccounts["西日本シティ（API）"] || 0) + (bsAccounts["楽天"] || 0) + (bsAccounts["モバイルSuica"] || 0),
    urikake_kimatsu: bsAccounts["売掛金"] || 0,
    kogu_kimatsu: bsAccounts["工具器具備品"] || 0,
    tochi_kimatsu: bsAccounts["土地"] || 0,
    sonota_yokin_kishu: 0,
    miharaikin_kimatsu: bsAccounts["未払金"] || 0,
    kariirekin_kimatsu: (bsAccounts["楽天カード"] || 0) + (bsAccounts["三井住友MASTERカード"] || 0),
    motoire_kimatsu: bsAccounts["元入金"] || 0,
    jigyonushi_kashi_kimatsu: bsAccounts["事業主貸"] || 0,
    jigyonushi_kari_kimatsu: bsAccounts["事業主借"] || 0,
  },
};

// 経費を反映
let totalExpense = 0;
for (const [name, value] of Object.entries(plExpense)) {
  const key = expenseMap[name];
  if (key) {
    blue[key] = (blue[key] || 0) + value;
    totalExpense += value;
  } else {
    console.warn(" 未マッピング経費:", name, value);
    blue.zappi = (blue.zappi || 0) + value;
    totalExpense += value;
  }
}
console.log("経費合計:", totalExpense);

const sashihiki = uriage - shiire - totalExpense;
const aoiro_kojo = sashihiki > 0 ? Math.min(650000, sashihiki) : 0;
const eigyo_shotoku = sashihiki - aoiro_kojo;
console.log("差引所得:", sashihiki, "/ 青色控除後:", eigyo_shotoku);

const KISO_KOJO = 480000;
const kojo_goukei = KISO_KOJO;
const kazei_shotoku = Math.max(0, Math.floor((eigyo_shotoku - kojo_goukei) / 1000) * 1000);
const shotokuzei = Math.floor(kazei_shotoku * 0.05);

const income = {
  shinkoku_shurui: "青色",
  shinkoku_kbn_cd: "1",
  eigyo_income: uriage,
  eigyo_shotoku: Math.max(0, eigyo_shotoku),
  goukei_shotoku: Math.max(0, eigyo_shotoku),
  kiso_kojo: KISO_KOJO,
  kojo_goukei,
  kazei_shotoku,
  shotokuzei,
  fukkou_tokubetsu: Math.floor(shotokuzei * 0.021),
  shotokuzei_no_gaku: shotokuzei + Math.floor(shotokuzei * 0.021),
  aoiro_tokubetsu_kojo: aoiro_kojo,
};

// 設定ファイル由来の納税者情報。sakuseiDay は今日の日付 (config に明示があれば優先)。
const sakuseiDay =
  config.sakuseiDay || new Date().toISOString().slice(0, 10);

const ctx = {
  fiscalYear,
  sakuseiDay,
  softName: config.softName || "kaikei",
  vendorName: config.vendorName || "Personal",
  taxpayer: config.taxpayer,
};

const r = buildShotokuShinkokuXtx(ctx, { income, blue });
fs.writeFileSync(path.join(DESKTOP, "RKO0010_real.xtx"), r.xml);
console.log("✅ RKO0010_real.xtx written:", r.xml.length, "bytes");

// 消費税 (売上1000万円未満なら免税事業者なので一般的には不要だが、生成自体は試す)
if (uriage > 0) {
  // 簡易計算 (実際は税抜・税込判定とインボイスT登録が必要)
  const kazei_hyojun = Math.floor(uriage / 1.1 / 1000) * 1000; // 税抜換算
  const shohizei = Math.floor(kazei_hyojun * 0.078);
  const kojo_zeigaku = Math.floor((shiire + totalExpense * 0.5) / 1.1 * 0.078);
  const sashihiki_zei = Math.max(0, shohizei - kojo_zeigaku);
  const cons = buildConsumptionTaxStandardXtx(ctx, {
    kazei_from: PERIOD_START,
    kazei_to: PERIOD_END,
    kazei_hyojun,
    shohizei,
    kojo_zeigaku,
    sashihiki_zeigaku: sashihiki_zei,
    nofu_zeigaku: Math.floor(sashihiki_zei / 100) * 100,
    chihou_kazei_hyojun: sashihiki_zei,
    jouto_wari_gaku: Math.floor(sashihiki_zei * 22 / 78),
    nofu_jouto_wari: Math.floor(sashihiki_zei * 22 / 78 / 100) * 100,
    total_nofu: 0,
  });
  fs.writeFileSync(path.join(DESKTOP, "RSH0010_real.xtx"), cons.xml);
  console.log("✅ RSH0010_real.xtx written:", cons.xml.length, "bytes");
}
