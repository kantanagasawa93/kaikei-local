import { buildShotokuShinkokuXtx } from "../src/lib/etax/rko0010.ts";
import { buildConsumptionTaxStandardXtx } from "../src/lib/etax/rsh0010.ts";
import fs from "node:fs";
import path from "node:path";

const ctx = {
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
    postal_code: "100-0001",
    address: "東京都千代田区千代田1-1-1",
    phone: "090-1234-5678",
    yago: "長澤事務所",
    shokugyo: "ソフトウェアエンジニア",
    jigyo_naiyo: "Webシステム受託開発",
    riyosha_shikibetsu_bango: "1234567890123456",
  },
};

const income = {
  shinkoku_shurui: "青色",
  shinkoku_kbn_cd: "1",
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
  income_details: [{ kind: "給与", shumoku: "給料", payer_name: "副業先株式会社", income: 500000, withholding: 50000 }],
  shakaihoken_meisai: [
    { kind: "国民健康保険", amount: 240000 },
    { kind: "国民年金", amount: 160000 },
  ],
  haigusha: { name: "長澤 花子", birthday: { era: "昭和", yy: 62, mm: 6, dd: 15 } },
  fuyo_shinzoku: [{ name: "長澤 太郎", zokugara: "子", birthday: { era: "平成", yy: 25, mm: 4, dd: 1 } }],
};

const blue = {
  jigyo_kikan_jiko_from: "2025-01-01",
  jigyo_kikan_itaru_to: "2025-12-31",
  uriage: 8000000,
  shiire: 500000,
  kimatsu_tanaoroshi: 500000,
  sozeikoka: 150000,
  suidokonetsu: 300000,
  ryohikotsu: 200000,
  shomohin: 100000,
  aoiro_tokubetsu_kojo: 650000,
};

const out = "/Users/nagasawakanta/Desktop";
const r = buildShotokuShinkokuXtx(ctx, { income, blue });
fs.writeFileSync(path.join(out, "RKO0010_sample.xtx"), r.xml);

const cons = buildConsumptionTaxStandardXtx(ctx, {
  kazei_from: "2025-01-01",
  kazei_to: "2025-12-31",
  kazei_hyojun: 7272000,
  shohizei: 567216,
  kojo_zeigaku: 45454,
  sashihiki_zeigaku: 521762,
  nofu_zeigaku: 521700,
  chihou_kazei_hyojun: 521700,
  jouto_wari_gaku: 147106,
  nofu_jouto_wari: 147100,
  total_nofu: 668800,
});
fs.writeFileSync(path.join(out, "RSH0010_sample.xtx"), cons.xml);

console.log("OK");
console.log("RKO0010:", r.xml.length, "bytes");
console.log("RSH0010:", cons.xml.length, "bytes");
