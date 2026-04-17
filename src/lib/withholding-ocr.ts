import Tesseract from "tesseract.js";

export interface WithholdingOcrResult {
  raw_text: string;
  payer_name: string | null;
  payment_amount: number | null;
  withholding_tax: number | null;
  social_insurance: number | null;
}

export async function processWithholdingSlip(imageSource: string | File): Promise<WithholdingOcrResult> {
  const result = await Tesseract.recognize(imageSource, "jpn+eng", {});
  const text = result.data.text;

  return {
    raw_text: text,
    payer_name: extractPayerName(text),
    payment_amount: extractLabeledAmount(text, ["支払金額", "給与・賞与", "支払い金額"]),
    withholding_tax: extractLabeledAmount(text, ["源泉徴収税額", "源泉徴収", "税額"]),
    social_insurance: extractLabeledAmount(text, ["社会保険料", "社会保険料等の金額"]),
  };
}

function extractLabeledAmount(text: string, labels: string[]): number | null {
  for (const label of labels) {
    // ラベルの後に続く金額を取得
    const regex = new RegExp(label + "[\\s:：]*[¥￥]?([\\d,]+)", "i");
    const match = text.match(regex);
    if (match) {
      const amount = parseInt(match[1].replace(/,/g, ""), 10);
      if (!isNaN(amount) && amount > 0) return amount;
    }
  }

  // ラベルが見つからない場合、テキスト全体から大きな金額を探す
  return null;
}

function extractPayerName(text: string): string | null {
  // 「支払者」の後の行を取得
  const patterns = [
    /支払者[のの\s]*(?:名称|氏名)[：:\s]*(.*)/,
    /支払者\s*[\n\r]+(.*)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1].trim()) {
      return match[1].trim().slice(0, 50);
    }
  }

  return null;
}
