"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Receipt,
  BookOpen,
  LogOut,
  Menu,
  X,
  Landmark,
  CreditCard,
  FileText,
  FileCheck,
  Send,
  Calculator,
  BarChart3,
  Users,
  Home,
  Package,
  Zap,
  Smartphone,
  FileSignature,
  Settings as SettingsIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";
import { Separator } from "@/components/ui/separator";

const navigation = [
  { name: "ダッシュボード", href: "/dashboard", icon: LayoutDashboard },
  { name: "領収書", href: "/receipts", icon: Receipt },
  { name: "スマホ取込", href: "/phone-upload", icon: Smartphone },
  { name: "仕訳帳", href: "/journals", icon: BookOpen },
  { name: "請求書", href: "/invoices", icon: FileSignature },
  { name: "月次推移", href: "/reports", icon: BarChart3 },
];

const navigation2 = [
  { name: "口座・クレカ", href: "/bank-accounts", icon: Landmark },
  { name: "明細取込", href: "/transactions", icon: CreditCard },
  { name: "自動登録ルール", href: "/auto-rules", icon: Zap },
];

const navigationMasters = [
  { name: "取引先", href: "/partners", icon: Users },
  { name: "家事按分", href: "/allocations", icon: Home },
  { name: "固定資産", href: "/fixed-assets", icon: Package },
];

const navigation3 = [
  { name: "源泉徴収票", href: "/withholding", icon: FileText },
  { name: "確定申告", href: "/tax-return", icon: FileCheck },
  { name: "消費税", href: "/consumption-tax", icon: Calculator },
  { name: "e-Tax提出", href: "/etax", icon: Send },
];

const navigation4 = [
  { name: "設定・ヘルプ", href: "/settings", icon: SettingsIcon },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // オフライン版ではログアウトは「データフォルダを開く」に置き換え
  const handleOpenDataFolder = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { appDataDir } = await import("@tauri-apps/api/path");
      const dir = await appDataDir();
      await invoke("plugin:shell|open", { path: dir });
    } catch (e) {
      console.error("Failed to open data folder", e);
    }
  };

  const navContent = (
    <div className="flex flex-col h-full">
      <div className="p-6">
        <h1 className="text-xl font-bold tracking-wider">KAIKEI LOCAL</h1>
        <p className="text-xs text-muted-foreground mt-1">個人事業主向け</p>
        <button
          onClick={() => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
          }}
          className="mt-3 w-full flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs text-muted-foreground hover:bg-muted transition-colors"
        >
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          検索・移動
          <kbd className="ml-auto text-[10px] bg-muted px-1 rounded">⌘K</kbd>
        </button>
      </div>

      <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
        {navigation.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}

        <Separator className="my-2" />
        <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">口座連携</p>
        {navigation2.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}

        <Separator className="my-2" />
        <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">マスタ・決算</p>
        {navigationMasters.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}

        <Separator className="my-2" />
        <p className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">申告</p>
        {navigation3.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}

        <Separator className="my-2" />
        {navigation4.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t space-y-1">
        <Link
          href="/legal"
          onClick={() => setMobileOpen(false)}
          className="flex items-center gap-3 rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground w-full transition-colors"
        >
          プライバシー・利用規約
        </Link>
        <button
          onClick={handleOpenDataFolder}
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground w-full transition-colors"
        >
          <LogOut className="h-4 w-4" />
          データフォルダを開く
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile toggle */}
      <button
        className="fixed top-4 left-4 z-50 md:hidden p-2 rounded-lg bg-background border"
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-64 bg-card border-r transition-transform md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {navContent}
      </aside>
    </>
  );
}
