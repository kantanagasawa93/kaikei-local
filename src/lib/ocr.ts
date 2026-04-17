import Tesseract from "tesseract.js";
import { suggestAccount } from "./accounts";
import type { OcrResult } from "@/types";

export async function processReceiptImage(imageSource: string | File): Promise<OcrResult> {
  let text: string;
  try {
    const result = await Tesseract.recognize(imageSource, "jpn+eng", {});
    text = result.data.text;
  } catch (err) {
    console.error("Tesseract OCR failed:", err);
    return {
      raw_text: "",
      vendor_name: null,
      amount: null,
      date: null,
      suggested_account_code: null,
      suggested_account_name: null,
    };
  }

  if (!text.trim()) {
    return {
      raw_text: "",
      vendor_name: null,
      amount: null,
      date: null,
      suggested_account_code: null,
      suggested_account_name: null,
    };
  }

  const amount = extractAmount(text);
  const date = extractDate(text);
  const vendorName = extractVendorName(text);
  const suggestion = suggestAccount(text);

  return {
    raw_text: text,
    vendor_name: vendorName,
    amount,
    date,
    suggested_account_code: suggestion?.code ?? null,
    suggested_account_name: suggestion?.name ?? null,
  };
}

function extractAmount(text: string): number | null {
  // ¥マーク or 円 の後の数字を検索
  const patterns = [
    /[¥￥]\s*([\d,]+)/g,
    /([\d,]+)\s*円/g,
    /合計\s*[¥￥]?\s*([\d,]+)/g,
    /合計金額\s*[¥￥]?\s*([\d,]+)/g,
    /お支払い?\s*[¥￥]?\s*([\d,]+)/g,
    /小計\s*[¥￥]?\s*([\d,]+)/g,
  ];

  let maxAmount = 0;
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const num = parseInt(match[1].replace(/,/g, ""), 10);
      if (!isNaN(num) && num > maxAmount) {
        maxAmount = num;
      }
    }
  }

  return maxAmount > 0 ? maxAmount : null;
}

function extractDate(text: string): string | null {
  // 2024年1月1日, 2024/01/01, 2024-01-01 etc.
  const patterns = [
    /(\d{4})\s*[年/\-\.]\s*(\d{1,2})\s*[月/\-\.]\s*(\d{1,2})\s*日?/,
    /(令和\s*\d+)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
    /R(\d+)[\.\/](\d{1,2})[\.\/](\d{1,2})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let year: number;
      if (match[1].includes("令和")) {
        year = 2018 + parseInt(match[1].replace(/令和\s*/, ""), 10);
      } else if (pattern.source.startsWith("R")) {
        year = 2018 + parseInt(match[1], 10);
      } else {
        year = parseInt(match[1], 10);
      }
      const month = match[2].padStart(2, "0");
      const day = match[3].padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
  }

  return null;
}

function extractVendorName(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  // 最初の数行に店名が含まれることが多い
  if (lines.length > 0) {
    // 数字だけの行は除外して最初の行を返す
    for (const line of lines.slice(0, 5)) {
      if (!/^\d+$/.test(line) && line.length > 1 && line.length < 50) {
        return line;
      }
    }
  }
  return null;
}
