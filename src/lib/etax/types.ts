/**
 * e-Tax XTX 生成で共通に使う型定義。
 *
 * 設計方針:
 *   - ユーザー側でも入力しやすい「日本語ドメイン」の型を定義する。
 *   - XTX 固有のタグ (AAA00010 等) へのマッピングは各帳票モジュール (koa020 等) で行う。
 *   - 令和7年分 (2025年分) を前提。元号はコード側で付与するためここでは暦年で持つ。
 */

// ──────────────────────────────────────────────────────────
// 共通
// ──────────────────────────────────────────────────────────

/**
 * 元号表記。e-Tax は「令和」「平成」「昭和」「大正」「明治」を受け付ける。
 */
export type EraName = "令和" | "平成" | "昭和" | "大正" | "明治";

/**
 * 和暦日付 (e-Tax 内部形式用)
 *   era: 令和 / yy: 7 / mm: 8 / dd: 15
 */
export interface WarekiDate {
  era: EraName;
  yy: number; // 1〜99
  mm: number; // 1〜12
  dd: number; // 1〜31
}

/**
 * 西暦 YYYY-MM-DD 形式。sakuseiDay など属性用。
 */
export type IsoDate = string;

/**
 * 電話番号 (ハイフン有無は帳票ごとに異なるため、原則としてハイフンなしで保持)
 */
export type PhoneNumber = string;

/**
 * 郵便番号 ハイフンなし 7桁
 */
export type PostalCode = string;

// ──────────────────────────────────────────────────────────
// 納税者情報 (IT 部に展開する元データ)
// ──────────────────────────────────────────────────────────

/**
 * 個人事業主の申告者情報。設定ページで保持する。
 *
 * e-Tax の IT 部要素 (ZEIMUSHO / NOZEISHA_* / JIGYOSHO_*) に対応。
 */
export interface TaxpayerInfo {
  // 税務署
  zeimusho_cd: string; // 5桁税務署コード (例: "01101")
  zeimusho_nm: string; // 税務署名 (例: "麹町")

  // 申告者 (本人)
  name: string; // 氏名 (例: "長澤 寛太")
  name_kana: string; // フリガナ (例: "ナガサワ カンタ")
  birthday_wareki: WarekiDate; // 生年月日 (和暦)

  // 住所
  postal_code: PostalCode; // 郵便番号 ハイフンなし 7桁
  address: string; // 住所 (例: "東京都千代田区麹町1-1-1")
  address_kana?: string; // 住所カナ (オプション)
  phone: PhoneNumber; // 電話番号

  // 事業
  yago?: string; // 屋号
  jigyosho_nm?: string; // 事業所名称
  jigyosho_postal?: PostalCode; // 事業所郵便番号
  jigyosho_address?: string; // 事業所住所
  jigyosho_phone?: PhoneNumber; // 事業所電話番号
  shokugyo?: string; // 職業 (例: "個人事業主", "ソフトウェアエンジニア")
  jigyo_naiyo?: string; // 事業内容 (例: "Webシステム受託開発")

  // 利用者識別番号 (16桁)
  riyosha_shikibetsu_bango: string;
}

// ──────────────────────────────────────────────────────────
// 帳票共通属性
// ──────────────────────────────────────────────────────────

/**
 * 帳票個別部分のルート要素につける必須属性。
 * 「データ形式等仕様書」図1-8 参照。
 */
export interface FormAttribute {
  VR: string; // バージョン (例: "23.0")
  id: string; // ID (例: "KOA020")
  page?: number; // 次葉番号
  sakuseiDay: IsoDate; // 作成日 CCYY-MM-DD
  sakuseiNM: string; // 作成者 (ソフト名△会社名 形式) ※半角スペース
  softNM: string; // ソフト名△会社名
}

/**
 * 申告書生成時の共通コンテキスト。
 */
export interface EtaxContext {
  /** 暦年 (例: 2025 = 令和7年分) */
  fiscalYear: number;
  /** 納税者情報 */
  taxpayer: TaxpayerInfo;
  /** 作成日 (ISO) */
  sakuseiDay: IsoDate;
  /** ソフト名 (例: "kaikei"). 社名と半角スペースで結合する。 */
  softName: string;
  /** 会社名 (例: "Personal"). ない場合は "Personal" など。 */
  vendorName: string;
}

// ──────────────────────────────────────────────────────────
// 生成結果
// ──────────────────────────────────────────────────────────

/**
 * 1 帳票分の XTX 生成結果。
 */
export interface XtxDocument {
  /** 帳票コード (例: "KOA020", "KOA210", "RSH0010") */
  procedureCode: string;
  /** バージョン (例: "23.0") */
  version: string;
  /** 推奨ファイル名 (例: "KOA020_令和7年分_20260220.xtx") */
  suggestedFileName: string;
  /** XTX 本体 (UTF-8 文字列) */
  xml: string;
}

// ──────────────────────────────────────────────────────────
// バリデーションエラー
// ──────────────────────────────────────────────────────────

export interface ValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export class EtaxValidationError extends Error {
  constructor(public errors: ValidationError[]) {
    super(
      `e-Tax バリデーションエラー: ${errors
        .filter((e) => e.severity === "error")
        .map((e) => `${e.field}: ${e.message}`)
        .join(" / ")}`
    );
  }
}
