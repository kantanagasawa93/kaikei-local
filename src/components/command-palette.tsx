"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Receipt,
  BookOpen,
  FileSignature,
  BarChart3,
  Landmark,
  CreditCard,
  Zap,
  Users,
  Home,
  Package,
  FileText,
  FileCheck,
  Calculator,
  Send,
  Settings,
  Plus,
  Search,
  Smartphone,
} from "lucide-react";

type Command = {
  id: string;
  label: string;
  description?: string;
  icon: React.ElementType;
  action: () => void;
  keywords: string[];
};

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const navigate = useCallback(
    (path: string) => {
      router.push(path);
      setOpen(false);
    },
    [router]
  );

  const commands: Command[] = [
    // クイックアクション
    { id: "new-journal", label: "仕訳を登録", description: "新しい仕訳を追加", icon: Plus, action: () => navigate("/journals/new"), keywords: ["仕訳", "新規", "追加", "journal", "new"] },
    { id: "new-receipt", label: "領収書を登録", description: "写真から領収書を追加", icon: Plus, action: () => navigate("/receipts/new"), keywords: ["領収書", "レシート", "receipt", "new"] },
    { id: "new-invoice", label: "請求書を作成", description: "新しい請求書を作成", icon: Plus, action: () => navigate("/invoices/edit"), keywords: ["請求書", "invoice", "new", "作成"] },
    { id: "phone-upload", label: "スマホから取り込む", description: "iCloud / QR で領収書を取込", icon: Smartphone, action: () => navigate("/phone-upload"), keywords: ["スマホ", "phone", "icloud", "qr", "取込"] },
    // ナビゲーション
    { id: "dashboard", label: "ダッシュボード", icon: LayoutDashboard, action: () => navigate("/dashboard"), keywords: ["ダッシュ", "ホーム", "dashboard"] },
    { id: "receipts", label: "領収書一覧", icon: Receipt, action: () => navigate("/receipts"), keywords: ["領収書", "レシート", "receipts"] },
    { id: "journals", label: "仕訳帳", icon: BookOpen, action: () => navigate("/journals"), keywords: ["仕訳", "帳簿", "journals"] },
    { id: "invoices", label: "請求書一覧", icon: FileSignature, action: () => navigate("/invoices"), keywords: ["請求書", "invoices"] },
    { id: "reports", label: "月次推移レポート", icon: BarChart3, action: () => navigate("/reports"), keywords: ["レポート", "月次", "推移", "reports", "PL", "BS"] },
    { id: "bank-accounts", label: "口座・クレカ", icon: Landmark, action: () => navigate("/bank-accounts"), keywords: ["口座", "銀行", "bank"] },
    { id: "transactions", label: "明細取込", icon: CreditCard, action: () => navigate("/transactions"), keywords: ["明細", "CSV", "取込", "transactions"] },
    { id: "auto-rules", label: "自動登録ルール", icon: Zap, action: () => navigate("/auto-rules"), keywords: ["ルール", "自動", "rules"] },
    { id: "partners", label: "取引先マスタ", icon: Users, action: () => navigate("/partners"), keywords: ["取引先", "partners"] },
    { id: "allocations", label: "家事按分", icon: Home, action: () => navigate("/allocations"), keywords: ["按分", "家事", "allocations"] },
    { id: "fixed-assets", label: "固定資産台帳", icon: Package, action: () => navigate("/fixed-assets"), keywords: ["固定資産", "償却", "assets"] },
    { id: "tax-return", label: "確定申告", icon: FileCheck, action: () => navigate("/tax-return"), keywords: ["確定申告", "税金", "tax"] },
    { id: "consumption-tax", label: "消費税", icon: Calculator, action: () => navigate("/consumption-tax"), keywords: ["消費税", "consumption"] },
    { id: "settings", label: "設定・ヘルプ", icon: Settings, action: () => navigate("/settings"), keywords: ["設定", "バックアップ", "ヘルプ", "settings"] },
  ];

  const filtered = query
    ? commands.filter((c) => {
        const q = query.toLowerCase();
        return (
          c.label.toLowerCase().includes(q) ||
          c.description?.toLowerCase().includes(q) ||
          c.keywords.some((k) => k.toLowerCase().includes(q))
        );
      })
    : commands;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+K or Ctrl+K で開閉
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
      }
      // Escape で閉じる
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      filtered[selectedIndex].action();
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* 背景オーバーレイ */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          {/* パレット本体 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed top-[15%] left-1/2 -translate-x-1/2 z-[201] w-full max-w-lg"
          >
            <div className="bg-card border rounded-2xl shadow-2xl overflow-hidden">
              {/* 検索バー */}
              <div className="flex items-center gap-3 px-4 border-b">
                <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="ページに移動、アクションを実行..."
                  className="flex-1 py-3.5 text-sm bg-transparent outline-none placeholder:text-muted-foreground"
                />
                <kbd className="hidden sm:inline-flex h-5 items-center gap-1 rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                  ESC
                </kbd>
              </div>

              {/* コマンドリスト */}
              <div className="max-h-80 overflow-y-auto py-2">
                {filtered.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">
                    見つかりませんでした
                  </p>
                ) : (
                  filtered.map((cmd, i) => {
                    const Icon = cmd.icon;
                    return (
                      <button
                        key={cmd.id}
                        onClick={cmd.action}
                        onMouseEnter={() => setSelectedIndex(i)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                          i === selectedIndex
                            ? "bg-primary/10 text-primary"
                            : "text-foreground hover:bg-muted/50"
                        }`}
                      >
                        <Icon className="h-4 w-4 shrink-0 opacity-60" />
                        <div className="flex-1 text-left">
                          <span className="font-medium">{cmd.label}</span>
                          {cmd.description && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {cmd.description}
                            </span>
                          )}
                        </div>
                        {i === selectedIndex && (
                          <kbd className="text-[10px] text-muted-foreground">↵</kbd>
                        )}
                      </button>
                    );
                  })
                )}
              </div>

              {/* フッター */}
              <div className="border-t px-4 py-2 flex gap-4 text-[10px] text-muted-foreground">
                <span>↑↓ 移動</span>
                <span>↵ 実行</span>
                <span>ESC 閉じる</span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
