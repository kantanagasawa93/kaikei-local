/**
 * e-Tax XTX 生成内容の確認用PDF。
 *
 * 目的:
 *   - XTX に書き出す項目の一覧を人間可読な形で PDF 化する
 *   - 電子申告前に目視チェックできるようにする
 *   - 印刷して紙提出するフォーマットではない (公式OCRレイアウトではない)
 *
 * 構成:
 *   page 1: 確定申告書第一表 (KOA020-1)
 *   page 2: 確定申告書第二表 (KOA020-2) + 納税者情報
 *   page 3: 青色申告決算書 損益計算書 (KOA210-1)
 *   page 4: 月別売上仕入 + 貸借対照表 (KOA210-2, 4)
 *   page 5: 減価償却明細 (KOA210-3)
 */

import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import { embedJapaneseFonts } from "@/lib/pdf-fonts";
import type {
  IncomeReturnData,
  BlueReturnData,
  TaxpayerInfo,
} from "./index";
import { yearToWareki, formatWareki } from "./codes";

interface PageCtx {
  pdf: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number;
  width: number;
  height: number;
}

function addPage(pdf: PDFDocument, font: PDFFont, bold: PDFFont): PageCtx {
  const page = pdf.addPage([595, 842]); // A4
  const { width, height } = page.getSize();
  return { pdf, page, font, bold, y: height - 50, width, height };
}

function text(
  ctx: PageCtx,
  str: string,
  x: number,
  opts: { size?: number; bold?: boolean; color?: [number, number, number] } = {}
) {
  const col = opts.color ?? [0, 0, 0];
  ctx.page.drawText(str, {
    x,
    y: ctx.y,
    size: opts.size ?? 10,
    font: opts.bold ? ctx.bold : ctx.font,
    color: rgb(col[0], col[1], col[2]),
  });
}

function hr(ctx: PageCtx) {
  ctx.page.drawLine({
    start: { x: 40, y: ctx.y - 3 },
    end: { x: ctx.width - 40, y: ctx.y - 3 },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });
}

function heading(ctx: PageCtx, title: string, size = 13) {
  text(ctx, title, 40, { size, bold: true });
  ctx.y -= size + 6;
  hr(ctx);
  ctx.y -= 10;
}

function row(
  ctx: PageCtx,
  label: string,
  value: string | number,
  opts: { indent?: number; valueX?: number; bold?: boolean } = {}
) {
  const indent = opts.indent ?? 60;
  const valueX = opts.valueX ?? 400;
  text(ctx, label, indent, { bold: opts.bold });
  const s =
    typeof value === "number"
      ? `¥${value.toLocaleString("ja-JP")}`
      : value;
  text(ctx, s, valueX, { bold: opts.bold });
  ctx.y -= 14;
}

function nextPageIfNeeded(ctx: PageCtx, required: number): PageCtx {
  if (ctx.y - required > 50) return ctx;
  return addPage(ctx.pdf, ctx.font, ctx.bold);
}

function fmtYen(v: number | undefined): string {
  if (v == null) return "-";
  return `¥${Math.round(v).toLocaleString("ja-JP")}`;
}

// ──────────────────────────────────────────────────────────
// Page 1: 確定申告書第一表
// ──────────────────────────────────────────────────────────

