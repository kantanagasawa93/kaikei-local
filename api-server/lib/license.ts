import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

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
  await redis.set(`license:${key}`, record);
  if (params.stripe_customer_id) {
    await redis.set(`customer:${params.stripe_customer_id}`, key);
  }
  return record;
}

export async function getLicense(key: string): Promise<LicenseRecord | null> {
  const record = await redis.get<LicenseRecord>(`license:${key}`);
  return record;
}

export async function updateLicenseStatus(
  key: string,
  status: LicenseRecord["status"],
  expires_at?: string
): Promise<void> {
  const existing = await getLicense(key);
  if (!existing) return;
  existing.status = status;
  if (expires_at) existing.expires_at = expires_at;
  await redis.set(`license:${key}`, existing);
}

export async function getLicenseByCustomer(
  customerId: string
): Promise<LicenseRecord | null> {
  const key = await redis.get<string>(`customer:${customerId}`);
  if (!key) return null;
  return getLicense(key);
}

/**
 * 月の使用量を記録する。1ヶ月で MONTHLY_LIMIT を超えるとエラー。
 */
export async function incrementUsage(
  key: string
): Promise<{ used: number; limit: number; ok: boolean }> {
  const license = await getLicense(key);
  if (!license) return { used: 0, limit: 0, ok: false };

  const yyyyMm = new Date().toISOString().slice(0, 7);
  const usageKey = `usage:${key}:${yyyyMm}`;
  const used = (await redis.incr(usageKey)) as number;
  // 月末まで保持（32日で自動削除）
  await redis.expire(usageKey, 32 * 24 * 60 * 60);
  return { used, limit: license.monthly_limit, ok: used <= license.monthly_limit };
}

export async function getCurrentUsage(key: string): Promise<number> {
  const yyyyMm = new Date().toISOString().slice(0, 7);
  const usageKey = `usage:${key}:${yyyyMm}`;
  const used = (await redis.get<number>(usageKey)) ?? 0;
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
