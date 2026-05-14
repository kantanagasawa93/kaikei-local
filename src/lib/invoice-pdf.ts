/**
 * 請求書の簡易PDF出力。
 * 国税庁の適格請求書（インボイス）の要件を満たす項目を含める:
 *   1. 発行事業者の氏名・登録番号
 *   2. 取引年月日
 *   3. 取引内容（軽減税率対象品目である旨）
 *   4. 税率ごとに区分して合計した対価の額及び適用税率
 *   5. 税率ごとに区分した消費税額等
 *   6. 書類の交付を受ける事業者の氏名または名称
 */

import { PDFDocument, rgb } from "pdf-lib";
import type { Invoice, InvoiceItem, IssuerSettings } from "@/types";
import { TAX_CLASSES } from "@/lib/tax-classes";
import { embedJapaneseFonts, containsNonAscii } from "@/lib/pdf-fonts";

export async function exportInvoicePdf(
  invoice: Invoice,
  items: InvoiceItem[],
  issuer: IssuerSettings | null
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { regular: jpFont, bold: jpBold, asciiRegular, asciiBold } =
    await embedJapaneseFonts(pdf);
  const page = pdf.addPage([595, 842]); // A4
  const { width, height } = page.getSize();

  // 文字列に日本語が混じっていれば Noto Sans JP、純 ASCII なら Helvetica。
  // (Noto Sans JP は数字も全角幅 advance なので、ASCII 全角化 = 間延び を避けるため)
  const draw = (text: string, x: number, y: number, opts: { size?: number; bold?: boolean; color?: [number, number, number] } = {}) => {
    const useJp = containsNonAscii(text);
    const font = opts.bold
      ? (useJp ? jpBold : asciiBold)
      : (useJp ? jpFont : asciiRegular);
    page.drawText(text, {
      x,
      y,
      size: opts.size ?? 10,
      font,
      color: rgb(...(opts.color ?? [0, 0, 0])),
    });
  };

  let y = height - 50;
  // タイトル
  draw("請求書", 40, y, { size: 24, bold: true });
  // 右上に請求書番号 / 発行日 / 支払期限
  draw(`請求書番号: ${invoice.invoice_number}`, width - 200, y + 6, { size: 10 });
  draw(`発行日: ${invoice.issue_date}`, width - 200, y - 8, { size: 10 });
  if (invoice.due_date) {
    draw(`支払期限: ${invoice.due_date}`, width - 200, y - 22, { size: 10 });
  }
  y -= 50;

  // 取引先 (請求先) — 「{社名} 御中」形式
  if (invoice.partner_name) {
    draw(`${invoice.partner_name}  御中`, 40, y, { size: 14, bold: true });
    // 社名直下に下線を引いて取引先を強調
    const nameWidth = invoice.partner_name.length * 14 + 60;
    page.drawLine({
      start: { x: 40, y: y - 3 },
      end: { x: 40 + Math.min(nameWidth, 280), y: y - 3 },
      thickness: 0.6,
      color: rgb(0.2, 0.2, 0.2),
    });
  } else {
    draw("(請求先未設定)", 40, y, { size: 12, color: [0.75, 0.2, 0.2] });
  }
  if (invoice.partner_address) {
    y -= 16;
    draw(invoice.partner_address, 40, y, { size: 9 });
  }
  y -= 28;

  // 発行者 (右側)
  {
    let iy = y + 60;
    draw("発行者", width - 220, iy, { size: 9, bold: true, color: [0.4, 0.4, 0.4] });
    iy -= 14;
    if (issuer?.business_name) {
      draw(issuer.business_name, width - 220, iy, { size: 12, bold: true });
      iy -= 12;
    } else {
      draw("(屋号未登録 — 発行者情報を登録してください)", width - 220, iy, {
        size: 9,
        color: [0.75, 0.2, 0.2],
      });
      iy -= 12;
    }
    if (issuer?.address) {
      draw(issuer.address, width - 220, iy, { size: 8 });
      iy -= 10;
    }
    if (issuer?.phone) {
      draw(`TEL ${issuer.phone}`, width - 220, iy, { size: 8 });
      iy -= 10;
    }
    if (issuer?.registered_number) {
      draw(`登録番号: ${issuer.registered_number}`, width - 220, iy, { size: 8 });
    }
  }

  // 件名
  if (invoice.subject) {
    draw(`件名: ${invoice.subject}`, 40, y, { size: 11 });
    y -= 20;
  }

  // 「下記の通り、ご請求申し上げます」案内文
  y -= 4;
  draw("下記の通り、ご請求申し上げます。", 40, y, { size: 10 });
  y -= 20;

  // 明細テーブル
  page.drawLine({
    start: { x: 40, y },
    end: { x: width - 40, y },
    thickness: 1,
    color: rgb(0, 0, 0),
  });
  y -= 14;
  draw("#", 42, y, { bold: true });
  draw("内容", 70, y, { bold: true });
  draw("数量", 320, y, { bold: true });
  draw("単位", 360, y, { bold: true });
  draw("単価", 410, y, { bold: true });
  draw("金額", 490, y, { bold: true });
  y -= 6;
  page.drawLine({
    start: { x: 40, y },
    end: { x: width - 40, y },
    thickness: 0.5,
    color: rgb(0.4, 0.4, 0.4),
  });
  y -= 14;

  let idx = 1;
  for (const item of items) {
    if (y < 140) break;
    draw(`${idx++}`, 42, y);
    draw(item.description.slice(0, 40), 70, y);
    draw(`${item.quantity}`, 320, y);
    draw(item.unit || "", 360, y);
    draw(`${item.unit_price.toLocaleString()}`, 410, y);
    draw(`${item.amount.toLocaleString()}`, 490, y);
    y -= 14;
  }

  // 税区分ごとの小計
  y -= 10;
  page.drawLine({
    start: { x: 40, y },
    end: { x: width - 40, y },
    thickness: 0.5,
    color: rgb(0.4, 0.4, 0.4),
  });
  y -= 14;

  const byTax = new Map<string, { subtotal: number; tax: number; rate: number }>();
  for (const item of items) {
    const code = item.tax_code || "OUT";
    const tc = TAX_CLASSES.find((t) => t.code === code);
    const rate = tc?.rate ?? 0;
    const existing = byTax.get(code) || { subtotal: 0, tax: 0, rate };
    existing.subtotal += item.amount;
    existing.tax += item.tax_amount;
    byTax.set(code, existing);
  }

  for (const [code, t] of byTax.entries()) {
    if (y < 100) break;
    const label = `${code} (${t.rate}%)`;
    draw(label, 340, y, { size: 9 });
    draw(`${t.subtotal.toLocaleString()}`, 410, y, { size: 9 });
    draw(`消費税: ${t.tax.toLocaleString()}`, 480, y, { size: 9 });
    y -= 12;
  }

  y -= 8;
  draw("小計", 380, y, { bold: true });
  draw(`${invoice.subtotal.toLocaleString()} 円`, 490, y);
  y -= 14;
  draw("消費税", 380, y, { bold: true });
  draw(`${invoice.tax_amount.toLocaleString()} 円`, 490, y);
  // Round 28: 源泉徴収税 — 0 の時は表示省略
  if ((invoice.withholding_tax ?? 0) > 0) {
    y -= 14;
    draw("源泉徴収", 380, y, { bold: true });
    draw(`- ${(invoice.withholding_tax ?? 0).toLocaleString()} 円`, 480, y);
  }
  y -= 18;
  // ご請求金額のハイライト枠
  page.drawRectangle({
    x: 370,
    y: y - 4,
    width: width - 40 - 370,
    height: 22,
    color: rgb(0.95, 0.95, 0.95),
  });
  draw("ご請求金額", 380, y, { size: 12, bold: true });
  draw(`${invoice.total_amount.toLocaleString()} 円`, 470, y, {
    size: 14,
    bold: true,
  });
  y -= 30;

  // 振込先ブロック (見やすい枠 + ラベル付き整列)
  y -= 16;
  {
    // 全体を薄い枠で囲む
    const boxTop = y + 14;
    const boxLeft = 40;
    const boxWidth = 320;
    // 中身の高さは bank_info の行数で動的決定
    const rawLines = issuer?.bank_info?.split("\n").map((l) => l.trim()).filter(Boolean) ?? [];
    const lineCount = Math.max(1, Math.min(rawLines.length, 6));
    const contentHeight = 22 + lineCount * 14;
    page.drawRectangle({
      x: boxLeft,
      y: boxTop - contentHeight,
      width: boxWidth,
      height: contentHeight,
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 0.5,
    });
    // ヘッダ帯
    page.drawRectangle({
      x: boxLeft,
      y: boxTop - 18,
      width: boxWidth,
      height: 18,
      color: rgb(0.93, 0.93, 0.93),
    });
    draw("お振込先", boxLeft + 8, boxTop - 13, { size: 11, bold: true });

    let by = boxTop - 30;
    if (rawLines.length > 0) {
      for (const line of rawLines.slice(0, 6)) {
        draw(line, boxLeft + 12, by, { size: 10 });
        by -= 14;
      }
    } else {
      draw("(未登録 — 「発行者情報」で銀行口座を登録してください)", boxLeft + 12, by, {
        size: 9,
        color: [0.75, 0.2, 0.2],
      });
      by -= 14;
    }
    y = boxTop - contentHeight - 8;
  }

  // 備考
  if (invoice.notes) {
    y -= 8;
    draw("備考", 40, y, { bold: true });
    y -= 14;
    for (const line of invoice.notes.split("\n").slice(0, 5)) {
      draw(line, 60, y, { size: 9 });
      y -= 12;
    }
  }

  return pdf.save();
}