function drawIncomeReturnFirst(
  ctx: PageCtx,
  taxpayer: TaxpayerInfo,
  year: number,
  d: IncomeReturnData
) {
  const wy = yearToWareki(year);

  // タイトル
  text(ctx, `確定申告書 第一表 — ${wy.era}${wy.yy}年分`, 40, {
    size: 16,
    bold: true,
  });
  ctx.y -= 24;
  text(ctx, `申告種類: ${d.shinkoku_shurui}`, 40);
  text(ctx, `納税者: ${taxpayer.name} (${taxpayer.name_kana})`, 260);
  ctx.y -= 14;
  text(ctx, `税務署: ${taxpayer.zeimusho_nm}`, 40);
  text(
    ctx,
    `利用者識別番号: ****${taxpayer.riyosha_shikibetsu_bango.slice(-4)}`,
    260
  );
  ctx.y -= 20;

  heading(ctx, "1. 収入金額等");
  if (d.eigyo_income != null) row(ctx, "営業等", d.eigyo_income);
  if (d.nogyo_income) row(ctx, "農業", d.nogyo_income);
  if (d.fudosan_income) row(ctx, "不動産", d.fudosan_income);
  if (d.haito_income) row(ctx, "配当", d.haito_income);
  if (d.kyuyo_income) row(ctx, "給与", d.kyuyo_income);
  if (d.koteki_nenkin) row(ctx, "公的年金等", d.koteki_nenkin);
  if (d.gyomu_zatsu) row(ctx, "雑 (業務)", d.gyomu_zatsu);
  if (d.sonota_zatsu) row(ctx, "雑 (その他)", d.sonota_zatsu);

  ctx.y -= 4;
  heading(ctx, "2. 所得金額等");
  if (d.eigyo_shotoku != null) row(ctx, "営業等所得", d.eigyo_shotoku);
  if (d.fudosan_shotoku) row(ctx, "不動産所得", d.fudosan_shotoku);
  if (d.kyuyo_shotoku) row(ctx, "給与所得", d.kyuyo_shotoku);
  if (d.zatsu_shotoku) row(ctx, "雑所得", d.zatsu_shotoku);
  if (d.goukei_shotoku != null)
    row(ctx, "合計所得金額", d.goukei_shotoku, { bold: true });

  ctx.y -= 4;
  heading(ctx, "3. 所得から差し引かれる金額 (控除)");
  if (d.iryo_kojo) row(ctx, "医療費控除", d.iryo_kojo);
  if (d.shakaihoken_kojo) row(ctx, "社会保険料控除", d.shakaihoken_kojo);
  if (d.shokibo_kojo) row(ctx, "小規模企業共済等掛金控除", d.shokibo_kojo);
  if (d.seimei_kojo) row(ctx, "生命保険料控除", d.seimei_kojo);
  if (d.jishin_kojo) row(ctx, "地震保険料控除", d.jishin_kojo);
  if (d.kifu_kojo) row(ctx, "寄附金控除", d.kifu_kojo);
  if (d.haigu_kojo) row(ctx, "配偶者(特別)控除", d.haigu_kojo);
  if (d.fuyou_kojo) row(ctx, "扶養控除", d.fuyou_kojo);
  row(ctx, "基礎控除", d.kiso_kojo);
  if (d.kojo_goukei != null)
    row(ctx, "控除合計", d.kojo_goukei, { bold: true });

  ctx.y -= 4;
  heading(ctx, "4. 税金の計算");
  row(ctx, "課税される所得金額", d.kazei_shotoku);
  row(ctx, "上記に対する税額", d.shotokuzei);
  if (d.jutaku_kojo) row(ctx, "住宅借入金等特別控除", d.jutaku_kojo);
  if (d.sashihiki_shotokuzei != null)
    row(ctx, "差引所得税額", d.sashihiki_shotokuzei);
  if (d.fukkou_tokubetsu != null)
    row(ctx, "復興特別所得税", d.fukkou_tokubetsu);
  if (d.shotokuzei_no_gaku != null)
    row(ctx, "所得税等の額", d.shotokuzei_no_gaku, { bold: true });
  if (d.gensen_choshu != null)
    row(ctx, "源泉徴収税額", d.gensen_choshu);
  if (d.osameru_zeikin)
    row(ctx, "納める税金", d.osameru_zeikin, { bold: true });
  if (d.kanpu_zeikin)
    row(ctx, "還付される税金", d.kanpu_zeikin, { bold: true });

  ctx.y -= 4;
  heading(ctx, "5. その他");
  if (d.senjusha_kyuyo) row(ctx, "専従者給与合計", d.senjusha_kyuyo);
  if (d.aoiro_tokubetsu_kojo)
    row(ctx, "青色申告特別控除額", d.aoiro_tokubetsu_kojo);
  if (d.zatsu_gensen)
    row(ctx, "雑所得等の源泉徴収税額合計", d.zatsu_gensen);
}

// ──────────────────────────────────────────────────────────
// Page 2: 第二表
// ──────────────────────────────────────────────────────────

