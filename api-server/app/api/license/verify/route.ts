import { NextRequest, NextResponse } from "next/server";
import { getLicense, isLicenseValid, getCurrentUsage } from "@/lib/license";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: NextRequest) {
  let body: { license_key?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400, headers: corsHeaders() });
  }
  if (!body.license_key) {
    return NextResponse.json({ error: "license_key is required" }, { status: 400, headers: corsHeaders() });
  }

  const license = await getLicense(body.license_key);
  if (!license) {
    return NextResponse.json(
      { valid: false, reason: "not_found" },
      { headers: corsHeaders() }
    );
  }

  const valid = isLicenseValid(license);
  const used = await getCurrentUsage(body.license_key);

  return NextResponse.json(
    {
      valid,
      status: license.status,
      plan: license.plan,
      expires_at: license.expires_at,
      monthly_limit: license.monthly_limit,
      used_this_month: used,
    },
    { headers: corsHeaders() }
  );
}
