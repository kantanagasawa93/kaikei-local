#!/usr/bin/env bash
# ============================================================
# KAIKEI LOCAL — 自律検証ハーネス
#
# Claude が「ユーザに『アプリ立ち上げてスクショ撮って』と頼まずに」
# E2E 検証を完結できるようにするための入口スクリプト。
#
# サブコマンド:
#   ui-screenshot [<file>]   起動中の KAIKEI LOCAL 窓だけを PNG で取る
#                            (既定: /tmp/kaikei-ui-<UTC>.png)
#   simulate-scan            ヘッドレススキャンを走らせて JSON 出力
#   db-dump <table>          DB テーブルを JSON 配列でダンプ
#   tail-log [<n>]           scan.log の末尾 n 行 (既定 50)
#   activate                 KAIKEI LOCAL を最前面に持ってくる
#   open-page <route>        例: open-page /inbox  (URL は appURL? 未対応のため
#                            アプリ内ナビゲーションは現時点では osascript の
#                            キー操作 fallback)
#   smoke                    スキャン → DB ダンプ → スクショまでを順に実行
#   help                     ヘルプ
#
# 環境変数:
#   KAIKEI_BIN  既定: /Applications/KAIKEI LOCAL.app/Contents/MacOS/kaikei
#   APP_NAME    既定: KAIKEI LOCAL
# ============================================================
set -euo pipefail

APP_NAME="${APP_NAME:-KAIKEI LOCAL}"
KAIKEI_BIN="${KAIKEI_BIN:-/Applications/KAIKEI LOCAL.app/Contents/MacOS/kaikei}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  sed -n '3,25p' "$0" | sed 's/^# \?//'
}

require_bin() {
  if [ ! -x "$KAIKEI_BIN" ]; then
    echo "ERROR: $KAIKEI_BIN が見つかりません" >&2
    echo "       先にローカルビルドを差し替えてください (CLAUDE.md 参照)" >&2
    exit 2
  fi
}

cmd_activate() {
  osascript -e "tell application \"$APP_NAME\" to activate"
  # ウィンドウが前面に来るのを待つ
  sleep 0.7
}

cmd_ui_screenshot() {
  local out="${1:-/tmp/kaikei-ui-$(date -u +%Y%m%dT%H%M%SZ).png}"
  cmd_activate
  # System Events で前面ウィンドウの bounds を取り、その矩形だけ screencapture
  local bounds
  bounds=$(osascript "$SCRIPT_DIR/verify/window-bounds.applescript" "$APP_NAME" 2>/dev/null || true)
  if [ -z "$bounds" ]; then
    # 取れない時は全画面
    screencapture -x "$out"
  else
    # bounds = "X Y W H"
    # shellcheck disable=SC2086
    set -- $bounds
    local x="$1" y="$2" w="$3" h="$4"
    screencapture -x -R"${x},${y},${w},${h}" "$out"
  fi
  echo "$out"
}

cmd_simulate_scan() {
  require_bin
  "$KAIKEI_BIN" --simulate-scan
}

cmd_db_dump() {
  require_bin
  local table="${1:-photo_inbox}"
  "$KAIKEI_BIN" --db-dump="$table"
}

cmd_tail_log() {
  require_bin
  local n="${1:-50}"
  "$KAIKEI_BIN" --tail-scan-log="$n"
}

cmd_smoke() {
  echo "==> simulate-scan"
  cmd_simulate_scan
  echo ""
  echo "==> photo_inbox (上位 5 件)"
  cmd_db_dump photo_inbox | python3 -c "import json,sys; rows=json.load(sys.stdin); [print(json.dumps(r, ensure_ascii=False)) for r in rows[:5]]" 2>/dev/null || true
  echo ""
  echo "==> photo_scan_log (上位 3 件)"
  cmd_db_dump photo_scan_log | python3 -c "import json,sys; rows=json.load(sys.stdin); [print(json.dumps(r, ensure_ascii=False)) for r in rows[:3]]" 2>/dev/null || true
  echo ""
  echo "==> tail scan.log (10 行)"
  cmd_tail_log 10 || true
  echo ""
  local shot
  shot=$(cmd_ui_screenshot)
  echo "==> screenshot: $shot"
}

main() {
  local sub="${1:-help}"
  shift || true
  case "$sub" in
    ui-screenshot|screenshot)  cmd_ui_screenshot "$@" ;;
    simulate-scan|scan)        cmd_simulate_scan "$@" ;;
    db-dump|db)                cmd_db_dump "$@" ;;
    tail-log|log)              cmd_tail_log "$@" ;;
    activate)                  cmd_activate ;;
    smoke)                     cmd_smoke ;;
    help|-h|--help)            usage ;;
    *) echo "unknown subcommand: $sub" >&2; usage; exit 2 ;;
  esac
}

main "$@"
