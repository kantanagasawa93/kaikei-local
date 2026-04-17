"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_ACCOUNTS } from "@/lib/accounts";
import type { Account } from "@/types";

interface AccountSelectProps {
  value?: string;
  onValueChange: (code: string, name: string) => void;
  category?: Account["category"];
  placeholder?: string;
}

export function AccountSelect({
  value,
  onValueChange,
  category,
  placeholder = "勘定科目を選択",
}: AccountSelectProps) {
  const accounts = category
    ? DEFAULT_ACCOUNTS.filter((a) => a.category === category)
    : DEFAULT_ACCOUNTS;

  const grouped = accounts.reduce<Record<string, Account[]>>((acc, account) => {
    const label = getCategoryLabel(account.category);
    if (!acc[label]) acc[label] = [];
    acc[label].push(account);
    return acc;
  }, {});

  return (
    <Select
      value={value}
      onValueChange={(code) => {
        const account = DEFAULT_ACCOUNTS.find((a) => a.code === code);
        if (account && code) onValueChange(code, account.name);
      }}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder}>
          {value ? `${value} ${DEFAULT_ACCOUNTS.find((a) => a.code === value)?.name || ""}` : undefined}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Object.entries(grouped).map(([label, accts]) => (
          <div key={label}>
            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
              {label}
            </div>
            {accts.map((account) => (
              <SelectItem key={account.code} value={account.code}>
                {account.code} {account.name}
              </SelectItem>
            ))}
          </div>
        ))}
      </SelectContent>
    </Select>
  );
}

function getCategoryLabel(category: Account["category"]): string {
  const labels: Record<Account["category"], string> = {
    asset: "資産",
    liability: "負債",
    equity: "資本",
    revenue: "収益",
    expense: "費用",
  };
  return labels[category];
}
