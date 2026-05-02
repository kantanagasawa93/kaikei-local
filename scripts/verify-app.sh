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
#   navigate <route>         起動中アプリを <route> に遷移させる (例: /inbox)
#                            (CLI から control file を書く → Frontend が poll)
#   smoke                    スキャン → DB ダンプ → スクショまでを順に実行
#   smoke-report [<file>]    smoke を Markdown レポートに書き出す
#                            (既定: /tmp/kaikei-verify-<UTC>.md)
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

cmd_navigate() {
  require_bin
  local route="${1:-/dashboard}"
  # CLI から control file を書き、起動中の Frontend NavigateBridge が
  # 1 秒以内に拾って router.push する。osascript の TCC を回避する迂回路。
  "$KAIKEI_BIN" --navigate="$route"
  # アプリを前面に持ってきて UI を更新させる
  cmd_activate
  # 1.5 秒待つ (poll 周期 1 秒 + 余裕)
  sleep 1.5
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

# ㊄ smoke 結果を Markdown レポートとして書き出す。
# Round 4 で導入: ラウンド完了時に「最後の検証はこういう状態だった」を
# 残してユーザに引き継ぎやすくするため。
cmd_smoke_report() {
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local out="${1:-/tmp/kaikei-verify-${ts}.md}"
  local app_ver
  app_ver=$(awk -F'"' '/"version"[[:space:]]*:/ {print $4; exit}' "$SCRIPT_DIR/../src-tauri/tauri.conf.json" 2>/dev/null || echo "?")
  local shot
  shot=$(cmd_ui_screenshot 2>/dev/null) || shot=""

  local scan_json inbox_json log_lines
  scan_json=$(cmd_simulate_scan 2>&1 || true)
  inbox_json=$(cmd_db_dump photo_inbox 2>/dev/null || echo "[]")
  log_lines=$(cmd_tail_log 20 2>/dev/null || true)

  # python で JSON を要約 (件数・state 別カウント)
  local inbox_summary
  inbox_summary=$(echo "$inbox_json" | python3 -c "
import json, sys
try:
  rows = json.load(sys.stdin)
except Exception:
  rows = []
print(f'- 行数: {len(rows)}')
buckets = {}
for r in rows:
  s = r.get('state', '?')
  buckets[s] = buckets.get(s, 0) + 1
for k in sorted(buckets):
  print(f'  - {k}: {buckets[k]}')
" 2>/dev/null || echo "- (parse 失敗)")

  {
    echo "# KAIKEI LOCAL — 検証レポート"
    echo ""
    echo "- 生成日時 (UTC): $ts"
    echo "- アプリバージョン: v$app_ver"
    echo "- ホスト: $(uname -srm)"
    echo ""
    echo "## simulate-scan"
    echo ""
    echo '```json'
    echo "$scan_json"
    echo '```'
    echo ""
    echo "## photo_inbox サマリー"
    echo ""
    echo "$inbox_summary"
    echo ""
    echo "## scan.log 末尾 20 行"
    echo ""
    echo '```'
    echo "$log_lines"
    echo '```'
    echo ""
    if [ -n "$shot" ]; then
      echo "## UI スクリーンショット"
      echo ""
      echo "ファイル: \`$shot\`"
      echo ""
      echo "(Markdown プレビュアの Local Image でこのパスを開いて確認)"
      echo ""
    fi
    echo "---"
    echo "_このレポートは \`scripts/verify-app.sh smoke-report\` で生成されました_"
  } > "$out"

  echo "$out"
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
    navigate|nav)              cmd_navigate "$@" ;;
    smoke)                     cmd_smoke ;;
    smoke-report|report)       cmd_smoke_report "$@" ;;
    help|-h|--help)            usage ;;
    *) echo "unknown subcommand: $sub" >&2; usage; exit 2 ;;
  esac
}

main "$@"