function drawIncomeReturnSecond(ctx: PageCtx, d: IncomeReturnData) {
  text(ctx, "確定申告書 第二表 — 明細", 40, { size: 16, bold: true });
  ctx.y -= 24;

  if (d.income_details && d.income_details.length > 0) {
    heading(ctx, "所得の内訳");
    text(ctx, "種類", 60, { bold: true });
    text(ctx, "支払者", 130, { bold: true });
    text(ctx, "収入", 320, { bold: true });
    text(ctx, "源泉徴収税額", 420, { bold: true });
    ctx.y -= 14;
    let totalW = 0;
    for (const it of d.income_details) {
      text(ctx, it.kind, 60);
      text(ctx, it.payer_name.slice(0, 25), 130);
      text(ctx, fmtYen(it.income), 320);
      text(ctx, fmtYen(it.withholding), 420);
      totalW += it.withholding;
      ctx.y -= 14;
    }
    ctx.y -= 4;
    text(ctx, "源泉徴収税額合計", 60, { bold: true });
    text(ctx, fmtYen(totalW), 420, { bold: true });
    ctx.y -= 18;
  }

  if (d.shakaihoken_meisai && d.shakaihoken_meisai.length > 0) {
    ctx = nextPageIfNeeded(ctx, 100);
    heading(ctx, "社会保険料の内訳");
    for (const s of d.shakaihoken_meisai) {
      row(ctx, s.kind, s.amount);
    }
  }

  if (d.haigusha) {
    ctx = nextPageIfNeeded(ctx, 60);
    heading(ctx, "配偶者");
    row(ctx, "氏名", d.haigusha.name);
    row(ctx, "生年月日", formatWareki(d.haigusha.birthday));
    if (d.haigusha.mynumber)
      row(ctx, "個人番号", `****${d.haigusha.mynumber.slice(-4)}`);
  }

  if (d.fuyo_shinzoku && d.fuyo_shinzoku.length > 0) {
    ctx = nextPageIfNeeded(ctx, 40 + d.fuyo_shinzoku.length * 14);
    heading(ctx, "扶養親族");
    text(ctx, "氏名", 60, { bold: true });
    text(ctx, "続柄", 200, { bold: true });
    text(ctx, "生年月日", 280, { bold: true });
    ctx.y -= 14;
    for (const f of d.fuyo_shinzoku) {
      text(ctx, f.name, 60);
      text(ctx, f.zokugara, 200);
      text(ctx, formatWareki(f.birthday), 280);
      ctx.y -= 14;
    }
  }

  if (d.senjusha && d.senjusha.length > 0) {
    ctx = nextPageIfNeeded(ctx, 40 + d.senjusha.length * 14);
    heading(ctx, "事業専従者");
    text(ctx, "氏名", 60, { bold: true });
    text(ctx, "続柄", 180, { bold: true });
    text(ctx, "給与額", 360, { bold: true });
    ctx.y -= 14;
    for (const s of d.senjusha) {
      text(ctx, s.name, 60);
      text(ctx, s.zokugara, 180);
      text(ctx, fmtYen(s.kyuyo), 360);
      ctx.y -= 14;
    }
  }
}

// ──────────────────────────────────────────────────────────
// Page 3+: 青色申告決算書
// ──────────────────────────────────────────────────────────

