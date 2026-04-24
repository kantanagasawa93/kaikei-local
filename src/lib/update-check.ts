/**
 * GitHub Releases API で新バージョンがあるか確認し、あれば toast で通知する。
 *
 * 比較ロジック: 現在の package.json.version と latest release の tag_name を
 * semver 緩めに比較 (先頭 v を取ってから単純文字列比較)。
 *
 * 起動後 10 秒遅延 (boot.tsx 側でスケジュール)、1 日 1 回までに抑制する。
 * 通知を見逃した時のために、設定画面でも同じ結果を確認できるよう
 * `getUpdateState()` を公開する。
 */

import pkg from "../../package.json";

const RELEASES_API =
  "https://api.github.com/repos/kantanagasawa93/kaikei-local/releases/latest";
const DOWNLOAD_PAGE =
  "https://kantanagasawa93.github.io/kaikei-local/install.html";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STORAGE_LAST_CHECK = "kaikei_update_last_check";

let _lastResult: UpdateState = { status: "unchecked" };

export type UpdateState =
  | { status: "unchecked" }
  | { status: "up_to_date"; current: string }
  | {
      status: "available";
      current: string;
      latest: string;
      url: string;
      body?: string;
    }
  | { status: "error"; message: string };

export function getUpdateState(): UpdateState {
  return _lastResult;
}

export async function checkForUpdate(force = false): Promise<UpdateState> {
  // 抑制: 前回チェックから 24h 以内なら skip (force=true なら無視)
  if (!force && typeof window !== "undefined") {
    const prev = Number(window.localStorage.getItem(STORAGE_LAST_CHECK) || 0);
    if (Date.now() - prev < CHECK_INTERVAL_MS) return _lastResult;
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      _lastResult = { status: "error", message: `HTTP ${res.status}` };
      return _lastResult;
    }
    const data = (await res.json()) as { tag_name?: string; body?: string };
    const latest = stripV(data.tag_name || "");
    const current = pkg.version;
    if (!latest) {
      _lastResult = { status: "error", message: "tag_name 取得失敗" };
      return _lastResult;
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_LAST_CHECK, String(Date.now()));
    }
    if (isNewerSemver(latest, current)) {
      _lastResult = {
        status: "available",
        current,
        latest,
        url: DOWNLOAD_PAGE,
        body: data.body,
      };
      // toast 通知 (遅延 import で循環回避)
      void import("@/lib/toast").then(({ toast }) => {
        toast.info(
          `新しいバージョン ${latest} が公開されています (現在 ${current})。設定→ヘルプの「アップデート確認」から更新できます。`
        );
      });
      return _lastResult;
    }
    _lastResult = { status: "up_to_date", current };
    return _lastResult;
  } catch (e) {
    _lastResult = { status: "error", message: (e as Error).message };
    return _lastResult;
  }
}

function stripV(tag: string): string {
  return tag.replace(/^v/, "");
}

/**
 * semver 緩め比較。pre-release サフィックスを含む文字列でも動くよう、
 * [数字列] を順に比較し、文字列尾は降順扱い (beta/rc は release より古い)。
 */
function isNewerSemver(a: string, b: string): boolean {
  const parse = (s: string) => {
    const [core, pre = ""] = s.split("-");
    const nums = core.split(".").map((x) => parseInt(x, 10) || 0);
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.nums[i] ?? 0;
    const bi = pb.nums[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  // コア部分が等しい時: pre-release 無し (release) > pre あり
  if (pa.pre === "" && pb.pre !== "") return true;
  if (pa.pre !== "" && pb.pre === "") return false;
  // 両方 pre-release: 文字列比較
  return pa.pre > pb.pre;
}

export const __test__ = { isNewerSemver, stripV };
