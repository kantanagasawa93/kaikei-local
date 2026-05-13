import { Redis } from "@upstash/redis";

// Upstash の環境変数が未設定の環境 (= オーナー専用バイパスだけで運用するケース)
// でもモジュールロード時にクラッシュしないよう、Redis 接続は遅延生成にする。
let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) _redis = Redis.fromEnv();
  return _redis;
}

// ────────────────────────────────────────────────────────────
// オーナー専用ライセンスキー (開発者本人が自分で使う用)
//
// 環境変数 OWNER_LICENSE_KEY に好きな秘密文字列を入れておくと、その値を
// ライセンスキーとして渡したリクエストは Redis を一切見ずに「常に有効・
// 高い月次枠」として通る。Stripe や Upstash の設定なしで AI OCR を使える。
//
// 一般ユーザ向けのライセンス (Stripe 連携) はこれまで通り Redis ベース。
// ────────────────────────────────────────────────────────────
// env 設定時に末尾改行が混入することがあるので trim しておく
const OWNER_LICENSE_KEY = (process.env.OWNER_LICENSE_KEY || "").trim();
const OWNER_MONTHLY_LIMIT = 100000; // 実質無制限

function isOwnerKey(key: string): boolean {
  return Boolean(OWNER_LICENSE_KEY) && key.trim() === OWNER_LICENSE_KEY;
}

function ownerLicenseRecord(key: string): LicenseRecord {
  return {
    license_key: key,
    customer_email: "owner@kaikei-local.com",
    stripe_subscription_id: null,
    stripe_customer_id: null,
    plan: "yearly",
    status: "active",
    created_at: "2024-01-01T00:00:00.000Z",
    expires_at: "2099-12-31T23:59:59.000Z",
    monthly_limit: OWNER_MONTHLY_LIMIT,
  };
}

export type LicenseRecord = {
  license_key: string;
  customer_email: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  plan: "monthly" | "yearly";
  status: "active" | "cancelled" | "past_due";
  created_at: string;
  expires_at: string; // ISO date
  monthly_limit: number; // 例: 500
};

const MONTHLY_LIMIT = 500;

/** ライセンスキー形式: KL-XXXX-XXXX-XXXX-XXXX（16進大文字） */
export function generateLicenseKey(): string {
  const seg = () =>
    [...crypto.getRandomValues(new Uint8Array(2))]
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join("");
  return `KL-${seg()}-${seg()}-${seg()}-${seg()}`;
}

export async function createLicense(params: {
  customer_email: string;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  plan: "monthly" | "yearly";
  expires_at: string;
}): Promise<LicenseRecord> {
  const key = generateLicenseKey();
  const record: LicenseRecord = {
    license_key: key,
    customer_email: params.customer_email,
    stripe_subscription_id: params.stripe_subscription_id,
    stripe_customer_id: params.stripe_customer_id,
    plan: params.plan,
    status: "active",
    created_at: new Date().toISOString(),
    expires_at: params.expires_at,
    monthly_limit: MONTHLY_LIMIT,
  };
  await getRedis().set(`license:${key}`, record);
  if (params.stripe_customer_id) {
    await getRedis().set(`customer:${params.stripe_customer_id}`, key);
  }
  return record;
}

export async function getLicense(key: string): Promise<LicenseRecord | null> {
  // オーナー専用キーは Redis を見ずに固定レコードを返す
  if (isOwnerKey(key)) return ownerLicenseRecord(key);
  const record = await getRedis().get<LicenseRecord>(`license:${key}`);
  return record;
}

export async function updateLicenseStatus(
  key: string,
  status: LicenseRecord["status"],
  expires_at?: string
): Promise<void> {
  if (isOwnerKey(key)) return; // オーナーキーは常時 active、状態変更不要
  const existing = await getLicense(key);
  if (!existing) return;
  existing.status = status;
  if (expires_at) existing.expires_at = expires_at;
  await getRedis().set(`license:${key}`, existing);
}

export async function getLicenseByCustomer(
  customerId: string
): Promise<LicenseRecord | null> {
  const key = await getRedis().get<string>(`customer:${customerId}`);
  if (!key) return null;
  return getLicense(key);
}

/**
 * 月の使用量を記録する。1ヶ月で MONTHLY_LIMIT を超えるとエラー。
 * オーナー専用キーは Redis を使わず常に ok を返す。
 */
export async function incrementUsage(
  key: string
): Promise<{ used: number; limit: number; ok: boolean }> {
  if (isOwnerKey(key)) {
    return { used: 1, limit: OWNER_MONTHLY_LIMIT, ok: true };
  }
  const license = await getLicense(key);
  if (!license) return { used: 0, limit: 0, ok: false };

  const yyyyMm = new Date().toISOString().slice(0, 7);
  const usageKey = `usage:${key}:${yyyyMm}`;
  const used = (await getRedis().incr(usageKey)) as number;
  // 月末まで保持（32日で自動削除）
  await getRedis().expire(usageKey, 32 * 24 * 60 * 60);
  return { used, limit: license.monthly_limit, ok: used <= license.monthly_limit };
}

export async function getCurrentUsage(key: string): Promise<number> {
  if (isOwnerKey(key)) return 0;
  const yyyyMm = new Date().toISOString().slice(0, 7);
  const usageKey = `usage:${key}:${yyyyMm}`;
  const used = (await getRedis().get<number>(usageKey)) ?? 0;
  return used;
}

/**
 * ライセンスが現在有効か判定
 */
export function isLicenseValid(license: LicenseRecord): boolean {
  if (license.status !== "active") return false;
  const now = Date.now();
  const exp = new Date(license.expires_at).getTime();
  return now <= exp;
}
