import { NextRequest, NextResponse } from "next/server";
import { createLicense } from "@/lib/license";

/**
 * 管理者用: 手動でライセンスキーを発行する。
 * X-Admin-Secret ヘッダが必要。環境変数 ADMIN_SECRET と照合。
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-admin-secret");
  if (!process.env.ADMIN_SECRET || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    customer_email?: string;
    plan?: "monthly" | "yearly";
    days?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const plan = body.plan === "yearly" ? "yearly" : "monthly";
  const days = body.days ?? (plan === "yearly" ? 365 : 31);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const license = await createLicense({
    customer_email: body.customer_email || "manual@kaikei-local.com",
    stripe_subscription_id: null,
    stripe_customer_id: null,
    plan,
    expires_at: expiresAt,
  });

  return NextResponse.json(license);
}
