/**
 * e-Tax 送信前バリデーション。
 *
 * ここでは IT 部 (納税者情報) の必須項目・形式チェックを行う。
 * 各帳票モジュール (koa020 等) は、独自のチェックを追加する。
 */

import type { TaxpayerInfo, ValidationError } from "./types";

/**
 * 文字列が空かどうか (trim 後)
 */
function isEmpty(s: string | undefined | null): boolean {
  return !s || s.trim() === "";
}

/**
 * 半角数字・ハイフンのみで構成されているか
 */
function isDigitsHyphen(s: string): boolean {
  return /^[\d-]+$/.test(s);
}

/**
 * 納税者情報の必須項目チェック。
 * 不足があれば ValidationError[] を返す。空配列なら OK。
 */
export function validateTaxpayer(t: TaxpayerInfo | null | undefined): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!t) {
    errors.push({
      field: "taxpayer",
      message: "納税者情報が未登録です。設定ページから登録してください。",
      severity: "error",
    });
    return errors;
  }

  if (isEmpty(t.name)) {
    errors.push({ field: "taxpayer.name", message: "氏名は必須です。", severity: "error" });
  }
  if (isEmpty(t.name_kana)) {
    errors.push({
      field: "taxpayer.name_kana",
      message: "氏名フリガナは必須です。",
      severity: "error",
    });
  }
  if (isEmpty(t.postal_code)) {
    errors.push({
      field: "taxpayer.postal_code",
      message: "郵便番号は必須です。",
      severity: "error",
    });
  } else {
    const digits = t.postal_code.replace(/\D/g, "");
    if (digits.length !== 7) {
      errors.push({
        field: "taxpayer.postal_code",
        message: "郵便番号は7桁の数字で入力してください。",
        severity: "error",
      });
    }
  }
  if (isEmpty(t.address)) {
    errors.push({
      field: "taxpayer.address",
      message: "住所は必須です。",
      severity: "error",
    });
  }
  if (isEmpty(t.phone)) {
    errors.push({
      field: "taxpayer.phone",
      message: "電話番号は必須です。",
      severity: "error",
    });
  }
  if (isEmpty(t.zeimusho_cd)) {
    errors.push({
      field: "taxpayer.zeimusho_cd",
      message: "税務署コードは必須です。",
      severity: "error",
    });
  } else if (t.zeimusho_cd.length !== 5 || !/^\d+$/.test(t.zeimusho_cd)) {
    errors.push({
      field: "taxpayer.zeimusho_cd",
      message: "税務署コードは5桁の数字で入力してください。",
      severity: "error",
    });
  }
  if (isEmpty(t.zeimusho_nm)) {
    errors.push({
      field: "taxpayer.zeimusho_nm",
      message: "税務署名は必須です。",
      severity: "error",
    });
  }

  // 生年月日
  if (!t.birthday_wareki) {
    errors.push({
      field: "taxpayer.birthday_wareki",
      message: "生年月日は必須です。",
      severity: "error",
    });
  } else {
    const { yy, mm, dd } = t.birthday_wareki;
    if (!yy || yy < 1 || yy > 99) {
      errors.push({
        field: "taxpayer.birthday_wareki.yy",
        message: "生年月日の年が不正です。",
        severity: "error",
      });
    }
    if (!mm || mm < 1 || mm > 12) {
      errors.push({
        field: "taxpayer.birthday_wareki.mm",
        message: "生年月日の月が不正です。",
        severity: "error",
      });
    }
    if (!dd || dd < 1 || dd > 31) {
      errors.push({
        field: "taxpayer.birthday_wareki.dd",
        message: "生年月日の日が不正です。",
        severity: "error",
      });
    }
  }

  // 利用者識別番号
  if (isEmpty(t.riyosha_shikibetsu_bango)) {
    errors.push({
      field: "taxpayer.riyosha_shikibetsu_bango",
      message:
        "利用者識別番号は必須です。e-Tax 利用登録時に発行された16桁の番号を入力してください。",
      severity: "error",
    });
  } else {
    const digits = t.riyosha_shikibetsu_bango.replace(/\D/g, "");
    if (digits.length !== 16) {
      errors.push({
        field: "taxpayer.riyosha_shikibetsu_bango",
        message: "利用者識別番号は16桁の数字です。",
        severity: "error",
      });
    }
  }

  // Warning: 事業所情報が空ならヒント
  if (isEmpty(t.yago) && isEmpty(t.jigyosho_nm)) {
    errors.push({
      field: "taxpayer.yago",
      message:
        "屋号・事業所名が未登録です。事業をされている場合は登録を推奨します。",
      severity: "warning",
    });
  }

  return errors;
}

/**
 * ValidationError[] を「エラーのみ」「警告のみ」に分ける。
 */
export function splitErrors(errors: ValidationError[]) {
  return {
    errors: errors.filter((e) => e.severity === "error"),
    warnings: errors.filter((e) => e.severity === "warning"),
  };
}

/**
 * フィールド名 → エラー/警告メッセージ のマップに変換。
 * フォームの各 Input 近傍に「このフィールドの問題」だけ表示したい時に使う。
 */
export function toFieldMap(errors: ValidationError[]): Record<string, ValidationError[]> {
  const m: Record<string, ValidationError[]> = {};
  for (const e of errors) {
    if (!m[e.field]) m[e.field] = [];
    m[e.field].push(e);
  }
  return m;
}

/**
 * 郵便番号の数字を7桁にゼロ埋め/切り詰めせず、単純に数字のみ取り出す。
 */
export function normalizePostal(s: string): string {
  return s.replace(/\D/g, "").slice(0, 7);
}

/**
 * 電話番号を半角数字 + ハイフンのみに正規化。
 */
export function normalizePhone(s: string): string {
  return s
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/[^\d-]/g, "");
}

/**
 * 利用者識別番号を数字のみ16桁に正規化。
 */
export function normalizeRiyoshaId(s: string): string {
  return s.replace(/\D/g, "").slice(0, 16);
}
