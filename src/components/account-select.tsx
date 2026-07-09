"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Search, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ACCOUNTS,
  searchAccounts,
  getAccountByCode,
} from "@/lib/accounts";
import type { Account } from "@/types";

interface AccountSelectProps {
  value?: string;
  onValueChange: (code: string, name: string) => void;
  category?: Account["category"];
  placeholder?: string;
}

const CATEGORY_LABELS: Record<Account["category"], string> = {
  asset: "資産",
  liability: "負債",
  equity: "資本",
  revenue: "収益",
  expense: "費用",
};
const CATEGORY_ORDER: Account["category"][] = [
  "expense",
  "asset",
  "liability",
  "revenue",
  "equity",
];

/**
 * freee 風の勘定科目ピッカー。
 * - 予測変換: 検索欄にコード / 科目名 / 読み仮名 / 英名を打つと絞り込み ([[searchAccounts]])
 * - 階層ドリル: 検索が空のときは科目区分 (費用/資産/…) を開閉して掘れる
 * - キーボード: ↑↓ で移動 / Enter で確定 / Esc で閉じる
 * props は旧実装と互換 (value / onValueChange / category / placeholder)。
 */
export function AccountSelect({
  value,
  onValueChange,
  category,
  placeholder = "勘定科目を選択",
}: AccountSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = value ? getAccountByCode(value) : undefined;

  // 掘って見せる区分。category prop があればその 1 区分のみ。
  const categories = useMemo(
    () => (category ? [category] : CATEGORY_ORDER),
    [category],
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const openMenu = () => {
    // 開くたびに初期化 (検索クリア / 先頭ハイライト / 現在値の区分を開く)
    setQuery("");
    setHighlight(0);
    const cat = selected?.category ?? category ?? "expense";
    setExpanded(new Set([cat]));
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // クリックアウトで閉じる
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const results = useMemo(
    () => (query.trim() ? searchAccounts(query, category) : []),
    [query, category],
  );

  // 検索モードなら結果、ブラウズモードなら開いている区分の科目を
  // 「上下キーで移動できる並び」として平坦化する。
  const flatVisible: Account[] = useMemo(() => {
    if (query.trim()) return results;
    const out: Account[] = [];
    for (const cat of categories) {
      if (!expanded.has(cat)) continue;
      out.push(...DEFAULT_ACCOUNTS.filter((a) => a.category === cat));
    }
    return out;
  }, [query, results, categories, expanded]);

  // highlight は「表示中の並び」が変わる操作 (検索入力・区分の開閉・オープン) の
  // たびに 0 リセットしているので、ここで別途 clamp する必要はない。
  const activeIdx = Math.min(highlight, Math.max(0, flatVisible.length - 1));

  const choose = (a: Account) => {
    onValueChange(a.code, a.name);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, flatVisible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = flatVisible[activeIdx];
      if (a) choose(a);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  // ハイライト行をスクロール追従
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm outline-none transition-colors",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "dark:bg-input/30 dark:hover:bg-input/50",
          !selected && "text-muted-foreground",
        )}
      >
        <span className="line-clamp-1 text-left">
          {selected ? `${selected.code} ${selected.name}` : placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 w-full min-w-64 overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center gap-2 border-b px-2.5 py-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              placeholder="コード・科目名・読み (例: 610 / 消耗 / しょうもう)"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
            {query.trim() ? (
              results.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  「{query}」に一致する科目がありません
                </p>
              ) : (
                results.map((a, idx) => (
                  <Row
                    key={a.code}
                    account={a}
                    idx={idx}
                    active={idx === activeIdx}
                    selected={a.code === value}
                    showCategory={!category}
                    query={query}
                    onHover={() => setHighlight(idx)}
                    onPick={() => choose(a)}
                  />
                ))
              )
            ) : (
              // ブラウズ (階層ドリル)
              (() => {
                let idx = -1;
                return categories.map((cat) => {
                  const accts = DEFAULT_ACCOUNTS.filter(
                    (a) => a.category === cat,
                  );
                  const isOpen = expanded.has(cat);
                  return (
                    <div key={cat}>
                      {!category && (
                        <button
                          type="button"
                          onClick={() => {
                            setHighlight(0);
                            setExpanded((prev) => {
                              const next = new Set(prev);
                              if (next.has(cat)) next.delete(cat);
                              else next.add(cat);
                              return next;
                            });
                          }}
                          className="flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent/60"
                        >
                          {isOpen ? (
                            <ChevronDown className="size-3.5" />
                          ) : (
                            <ChevronRight className="size-3.5" />
                          )}
                          {CATEGORY_LABELS[cat]}
                          <span className="font-normal opacity-70">
                            ({accts.length})
                          </span>
                        </button>
                      )}
                      {isOpen &&
                        accts.map((a) => {
                          idx += 1;
                          const rowIdx = idx;
                          return (
                            <Row
                              key={a.code}
                              account={a}
                              idx={rowIdx}
                              active={rowIdx === activeIdx}
                              selected={a.code === value}
                              indent={!category}
                              onHover={() => setHighlight(rowIdx)}
                              onPick={() => choose(a)}
                            />
                          );
                        })}
                    </div>
                  );
                });
              })()
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  account,
  idx,
  active,
  selected,
  showCategory,
  indent,
  query,
  onHover,
  onPick,
}: {
  account: Account;
  idx: number;
  active: boolean;
  selected: boolean;
  showCategory?: boolean;
  indent?: boolean;
  query?: string;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      data-idx={idx}
      onMouseMove={onHover}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-1.5 text-left text-sm outline-none",
        indent && "pl-6",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">
        {account.code}
      </span>
      <span className="flex-1 truncate">
        {query ? highlightMatch(account.name, query) : account.name}
      </span>
      {showCategory && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {CATEGORY_LABELS[account.category]}
        </span>
      )}
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  );
}

/** 科目名の中で query に一致する部分を太字にする (漢字・英名の素直な一致のみ)。 */
function highlightMatch(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <b className="font-semibold">{text.slice(i, i + q.length)}</b>
      {text.slice(i + q.length)}
    </>
  );
}
