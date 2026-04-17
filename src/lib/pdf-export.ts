/**
 * 確定申告・青色申告決算書の簡易PDF出力
 *
 * 注意: 国税庁の正式な OCR 用書類フォーマットを完全再現する訳ではなく、
 * 内容確認用の帳票を生成する。電子申告する場合は、ここで生成したPDFを
 * 参考に国税庁e-Taxサイトに自分で金額を入力する使い方を想定。
 */

import { PDFDocument, rgb } from "pdf-lib";
import type { TaxReturn, TaxReturnExpense } from "@/types";
import { embedJapaneseFonts } from "@/lib/pdf-fonts";

export async function exportTaxReturnPdf(
  taxReturn: TaxReturn,
  expenses: TaxReturnExpense[]
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const { regular: font, bold } = await embedJapaneseFonts(pdf);

  // ページ1: 確定申告書 概要
  const page1 = pdf.addPage([595, 842]); // A4
  const { width } = page1.getSize();

  let y = 800;
  const drawText = (text: string, x: number, opts: { size?: number; bold?: boolean } = {}) => {
    page1.drawText(text, {
      x,
      y,
      size: opts.size ?? 11,
      font: opts.bold ? bold : font,
      color: rgb(0, 0, 0),
    });
  };
  const hr = () => {
    page1.drawLine({
      start: { x: 40, y: y - 4 },
      end: { x: width - 40, y: y - 4 },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
  };

  drawText(`Kakutei Shinkoku ${taxReturn.year}`, 40, { size: 18, bold: true });
  y -= 24;
  drawText(`Return type: ${taxReturn.return_type === "blue" ? "Blue form (65k special deduction)" : "White form"}`, 40);
  y -= 16;
  drawText(`Status: ${taxReturn.status}`, 40);
  y -= 24;
  hr();
  y -= 20;

  // 収支
  drawText("1. Income summary", 40, { size: 13, bold: true });
  y -= 18;
  const rows1: [string, number][] = [
    ["Revenue total", taxReturn.revenue_total],
    ["Expense total", -taxReturn.expense_total],
    ["Income (net)", taxReturn.income_total],
    ["Blue special deduction", -taxReturn.blue_special_deduction],
  ];
  for (const [label, amount] of rows1) {
    drawText(label, 60);
    drawText(`${amount.toLocaleString()} JPY`, 380);
    y -= 16;
  }
  y -= 10;
  hr();
  y -= 20;

  // 所得控除
  drawText("2. Deductions", 40, { size: 13, bold: true });
  y -= 18;
  const rows2: [string, number][] = [
    ["Basic", taxReturn.basic_deduction],
    ["Social insurance", taxReturn.social_insurance_deduction],
    ["Life insurance", taxReturn.life_insurance_deduction],
    ["Earthquake insurance", taxReturn.earthquake_insurance_deduction],
    ["Spouse", taxReturn.spouse_deduction],
    ["Dependents", taxReturn.dependents_deduction],
    ["Medical", taxReturn.medical_deduction],
    ["Small business mutual aid", taxReturn.small_business_deduction],
  ];
  for (const [label, amount] of rows2) {
    drawText(label, 60);
    drawText(`${amount.toLocaleString()} JPY`, 380);
    y -= 16;
  }
  y -= 10;
  hr();
  y -= 20;

  // 税額
  drawText("3. Tax calculation", 40, { size: 13, bold: true });
  y -= 18;
  const rows3: [string, number][] = [
    ["Taxable income", taxReturn.taxable_income],
    ["Income tax", taxReturn.income_tax],
    ["Reconstruction surtax", taxReturn.reconstruction_tax],
    ["Withholding credit", -taxReturn.withholding_total],
    ["Tax due", taxReturn.tax_due],
  ];
  for (const [label, amount] of rows3) {
    drawText(label, 60, { bold: label === "Tax due" });
    drawText(`${amount.toLocaleString()} JPY`, 380, { bold: label === "Tax due" });
    y -= 16;
  }

  // ページ2: 経費内訳
  if (expenses.length > 0) {
    const page2 = pdf.addPage([595, 842]);
    let py = 800;
    page2.drawText("Expense breakdown", {
      x: 40,
      y: py,
      size: 16,
      font: bold,
      color: rgb(0, 0, 0),
    });
    py -= 24;
    page2.drawText("Code", { x: 40, y: py, size: 10, font: bold });
    page2.drawText("Account", { x: 120, y: py, size: 10, font: bold });
    page2.drawText("Amount", { x: 420, y: py, size: 10, font: bold });
    py -= 14;
    page2.drawLine({
      start: { x: 40, y: py + 2 },
      end: { x: width - 40, y: py + 2 },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
    py -= 6;

    for (const e of expenses.sort((a, b) => a.account_code.localeCompare(b.account_code))) {
      if (py < 60) break;
      page2.drawText(e.account_code, { x: 40, y: py, size: 10, font });
      page2.drawText(e.account_name, { x: 120, y: py, size: 10, font });
      page2.drawText(`${e.amount.toLocaleString()} JPY`, { x: 420, y: py, size: 10, font });
      py -= 14;
    }
  }

  return pdf.save();
}

export function downloadBlob(data: Uint8Array, filename: string) {
  const blob = new Blob([data as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
