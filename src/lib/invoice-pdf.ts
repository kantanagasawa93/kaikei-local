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
import { embedJapaneseFonts } from "@/lib/pdf-fonts";

export async function exportInvoicePdf(
  invoice: Invoice,
  items: InvoiceItem[],
  issuer: IssuerSettings | null
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { regular: font, bold } = await embedJapaneseFonts(pdf);
  const page = pdf.addPage([595, 842]); // A4
  const { width, height } = page.getSize();

  const draw = (text: string, x: number, y: number, opts: { size?: number; bold?: boolean; color?: [number, number, number] } = {}) => {
    page.drawText(text, {
      x,
      y,
      size: opts.size ?? 10,
      font: opts.bold ? bold : font,
      color: rgb(...(opts.color ?? [0, 0, 0])),
    });
  };

  // 注意: 日本語フォントを埋め込んでいないため、pdf-lib の標準フォントでは
  // 日本語文字を描画できません。日本語文字列はASCIIにそのまま落ちるので
  // "?" などが並びます。実運用前に Noto Sans JP を embedFont で追加してください。
  // ここでは配置・構成の検証用の簡易版。

  let y = height - 50;
  draw("INVOICE", 40, y, { size: 22, bold: true });
  draw(`No. ${invoice.invoice_number}`, width - 180, y, { size: 11 });
  y -= 30;
  draw(`Issue: ${invoice.issue_date}`, width - 180, y);
  y -= 14;
  if (invoice.due_date) {
    draw(`Due: ${invoice.due_date}`, width - 180, y);
  }
  y -= 24;

  // 取引先
  draw("Bill to:", 40, y, { bold: true });
  y -= 14;
  draw(invoice.partner_name, 40, y, { size: 12, bold: true });
  if (invoice.partner_address) {
    y -= 12;
    draw(invoice.partner_address, 40, y, { size: 9 });
  }
  y -= 24;

  // 発行者
  if (issuer) {
    draw("From:", width - 220, y + 50, { bold: true });
    let iy = y + 36;
    if (issuer.business_name) {
      draw(issuer.business_name, width - 220, iy, { size: 11, bold: true });
      iy -= 11;
    }
    if (issuer.address) {
      draw(issuer.address, width - 220, iy, { size: 8 });
      iy -= 10;
    }
    if (issuer.phone) {
      draw(`TEL ${issuer.phone}`, width - 220, iy, { size: 8 });
      iy -= 10;
    }
    if (issuer.registered_number) {
      draw(`Registered #: ${issuer.registered_number}`, width - 220, iy, { size: 8 });
    }
  }

  // 件名
  if (invoice.subject) {
    draw(`Subject: ${invoice.subject}`, 40, y, { size: 11 });
    y -= 20;
  }

  // 明細テーブル
  y -= 10;
  page.drawLine({
    start: { x: 40, y },
    end: { x: width - 40, y },
    thickness: 1,
    color: rgb(0, 0, 0),
  });
  y -= 14;
  draw("#", 42, y, { bold: true });
  draw("Description", 70, y, { bold: true });
  draw("Qty", 320, y, { bold: true });
  draw("Unit", 360, y, { bold: true });
  draw("Price", 410, y, { bold: true });
  draw("Amount", 490, y, { bold: true });
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
    if (y < 120) break;
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
    if (y < 80) break;
    const label = `${code} (${t.rate}%)`;
    draw(label, 340, y, { size: 9 });
    draw(`${t.subtotal.toLocaleString()}`, 410, y, { size: 9 });
    draw(`tax: ${t.tax.toLocaleString()}`, 490, y, { size: 9 });
    y -= 12;
  }

  y -= 8;
  draw("Subtotal", 380, y, { bold: true });
  draw(`${invoice.subtotal.toLocaleString()} JPY`, 490, y);
  y -= 14;
  draw("Tax", 380, y, { bold: true });
  draw(`${invoice.tax_amount.toLocaleString()} JPY`, 490, y);
  y -= 14;
  draw("TOTAL", 380, y, { size: 13, bold: true });
  draw(`${invoice.total_amount.toLocaleString()} JPY`, 480, y, { size: 13, bold: true });

  // 振込先
  if (issuer?.bank_info) {
    y -= 40;
    draw("Bank info:", 40, y, { bold: true });
    y -= 12;
    for (const line of issuer.bank_info.split("\n").slice(0, 5)) {
      draw(line, 60, y, { size: 9 });
      y -= 10;
    }
  }

  // 備考
  if (invoice.notes) {
    y -= 16;
    draw("Notes:", 40, y, { bold: true });
    y -= 12;
    for (const line of invoice.notes.split("\n").slice(0, 5)) {
      draw(line, 60, y, { size: 9 });
      y -= 10;
    }
  }

  return pdf.save();
}
