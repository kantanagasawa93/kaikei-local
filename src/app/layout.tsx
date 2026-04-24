import type { Metadata } from "next";
import "@fontsource/noto-sans-jp/300.css";
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/500.css";
import "@fontsource/noto-sans-jp/700.css";
import "./globals.css";
import { Boot } from "@/components/boot";
import { Toaster } from "@/components/toast";

export const metadata: Metadata = {
  title: "KAIKEI LOCAL",
  description: "領収書管理、仕訳、確定申告をサポートする個人事業主向けオフライン会計アプリ",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full">
        <Boot />
        {children}
        <Toaster />
      </body>
    </html>
  );
}
