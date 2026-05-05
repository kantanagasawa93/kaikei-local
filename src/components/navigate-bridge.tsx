"use client";

/**
 * Round 6 ㊎: CLI (`kaikei --navigate=/inbox`) が書く control file を 1 秒
 * 間隔で polling し、ターゲットルートが見つかったら router.push する。
 *
 * 経緯:
 *   - Claude (verify-app.sh) が起動中の KAIKEI LOCAL.app の特定ページに
 *     遷移してスクショを取りたいケースが多い (受信箱・設定 AI OCR ログ等)
 *   - osascript の `keystroke` は macOS の TCC で常に弾かれる
 *   - Tauri 起動済みプロセスに別プロセスから直接 IPC は出来ない
 *   → 一番確実な手段: control file を CLI が書き、Frontend が poll する
 *
 * 安全性: target file は app_data_dir 内 (`.navigate-target`) で、Frontend は
 * 値を `/^\/[a-zA-Z0-9_\-/]+$/` でマッチ確認してから router.push する。
 * 任意 URL は受け付けない (XSS / Tauri command 経由の侵入を阻止)。
 *
 * Round 11 ㉩: last_route 記憶。pathname の変化を debounce して
 * app_settings.last_route に保存。アプリ起動時に同 key を読み、最初の
 * route が "/" だったら last_route に router.push する。
 */

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

const POLL_MS = 1000;
const SAFE_ROUTE_RE = /^\/[a-zA-Z0-9_\-/]*$/;
const LAST_ROUTE_KEY = "last_route";

export function NavigateBridge() {
  const router = useRouter();
  const pathname = usePathname();
  const initialNavDone = useRef(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ㉩ 起動時に app_settings.last_route を読み、ルートが "/" or "/dashboard"
  //    で last_route が別の場所なら復元 (Tauri 起動時 pathname は /dashboard
  //    のことが多いので、その場合も last_route が違うなら戻す)
  useEffect(() => {
    if (initialNavDone.current) return;
    initialNavDone.current = true;
    void (async () => {
      try {
        const { db } = await import("@/lib/localDb");
        const { data } = await db
          .from("app_settings")
          .select("value")
          .eq("id", LAST_ROUTE_KEY)
          .single();
        const last = (data as { value?: string } | null)?.value || "";
        const here = window.location.pathname || "/";
        const isInitialPath =
          here === "/" || here === "" || here === "/dashboard" || here === "/dashboard/";
        const sameAsHere = last === here || last === here.replace(/\/$/, "") || `${last}/` === here;
        if (last && SAFE_ROUTE_RE.test(last) && isInitialPath && !sameAsHere) {
          router.push(last);
        }
      } catch {
        /* DB load 前 / 古い DB で last_route が未保存 — 何もしない */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ㉩ pathname が変わるたびに 800ms debounce で last_route を保存
  useEffect(() => {
    if (!pathname) return;
    if (persistTimer.current) clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      void (async () => {
        try {
          const { db } = await import("@/lib/localDb");
          const updated_at = new Date().toISOString();
          const { data: existing } = await db
            .from("app_settings")
            .select("id")
            .eq("id", LAST_ROUTE_KEY)
            .single();
          if (existing) {
            await db
              .from("app_settings")
              .update({ value: pathname, updated_at })
              .eq("id", LAST_ROUTE_KEY);
          } else {
            await db
              .from("app_settings")
              .insert({ id: LAST_ROUTE_KEY, value: pathname, updated_at });
          }
        } catch {
          /* silent: 保存に失敗しても致命でない */
        }
      })();
    }, 800);
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [pathname]);

  // ㊎ Round 6: CLI からの navigate target を polling
  // ㊇ Round 17: 同じタイマーで demo action target も polling
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // 許容する demo action 名 (allowlist)
    const ALLOWED_ACTIONS = new Set([
      "scan-now",
      "journalize-all-receipts",
      "open-help",
    ]);

    const poll = async () => {
      if (cancelled) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const target = ((await invoke("navigate_target_get")) as string) || "";
        if (target && SAFE_ROUTE_RE.test(target)) {
          await invoke("navigate_target_clear");
          if (!cancelled) {
            router.push(target);
          }
        } else if (target) {
          await invoke("navigate_target_clear");
        }

        // ㊇ demo action: allowlist にあればグローバル CustomEvent で配信
        const action = ((await invoke("demo_action_get")) as string) || "";
        if (action) {
          await invoke("demo_action_clear");
          if (ALLOWED_ACTIONS.has(action) && !cancelled) {
            window.dispatchEvent(
              new CustomEvent("kaikei:demo-action", { detail: action }),
            );
          }
        }
      } catch {
        /* Tauri 外で動いている時 (ブラウザ実行) は何もしない */
      }
      if (!cancelled) {
        timer = setTimeout(poll, POLL_MS);
      }
    };
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [router]);

  return null;
}
