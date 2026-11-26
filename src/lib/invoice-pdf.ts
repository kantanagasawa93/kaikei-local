/**
 * 請求書・領収書の簡易PDF出力。
 * doc_type = 'receipt' の場合はタイトル・文言を領収書様式に切り替える
 * (領収金額の強調枠 + 但し書き + 「正に領収いたしました」+ 印紙不要の注記。
 *  振込先ブロックは出さない)。税率ごとの内訳は共通で出すので、
 * どちらの様式でも適格請求書の記載要件を満たす。
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
import { TAX_CLASSES, calculateTax, extractTaxFromIncluded } from "@/lib/tax-classes";
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
  const pickFont = (text: string, bold: boolean) => {
    const useJp = containsNonAscii(text);
    if (bold) return useJp ? jpBold : asciiBold;
    return useJp ? jpFont : asciiRegular;
  };
  const draw = (text: string, x: number, y: number, opts: { size?: number; bold?: boolean; color?: [number, number, number] } = {}) => {
    const font = pickFont(text, !!opts.bold);
    page.drawText(text, {
      x,
      y,
      size: opts.size ?? 10,
      font,
      color: rgb(...(opts.color ?? [0, 0, 0])),
    });
  };
  // 右側 x = rightX に揃えて描く (数字カラムの整列に使う).
  const drawRight = (text: string, rightX: number, y: number, opts: { size?: number; bold?: boolean; color?: [number, number, number] } = {}) => {
    const size = opts.size ?? 10;
    const font = pickFont(text, !!opts.bold);
    const w = font.widthOfTextAtSize(text, size);
    draw(text, rightX - w, y, opts);
  };
  // 日本語混じりの文字列を「だいたい n 文字」で折り返す (簡易).
  // Japanese は ~1em / ASCII は ~0.5em として、行ごとに収まる文字数を概算する。
  const wrapJp = (text: string, maxWidthPt: number, size = 10): string[] => {
    const lines: string[] = [];
    let cur = "";
    let curW = 0;
    for (const ch of text) {
      const w = /[\x00-\x7F]/.test(ch) ? size * 0.55 : size * 1.0;
      if (curW + w > maxWidthPt && cur.length > 0) {
        lines.push(cur);
        cur = ch;
        curW = w;
      } else {
        cur += ch;
        curW += w;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };

  const isReceipt = invoice.doc_type === "receipt";
  const docLabel = isReceipt ? "領収書" : "請求書";
  // Round 32: 税込入力 (内税) と源泉徴収の別記 (満額請求) に対応
  const isInclusive = !!invoice.tax_inclusive;
  const whNoteOnly = invoice.withholding_mode === "note";
  const wh = invoice.withholding_tax ?? 0;

  let y = height - 50;
  // ─── 1段目: タイトル「請求書/領収書」 (左) + 番号 / 発行日 / 支払期限 (右上 3 行) ───
  draw(docLabel, 40, y, { size: 24, bold: true });
  {
    const rx = 380;
    let ry = y + 2;
    draw(`${docLabel}番号: ${invoice.invoice_number}`, rx, ry, { size: 10 });
    ry -= 14;
    draw(`発行日: ${invoice.issue_date}`, rx, ry, { size: 10 });
    // 領収書に支払期限は無い
    if (invoice.due_date && !isReceipt) {
      ry -= 14;
      draw(`支払期限: ${invoice.due_date}`, rx, ry, { size: 10 });
    }
  }
  // 右上ブロックの最下端より十分下 (= 56pt 下) に次行を置いて重なり防止
  y -= 70;

  // ─── 2段目: 取引先 (左) + 発行者 (右) を並列に ───
  const headerY = y;
  // 取引先 (請求先) — 「{社名} 御中」形式
  if (invoice.partner_name) {
    draw(`${invoice.partner_name}  御中`, 40, headerY, { size: 14, bold: true });
    const nameWidth = invoice.partner_name.length * 14 + 60;
    page.drawLine({
      start: { x: 40, y: headerY - 3 },
      end: { x: 40 + Math.min(nameWidth, 280), y: headerY - 3 },
      thickness: 0.6,
      color: rgb(0.2, 0.2, 0.2),
    });
  } else {
    draw("(請求先未設定)", 40, headerY, { size: 12, color: [0.75, 0.2, 0.2] });
  }
  if (invoice.partner_address) {
    draw(invoice.partner_address, 40, headerY - 18, { size: 9 });
  }

  // 発行者 (右) — 取引先と同じ headerY から下に積む
  {
    const rx = 360;
    let ry = headerY;
    draw("発行者", rx, ry, { size: 9, bold: true, color: [0.4, 0.4, 0.4] });
    ry -= 14;
    if (issuer?.business_name) {
      draw(issuer.business_name, rx, ry, { size: 12, bold: true });
      ry -= 12;
    } else {
      draw("(屋号未登録 — 発行者情報を登録してください)", rx, ry, {
        size: 9,
        color: [0.75, 0.2, 0.2],
      });
      ry -= 12;
    }
    if (issuer?.address) {
      draw(issuer.address, rx, ry, { size: 8 });
      ry -= 10;
    }
    if (issuer?.phone) {
      draw(`TEL ${issuer.phone}`, rx, ry, { size: 8 });
      ry -= 10;
    }
    if (issuer?.registered_number) {
      draw(`登録番号: ${issuer.registered_number}`, rx, ry, { size: 8 });
    }
  }
  // 2段目ブロックの高さを確保 (発行者ブロックの方が高いので、それに合わせて余白)
  y = headerY - 70;

  if (isReceipt) {
    // ─── 領収書: 領収金額の強調枠 + 但し書き + 領収文言 ───
    const boxLeft = 40;
    const boxWidth = 320;
    const boxHeight = 34;
    page.drawRectangle({
      x: boxLeft,
      y: y - boxHeight + 12,
      width: boxWidth,
      height: boxHeight,
      color: rgb(0.95, 0.95, 0.95),
      borderColor: rgb(0.3, 0.3, 0.3),
      borderWidth: 0.8,
    });
    draw("領収金額", boxLeft + 10, y - 10, { size: 11, bold: true });
    drawRight(
      `¥${invoice.total_amount.toLocaleString()} -`,
      boxLeft + boxWidth - 12,
      y - 12,
      { size: 16, bold: true },
    );
    draw("(税込)", boxLeft + boxWidth + 8, y - 10, { size: 9, color: [0.4, 0.4, 0.4] });
    y -= boxHeight + 8;
    // 但し書き (subject を流用。未入力なら「お品代」)
    draw(`但し ${invoice.subject || "お品代"} として`, 40, y, { size: 10 });
    y -= 16;
    draw("上記の金額、正に領収いたしました。", 40, y, { size: 10 });
    y -= 20;
  } else {
    // 件名
    if (invoice.subject) {
      draw(`件名: ${invoice.subject}`, 40, y, { size: 11 });
      y -= 20;
    }

    // 「下記の通り、ご請求申し上げます」案内文
    y -= 4;
    draw("下記の通り、ご請求申し上げます。", 40, y, { size: 10 });
    y -= 20;
  }

  // 明細テーブル — カラムの x 位置 (右端ベース)
  //   # | 内容 | 数量 | 単位 | 単価 | 金額
  // 内容カラムは Description が長くて Japanese 含み 25-40 字あるので幅広めに確保。
  // 数値カラム (数量 / 単価 / 金額) はすべて右揃え (drawRight) で 1の位を縦に揃える。
  const colNoX = 42;            // # (左揃え)
  const colDescX = 64;          // 内容 (左揃え)
  const colDescMaxW = 230;      // 内容の許容幅 (これを超えたら折り返し)
  const colQtyRight = 320;      // 数量 (右揃え)
  const colUnitX = 332;         // 単位 (左揃え、数量の右)
  const colPriceRight = 450;    // 単価 (右揃え)
  const colAmountRight = width - 44; // 金額 (右揃え、右マージン)

  page.drawLine({
    start: { x: 40, y },
    end: { x: width - 40, y },
    thickness: 1,
    color: rgb(0, 0, 0),
  });
  y -= 14;
  draw("#", colNoX, y, { bold: true });
  draw("内容", colDescX, y, { bold: true });
  drawRight("数量", colQtyRight, y, { bold: true });
  draw("単位", colUnitX, y, { bold: true });
  drawRight("単価", colPriceRight, y, { bold: true });
  drawRight("金額", colAmountRight, y, { bold: true });
  y -= 6;
  page.drawLine({
    start: { x: 40, y },
    end: { x: width - 40, y },
    thickness: 0.5,
    color: rgb(0.4, 0.4, 0.4),
  });
  y -= 14;

  // 明細行 — 内容が長い場合は折り返し、行高さを伸ばす
  let idx = 1;
  for (const item of items) {
    if (y < 160) break;
    const descLines = wrapJp(item.description, colDescMaxW, 10);
    const rowHeight = Math.max(14, descLines.length * 12 + 2);
    // 1 行目に index / 数量 / 単位 / 単価 / 金額 を描く
    draw(`${idx++}`, colNoX, y);
    // 内容は複数行に展開 (左揃え)
    for (let li = 0; li < descLines.length; li++) {
      draw(descLines[li], colDescX, y - li * 12);
    }
    drawRight(`${item.quantity}`, colQtyRight, y);
    draw(item.unit || "", colUnitX, y);
    drawRight(`¥${item.unit_price.toLocaleString()}`, colPriceRight, y);
    drawRight(`¥${item.amount.toLocaleString()}`, colAmountRight, y);
    y -= rowHeight;
  }

  // 税区分ごとの小計
  y -= 6;
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
  // 税額は税区分ごとの合計から 1 回だけ端数処理する (適格請求書の要件)。
  // 行ごとに切り捨てた item.tax_amount の合算だと数円ずれる。
  if (isInclusive) {
    for (const [code, t] of byTax.entries()) {
      t.tax = extractTaxFromIncluded(t.subtotal, code);
    }
  } else {
    // 外税: 以前は行ごとの税額を足していた。その方式で保存済みの文書は、
    // 表の税額と合計欄 (invoice.tax_amount) が食い違わないよう元の数字のまま出す。
    let perRateTotal = 0;
    for (const [code, t] of byTax.entries()) perRateTotal += calculateTax(t.subtotal, code);
    if (perRateTotal === invoice.tax_amount) {
      for (const [code, t] of byTax.entries()) t.tax = calculateTax(t.subtotal, code);
    }
  }

  for (const [code, t] of byTax.entries()) {
    if (y < 120) break;
    // インボイス制度の標準表記に変換:
    //   S10  → "10%対象"
    //   S08R → "8%対象（軽減税率）"
    //   S08  → "8%対象"
    //   EXP  → "輸出免税"
    //   それ以外 (NT / EXM / OUT 等) は tax_classes の name (非課税 / 対象外 など)
    const tc = TAX_CLASSES.find((c) => c.code === code);
    let label: string;
    if (tc?.kind === "taxable_sales") {
      label = `${t.rate}%対象${tc.reduced ? "(軽減税率)" : ""}`;
    } else if (tc?.kind === "export") {
      label = "輸出免税";
    } else if (tc) {
      label = tc.name;
    } else {
      label = `${code} (${t.rate}%)`;
    }
    draw(label, 340, y, { size: 9 });
    drawRight(
      `${isInclusive ? "税込 " : ""}${t.subtotal.toLocaleString()} 円`,
      colAmountRight - 80,
      y,
      { size: 9 },
    );
    drawRight(
      `${isInclusive ? "内消費税" : "消費税"}: ${t.tax.toLocaleString()} 円`,
      colAmountRight,
      y,
      { size: 9 },
    );
    y -= 12;
  }

  // 合計ブロック — ラベル右揃え + 金額右揃え (1の位がきっちり揃う)
  const totalLabelRight = 440;   // ラベル列の右端
  const totalAmountRight = colAmountRight; // 金額列の右端 (明細表と同じ)
  y -= 8;
  drawRight(isInclusive ? "合計 (税込)" : "小計", totalLabelRight, y, { bold: true });
  drawRight(`¥${invoice.subtotal.toLocaleString()}`, totalAmountRight, y);
  y -= 14;
  drawRight(isInclusive ? "(うち消費税)" : "消費税", totalLabelRight, y, { bold: true });
  drawRight(`¥${invoice.tax_amount.toLocaleString()}`, totalAmountRight, y);
  // Round 28: 源泉徴収税 — 0 の時は表示省略。別記モードは合計に含めず後段で注記
  if (wh > 0 && !whNoteOnly) {
    y -= 14;
    drawRight("源泉徴収", totalLabelRight, y, { bold: true, color: [0.6, 0.1, 0.1] });
    drawRight(`-¥${wh.toLocaleString()}`, totalAmountRight, y, {
      color: [0.6, 0.1, 0.1],
    });
  }
  y -= 22;
  // ご請求金額のハイライト枠 (右に寄せて整列)
  const totalBoxLeft = 320;
  const totalBoxRight = colAmountRight + 4;
  page.drawRectangle({
    x: totalBoxLeft,
    y: y - 6,
    width: totalBoxRight - totalBoxLeft,
    height: 26,
    color: rgb(0.95, 0.95, 0.95),
  });
  drawRight(isReceipt ? "領収金額" : "ご請求金額", totalLabelRight, y + 3, { size: 12, bold: true });
  drawRight(`¥${invoice.total_amount.toLocaleString()}`, totalAmountRight, y + 1, {
    size: 15,
    bold: true,
  });
  y -= 34;

  // 源泉徴収の別記 (満額請求): 金額欄には含めず参考情報として注記
  if (wh > 0 && whNoteOnly) {
    drawRight(
      `（参考）源泉徴収税額 ¥${wh.toLocaleString()} ／ 差引お振込額 ¥${(invoice.total_amount - wh).toLocaleString()}`,
      totalBoxRight,
      y + 20,
      { size: 9, color: [0.35, 0.35, 0.35] },
    );
    y -= 6;
  }

  // 振込先ブロック (見やすい枠 + ラベル付き整列) — 領収書には不要
  y -= 16;
  if (isReceipt) {
    // 電子交付の領収書は印紙税の課税文書に当たらない旨を注記
    draw("※ 本領収書は電子交付のため、収入印紙は貼付しておりません。", 40, y, {
      size: 8,
      color: [0.4, 0.4, 0.4],
    });
    y -= 14;
  } else {
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