function drawBlueReturn(ctx: PageCtx, year: number, b: BlueReturnData) {
  const wy = yearToWareki(year);
  text(ctx, `青色申告決算書 — ${wy.era}${wy.yy}年分`, 40, {
    size: 16,
    bold: true,
  });
  ctx.y -= 24;

  heading(ctx, "損益計算書");
  row(ctx, "売上 (収入) 金額", b.uriage, { bold: true });
  if (b.kishu_tanaoroshi)
    row(ctx, "期首商品棚卸高", b.kishu_tanaoroshi);
  row(ctx, "仕入金額", b.shiire);
  if (b.kimatsu_tanaoroshi)
    row(ctx, "期末商品棚卸高", b.kimatsu_tanaoroshi);

  const expenseFields: Array<[string, number | undefined]> = [
    ["租税公課", b.sozeikoka],
    ["荷造運賃", b.nitsukuriunchin],
    ["水道光熱費", b.suidokonetsu],
    ["旅費交通費", b.ryohikotsu],
    ["通信費", b.tsushin],
    ["広告宣伝費", b.kokoku],
    ["接待交際費", b.settai],
    ["損害保険料", b.songai_hoken],
    ["修繕費", b.shuzen],
    ["消耗品費", b.shomohin],
    ["減価償却費", b.genka_shokyaku],
    ["福利厚生費", b.fukuri_kosei],
    ["給料賃金", b.kyuryo_chinkin],
    ["外注工賃", b.gaichu_kochin],
    ["利子割引料", b.rishi_waribiki],
    ["地代家賃", b.chidai_yachin],
    ["貸倒金", b.kashidaore],
    ["雑費", b.zappi],
  ];

  ctx.y -= 4;
  text(ctx, "— 経費内訳 —", 50);
  ctx.y -= 14;
  let expenseTotal = 0;
  for (const [label, val] of expenseFields) {
    if (val && val > 0) {
      row(ctx, label, val);
      expenseTotal += val;
      ctx = nextPageIfNeeded(ctx, 20);
    }
  }
  row(ctx, "経費合計", expenseTotal, { bold: true });

  if (b.senjusha_kyuyo)
    row(ctx, "専従者給与", b.senjusha_kyuyo);
  if (b.aoiro_tokubetsu_kojo)
    row(ctx, "青色申告特別控除", b.aoiro_tokubetsu_kojo, { bold: true });

  // 月別売上仕入
  if (b.monthly && b.monthly.length === 12) {
    ctx = nextPageIfNeeded(ctx, 300);
    ctx.y -= 10;
    heading(ctx, "月別売上・仕入");
    text(ctx, "月", 60, { bold: true });
    text(ctx, "売上", 150, { bold: true });
    text(ctx, "仕入", 320, { bold: true });
    ctx.y -= 14;
    let tI = 0;
    let tC = 0;
    for (let i = 0; i < 12; i++) {
      const m = b.monthly[i];
      text(ctx, `${i + 1}月`, 60);
      text(ctx, fmtYen(m.income), 150);
      text(ctx, fmtYen(m.cost), 320);
      tI += m.income || 0;
      tC += m.cost || 0;
      ctx.y -= 14;
    }
    if (b.kaji_shohi)
      row(ctx, "家事消費等", b.kaji_shohi);
    if (b.zatsu_shunyu)
      row(ctx, "雑収入", b.zatsu_shunyu);
    text(ctx, "計", 60, { bold: true });
    text(ctx, fmtYen(tI + (b.kaji_shohi || 0) + (b.zatsu_shunyu || 0)), 150, {
      bold: true,
    });
    text(ctx, fmtYen(tC), 320, { bold: true });
    ctx.y -= 14;
  }

  // 貸借対照表
  if (b.bs) {
    ctx = nextPageIfNeeded(ctx, 500);
    ctx.y -= 10;
    heading(ctx, "貸借対照表 (" + (b.bs.kimatsu_date || `${year}-12-31`) + ")");
    text(ctx, "科目", 50, { bold: true });
    text(ctx, "期首", 260, { bold: true });
    text(ctx, "期末", 420, { bold: true });
    ctx.y -= 14;
    const bsRows: Array<[string, number | undefined, number | undefined]> = [
      ["現金", b.bs.genkin_kishu, b.bs.genkin_kimatsu],
      ["普通預金", b.bs.sonota_yokin_kishu, b.bs.sonota_yokin_kimatsu],
      ["定期預金", b.bs.teiki_kishu, b.bs.teiki_kimatsu],
      ["売掛金", b.bs.urikake_kishu, b.bs.urikake_kimatsu],
      ["棚卸資産", b.bs.tanaoroshi_kishu, b.bs.tanaoroshi_kimatsu],
      ["前払金", b.bs.maebarai_kishu, b.bs.maebarai_kimatsu],
      ["貸付金", b.bs.kashitsuke_kishu, b.bs.kashitsuke_kimatsu],
      ["建物", b.bs.tatemono_kishu, b.bs.tatemono_kimatsu],
      ["工具・器具・備品", b.bs.kogu_kishu, b.bs.kogu_kimatsu],
      ["土地", b.bs.tochi_kishu, b.bs.tochi_kimatsu],
    ];
    for (const [lbl, ki, km] of bsRows) {
      if (ki || km) {
        text(ctx, lbl, 50);
        text(ctx, fmtYen(ki), 260);
        text(ctx, fmtYen(km), 420);
        ctx.y -= 14;
      }
    }
    if (b.bs.shisan_goukei_kishu || b.bs.shisan_goukei_kimatsu) {
      text(ctx, "資産合計", 50, { bold: true });
      text(ctx, fmtYen(b.bs.shisan_goukei_kishu), 260, { bold: true });
      text(ctx, fmtYen(b.bs.shisan_goukei_kimatsu), 420, { bold: true });
      ctx.y -= 18;
    }
    // 負債・資本
    const fusaiRows: Array<[string, number | undefined, number | undefined]> = [
      ["支払手形", b.bs.shiharai_tegata_kishu, b.bs.shiharai_tegata_kimatsu],
      ["買掛金", b.bs.kaikake_kishu, b.bs.kaikake_kimatsu],
      ["借入金", b.bs.kariirekin_kishu, b.bs.kariirekin_kimatsu],
      ["未払金", b.bs.miharaikin_kishu, b.bs.miharaikin_kimatsu],
      ["預り金", b.bs.azukari_kishu, b.bs.azukari_kimatsu],
      ["元入金", b.bs.motoire_kishu, b.bs.motoire_kimatsu],
    ];
    for (const [lbl, ki, km] of fusaiRows) {
      if (ki || km) {
        text(ctx, lbl, 50);
        text(ctx, fmtYen(ki), 260);
        text(ctx, fmtYen(km), 420);
        ctx.y -= 14;
      }
    }
    if (b.bs.fusai_goukei_kishu || b.bs.fusai_goukei_kimatsu) {
      text(ctx, "負債・資本合計", 50, { bold: true });
      text(ctx, fmtYen(b.bs.fusai_goukei_kishu), 260, { bold: true });
      text(ctx, fmtYen(b.bs.fusai_goukei_kimatsu), 420, { bold: true });
      ctx.y -= 14;
    }
  }

  // 減価償却
  if (b.depreciation && b.depreciation.length > 0) {
    ctx = nextPageIfNeeded(ctx, 200);
    ctx.y -= 10;
    heading(ctx, "減価償却明細");
    for (const a of b.depreciation) {
      ctx = nextPageIfNeeded(ctx, 80);
      text(ctx, a.name, 50, { bold: true });
      ctx.y -= 14;
      row(ctx, "取得年月", a.acquired);
      row(ctx, "取得価額", a.acquired_price);
      row(ctx, "償却方法 / 耐用年数", `${a.method} / ${a.useful_years}年`);
      row(ctx, "本年分償却費", a.depreciation_year);
      row(ctx, "本年分必要経費算入額", a.expense_amount);
      row(ctx, "未償却残高", a.book_value_kimatsu);
      ctx.y -= 6;
    }
  }
}

// ──────────────────────────────────────────────────────────
// 公開 API
// ──────────────────────────────────────────────────────────

export interface EtaxPdfInput {
  taxpayer: TaxpayerInfo;
  year: number;
  income: IncomeReturnData;
  blue?: BlueReturnData;
}

/**
 * 確定申告 (+青色決算書) の内容確認用PDFを生成。Uint8Array を返す。
 */
export async function buildEtaxConfirmationPdf(
  input: EtaxPdfInput
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { regular: font, bold } = await embedJapaneseFonts(pdf);

  // Page 1: 第一表
  let ctx = addPage(pdf, font, bold);
  drawIncomeReturnFirst(ctx, input.taxpayer, input.year, input.income);

  // Page 2: 第二表
  ctx = addPage(pdf, font, bold);
  drawIncomeReturnSecond(ctx, input.income);

  // Page 3+: 青色申告決算書
  if (input.blue) {
    ctx = addPage(pdf, font, bold);
    drawBlueReturn(ctx, input.year, input.blue);
  }

  return pdf.save();
}
