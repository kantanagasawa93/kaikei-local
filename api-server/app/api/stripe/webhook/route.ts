import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import {
  createLicense,
  getLicenseByCustomer,
  updateLicenseStatus,
} from "@/lib/license";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 環境変数が未設定の状態でビルドエラーにならないよう、遅延初期化
function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not set");
  return new Stripe(key);
}

function getWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || "";
}

/**
 * Resend でメール送信する（API キーがあれば）
 * 無ければコンソール出力のみ。
 */
async function sendLicenseEmail(
  email: string,
  licenseKey: string,
  plan: "monthly" | "yearly"
) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log(`[EMAIL] to=${email} key=${licenseKey} plan=${plan} (RESEND_API_KEY not set)`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "KAIKEI LOCAL <no-reply@kaikei-local.com>",
        to: email,
        subject: "【KAIKEI LOCAL】AI OCR プラン ご購入ありがとうございます",
        html: `<!doctype html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;color:#111">
<h1 style="font-size:22px">ご購入ありがとうございます</h1>
<p>KAIKEI LOCAL の AI OCR プランをご購入いただきありがとうございます。</p>
<p>以下のライセンスキーをアプリの <strong>設定 &gt; AI 読み取り</strong> に貼り付けてください。</p>
<div style="background:#f5f5f5;padding:20px;border-radius:12px;text-align:center;margin:24px 0">
  <p style="font-size:11px;color:#666;margin:0 0 8px 0">ライセンスキー</p>
  <p style="font-family:'SF Mono',Menlo,monospace;font-size:18px;font-weight:bold;letter-spacing:1px;margin:0;word-break:break-all">${licenseKey}</p>
</div>
<p>プラン: <strong>${plan === "yearly" ? "年額" : "月額"}</strong></p>
<p>月 500枚までレシートを AI で読み取れます。</p>
<hr style="margin:32px 0;border:0;border-top:1px solid #eee">
<p style="font-size:12px;color:#666">解約は Stripe の管理画面から、または <a href="mailto:k.nagasawa.pc@gmail.com">お問い合わせ</a> まで。</p>
</body></html>`,
      }),
    });
    if (!res.ok) {
      console.error("Resend failed:", await res.text());
    }
  } catch (e) {
    console.error("Resend error:", e);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "No signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  const stripe = getStripe();
  try {
    event = stripe.webhooks.constructEvent(body, sig, getWebhookSecret());
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== "subscription") break;

        const subscriptionId = session.subscription as string;
        const customerId = session.customer as string;
        const email = session.customer_details?.email || session.customer_email || "";

        // 既にライセンスがあればスキップ（重複発行防止）
        const existing = await getLicenseByCustomer(customerId);
        if (existing) {
          console.log(`License already exists for customer ${customerId}`);
          break;
        }

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = sub.items.data[0].price.id;
        const interval = sub.items.data[0].price.recurring?.interval;
        const plan: "monthly" | "yearly" = interval === "year" ? "yearly" : "monthly";
        const expiresAt = new Date(sub.current_period_end * 1000).toISOString();

        const license = await createLicense({
          customer_email: email,
          stripe_subscription_id: subscriptionId,
          stripe_customer_id: customerId,
          plan,
          expires_at: expiresAt,
        });

        console.log(`License created: ${license.license_key} for ${email}`);
        if (email) {
          await sendLicenseEmail(email, license.license_key, plan);
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const license = await getLicenseByCustomer(sub.customer as string);
        if (!license) break;
        const expiresAt = new Date(sub.current_period_end * 1000).toISOString();
        const status =
          sub.status === "active" || sub.status === "trialing"
            ? "active"
            : sub.status === "past_due"
              ? "past_due"
              : "cancelled";
        await updateLicenseStatus(license.license_key, status, expiresAt);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const license = await getLicenseByCustomer(sub.customer as string);
        if (!license) break;
        await updateLicenseStatus(license.license_key, "cancelled");
        break;
      }
    }
  } catch (e) {
    console.error("Webhook handler error:", e);
    return NextResponse.json({ error: "handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
