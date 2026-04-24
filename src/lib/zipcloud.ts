/**
 * 郵便番号 → 住所検索 (zipcloud 公開 API)。
 *
 * API: https://zipcloud.ibsnet.co.jp/doc/api
 * - レート制限の明記は無いが、連打しないよう呼び出し側でデバウンスする
 * - 外部通信なのでプライバシーモードで使うべきではない。呼び出し側で明示同意を取る
 * - CORS 許可済み。ブラウザから直接 fetch 可
 */

export interface ZipCloudResult {
  address1: string; // 都道府県
  address2: string; // 市区町村
  address3: string; // 町域
  kana1: string;
  kana2: string;
  kana3: string;
  prefcode: string;
  zipcode: string;
}

export interface ZipCloudResponse {
  status: number;
  message: string | null;
  results: ZipCloudResult[] | null;
}

/**
 * 7桁郵便番号から住所を検索する。全候補を返す。
 *   "8130045" → 福岡市東区の複数町域 (みどりが丘、城浜団地、青葉、…)
 *
 * 失敗時 (通信エラー / 存在しない番号) は空配列を返す。
 */
export async function lookupPostalCode(
  postal: string
): Promise<ZipCloudResult[]> {
  const digits = postal.replace(/\D/g, "");
  if (digits.length !== 7) return [];

  const url = `https://zipcloud.ibsnet.co.jp/api/search?zipcode=${digits}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as ZipCloudResponse;
    if (data.status !== 200 || !data.results) return [];
    return data.results;
  } catch {
    return [];
  }
}

/**
 * 検索結果から「都道府県市区町村町域」を1つの住所文字列に結合。
 */
export function formatAddress(r: ZipCloudResult): string {
  return `${r.address1}${r.address2}${r.address3}`;
}
