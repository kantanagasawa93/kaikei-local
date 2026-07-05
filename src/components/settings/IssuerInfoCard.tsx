"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FileText } from "lucide-react";
import Link from "next/link";

/**
 * Round 28: 発行者情報 (屋号・住所・電話・インボイス登録番号・振込先) を
 * 設定画面でもサマリ表示する。詳細編集は /invoices/settings/ にリンク。
 */
export function IssuerInfoCard() {
  type IssuerLite = {
    business_name: string | null;
    owner_name: string | null;
    postal_code: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    registered_number: string | null;
    bank_info: string | null;
  };
  const [issuer, setIssuer] = useState<IssuerLite | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const { db } = await import("@/lib/localDb");
        const { data } = await db
          .from("issuer_settings")
          .select("*")
          .eq("id", "singleton")
          .single();
        setIssuer(data as IssuerLite | null);
      } catch {
        setIssuer(null);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  if (!loaded) return null;

  const Row = ({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) => (
    <div className="flex items-start gap-3 text-sm py-1 border-b last:border-0 border-muted">
      <span className="w-28 text-xs text-muted-foreground flex-shrink-0">{label}</span>
      {value ? (
        <span className={`flex-1 ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
      ) : (
        <span className="flex-1 text-xs text-red-600">未登録</span>
      )}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileText className="h-4 w-4" />
          発行者情報 (請求書 PDF に印字される)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {issuer ? (
          <>
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <Row label="屋号" value={issuer.business_name} />
              <Row label="氏名" value={issuer.owner_name} />
              <Row label="郵便番号" value={issuer.postal_code} />
              <Row label="住所" value={issuer.address} />
              <Row label="電話" value={issuer.phone} />
              <Row label="メール" value={issuer.email} />
              <Row label="インボイス登録番号" value={issuer.registered_number} mono />
              <Row
                label="振込先"
                value={issuer.bank_info ? issuer.bank_info.split("\n").join(" / ") : null}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              これらは請求書を PDF 出力する時に右上の「発行者」ブロックと末尾の「お振込先」枠に印字されます。
            </p>
          </>
        ) : (
          <p className="text-amber-800 bg-amber-50 border border-amber-300 rounded px-3 py-2 text-xs">
            まだ発行者情報が登録されていません。請求書を作る前に登録してください。
          </p>
        )}
        <Link href="/invoices/settings/">
          <Button variant="outline" size="sm">
            <FileText className="h-3 w-3 mr-1" />
            発行者情報を編集する
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
