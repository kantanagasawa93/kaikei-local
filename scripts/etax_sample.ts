/**
 * e-Tax モジュールの動作確認スクリプト。
 * サンプルデータで XTX 3種類を出力し、/tmp/sample_*.xtx に書き出す。
 */

import * as fs from "node:fs";
import {
  buildShotokuShinkokuXtx,
  buildConsumptionTaxStandardXtx,
  type EtaxContext,
  type IncomeReturnData,
  type BlueReturnData,
  type ConsumptionTaxStandardData,
  validateTaxpayer,
  splitErrors,
} from "../src/lib/etax";

const ctx: EtaxContext = {
  fiscalYear: 2025,
  sakuseiDay: "2026-02-20",
  softName: "kaikei",
  vendorName: "Personal",
  taxpayer: {
    zeimusho_cd: "01101",
    zeimusho_nm: "麹町",
    name: "長澤 寛太",
    name_kana: "ナガサワ カンタ",
    birthday_wareki: { era: "昭和", yy: 60, mm: 1, dd: 1 },
    postal_code: "1000001",
    address: "東京都千代田区千代田1-1-1",
    phone: "090-1234-5678",
    yago: "長澤事務所",
    shokugyo: "ソフトウェアエンジニア",
    jigyo_naiyo: "Webシステム受託開発",
    riyosha_shikibetsu_bango: "1234567812345678",
  },
};

const errs = validateTaxpayer(ctx.taxpayer);
const { errors, warnings } = splitErrors(errs);
console.log(`Validation: ${errors.length} errors, ${warnings.length} warnings`);
if (errors.length) {
  console.log("Errors:", errors);
  process.exit(1);
}

const income: IncomeReturnData = {
  shinkoku_shurui: "青色",
  eigyo_income: 8000000,
  eigyo_shotoku: 5000000,
  goukei_shotoku: 5000000,
  shakaihoken_kojo: 400000,
  kiso_kojo: 480000,
  kojo_goukei: 880000,
  kazei_shotoku: 4120000,
  shotokuzei: 386500,
  fukkou_tokubetsu: 8116,
  shotokuzei_no_gaku: 394616,
  gensen_choshu: 50000,
  osameru_zeikin: 344600,
  aoiro_tokubetsu_kojo: 650000,
  // 第二表拡張サンプル
  income_details: [
    {
      kind: "給与",
      shumoku: "給料",
      payer_name: "副業先株式会社",
      income: 500000,
      withholding: 50000,
    },
  ],
  shakaihoken_meisai: [
    { kind: "国民健康保険", amount: 240000 },
    { kind: "国民年金", amount: 160000 },
  ],
  haigusha: {
    name: "長澤 花子",
    birthday: { era: "昭和", yy: 62, mm: 6, dd: 15 },
  },
  fuyo_shinzoku: [
    {
      name: "長澤 太郎",
      zokugara: "子",
      birthday: { era: "平成", yy: 25, mm: 4, dd: 1 },
    },
  ],
};
const blue: BlueReturnData = {
  jigyo_kikan_jiko_from: "2025-01-01",
  jigyo_kikan_itaru_to: "2025-12-31",
  uriage: 8000000,
  shiire: 500000,
  tsushin: 200000,
  suidokonetsu: 150000,
  ryohikotsu: 300000,
  shomohin: 100000,
  aoiro_tokubetsu_kojo: 650000,
  monthly: Array.from({ length: 12 }, () => ({ income: 666667, cost: 41667 })),
  depreciation: [
    {
      name: "MacBook Pro 14 M3",
      quantity: "1台",
      acquired: "2024-10",
      acquired_price: 320000,
      depreciation_base: 320000,
      method: "定額",
      useful_years: 4,
      rate: 0.25,
      months: 12,
      depreciation_year: 80000,
      business_use_ratio: 100,
      expense_amount: 80000,
      book_value_kimatsu: 160000,
    },
  ],
  bs: {
    kimatsu_date: "2025-12-31",
    genkin_kishu: 100000,
    genkin_kimatsu: 150000,
    sonota_yokin_kishu: 2500000,
    sonota_yokin_kimatsu: 3200000,
    urikake_kishu: 800000,
    urikake_kimatsu: 900000,
    kogu_kishu: 240000,
    kogu_kimatsu: 160000,
    shisan_goukei_kishu: 3640000,
    shisan_goukei_kimatsu: 4410000,
    motoire_kishu: 3640000,
    motoire_kimatsu: 3640000,
    aoiro_mae_shotoku_kimatsu: 770000,
    fusai_goukei_kishu: 3640000,
    fusai_goukei_kimatsu: 4410000,
  },
};

// 所得税申告 (RKO0010) = 申告書 + 青色決算書 を 1つのXTXに
const shotokuXtx = buildShotokuShinkokuXtx(ctx, { income, blue });
fs.writeFileSync(`/tmp/${shotokuXtx.suggestedFileName}`, shotokuXtx.xml);
console.log(`\n[1/2] ${shotokuXtx.suggestedFileName} (${shotokuXtx.xml.length} bytes)`);

const cons: ConsumptionTaxStandardData = {
  kazei_from: "2025-01-01",
  kazei_to: "2025-12-31",
  kazei_hyojun: 7272000,
  shohizei: 567216,
  kojo_zeigaku: 45454,
  sashihiki_zeigaku: 521762,
  nofu_zeigaku: 521700,
  chihou_kazei_hyojun: 521700,
  jouto_wari_gaku: 147100,
  nofu_jouto_wari: 147100,
  total_nofu: 668800,
};
const consXtx = buildConsumptionTaxStandardXtx(ctx, cons);
fs.writeFileSync(`/tmp/${consXtx.suggestedFileName}`, consXtx.xml);
console.log(`[2/2] ${consXtx.suggestedFileName} (${consXtx.xml.length} bytes)`);

console.log("\nDone.");
