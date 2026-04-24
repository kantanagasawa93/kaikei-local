"use client";

/**
 * 会計期間フィルタ。仕訳帳・領収書・レポート等で共通で使う。
 *
 * 仕様:
 *   - デフォルトは「今年度」（暦年 = 1/1〜12/31 の個人事業主想定）
 *   - プリセット: 今年度 / 前年度 / 直近12ヶ月 / 全期間 / カスタム
 *   - カスタム選択時は開始・終了日を指定できる
 *   - 選択状態は呼び出し元で管理（`value` / `onChange` props）
 *   - `onChange` では { from, to } の ISO 日付文字列 (YYYY-MM-DD) を返す。null は「制限なし」
 */

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarRange } from "lucide-react";

export type PeriodPreset = "fy" | "fy_prev" | "last12m" | "all" | "custom";

export interface PeriodValue {
  preset: PeriodPreset;
  /** 会計年度 (preset = fy / fy_prev 時に使う年) */
  fiscalYear?: number;
  /** custom 時の開始 */
  customFrom?: string;
  /** custom 時の終了 */
  customTo?: string;
}

export interface PeriodRange {
  from: string | null;  // YYYY-MM-DD or null
  to: string | null;
  label: string;
}

export function defaultPeriod(): PeriodValue {
  return { preset: "fy", fiscalYear: new Date().getFullYear() };
}

/**
 * PeriodValue を実際のフィルタ範囲 (from/to) に変換。
 */
export function computeRange(v: PeriodValue): PeriodRange {
  if (v.preset === "all") {
    return { from: null, to: null, label: "全期間" };
  }
  if (v.preset === "fy" || v.preset === "fy_prev") {
    const y = v.preset === "fy_prev"
      ? (v.fiscalYear ?? new Date().getFullYear()) - 1
      : (v.fiscalYear ?? new Date().getFullYear());
    return {
      from: `${y}-01-01`,
      to: `${y}-12-31`,
      label: `${y}年度`,
    };
  }
  if (v.preset === "last12m") {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    return {
      from: `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-01`,
      to: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, "0")}`,
      label: "直近12ヶ月",
    };
  }
  // custom
  return {
    from: v.customFrom || null,
    to: v.customTo || null,
    label: v.customFrom && v.customTo
      ? `${v.customFrom} 〜 ${v.customTo}`
      : "期間指定",
  };
}

interface Props {
  value: PeriodValue;
  onChange: (next: PeriodValue) => void;
  className?: string;
  /** 年を選ばせたい場合、選択肢を渡す。未指定なら現在年±5年 */
  fiscalYears?: number[];
}

const PRESET_LABELS: Record<PeriodPreset, string> = {
  fy: "今年度",
  fy_prev: "前年度",
  last12m: "直近12ヶ月",
  all: "全期間",
  custom: "カスタム",
};

export function PeriodFilter({ value, onChange, className, fiscalYears }: Props) {
  const currentYear = new Date().getFullYear();
  const years = useMemo(
    () => fiscalYears ?? Array.from({ length: 6 }, (_, i) => currentYear - i),
    [fiscalYears, currentYear]
  );

  return (
    <div className={`flex items-center gap-2 flex-wrap ${className || ""}`}>
      <CalendarRange className="h-4 w-4 text-muted-foreground" />
      <Select
        value={value.preset}
        onValueChange={(v) => v && onChange({ ...value, preset: v as PeriodPreset })}
      >
        <SelectTrigger className="w-36">
          {/* SelectValue で日本語ラベルを明示（value が "fy" 等のコードで出ないように） */}
          <span>{PRESET_LABELS[value.preset]}</span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="fy">今年度</SelectItem>
          <SelectItem value="fy_prev">前年度</SelectItem>
          <SelectItem value="last12m">直近12ヶ月</SelectItem>
          <SelectItem value="all">全期間</SelectItem>
          <SelectItem value="custom">カスタム</SelectItem>
        </SelectContent>
      </Select>

      {value.preset === "fy" && (
        <Select
          value={String(value.fiscalYear ?? currentYear)}
          onValueChange={(v) => v && onChange({ ...value, fiscalYear: parseInt(v, 10) })}
        >
          <SelectTrigger className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}年度
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {value.preset === "custom" && (
        <div className="flex items-center gap-1">
          <Input
            type="date"
            value={value.customFrom || ""}
            onChange={(e) => onChange({ ...value, customFrom: e.target.value })}
            className="w-40"
          />
          <span className="text-muted-foreground">〜</span>
          <Input
            type="date"
            value={value.customTo || ""}
            onChange={(e) => onChange({ ...value, customTo: e.target.value })}
            className="w-40"
          />
        </div>
      )}

      {value.preset !== "fy" && value.preset !== "custom" && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange(defaultPeriod())}
          title="今年度に戻す"
        >
          今年度に戻す
        </Button>
      )}
    </div>
  );
}

/**
 * 日付文字列 (YYYY-MM-DD) が range に含まれるかを判定。null ならノーチェック。
 */
export function isInRange(date: string | null | undefined, range: PeriodRange): boolean {
  if (!date) return false;
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}
