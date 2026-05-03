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
#   app-log [<n>] [--errors-only]
#                            アプリ本体ログ (webview console 含む) の末尾
#   activate                 KAIKEI LOCAL を最前面に持ってくる
#   navigate <route>         起動中アプリを <route> に遷移させる (例: /inbox)
#                            (CLI から control file を書く → Frontend が poll)
#   smoke                    スキャン → DB ダンプ → スクショまでを順に実行
#   smoke-report [<file>]    smoke を Markdown レポートに書き出す
#                            (既定: /tmp/kaikei-verify-<UTC>.md)
#   smoke-report-html [<file>]
#                            smoke を HTML (画像 data-uri 埋込み) にする
#                            (既定: /tmp/kaikei-verify-<UTC>.html)
#   watch                    src/ src-tauri/src/ の変更を監視 →
#                            自動で next build + tauri build + .app 差し替え +
#                            smoke-report を回す (Ctrl+C で停止)
#   demo [<out.mp4>]         主要 4 画面を screencapture x4 → ffmpeg で MP4
#                            (既定: /tmp/kaikei-demo-<UTC>.mp4) ffmpeg 必要
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

# Round 8 ㊘ — Tauri plugin-log の本体ログ (webview console.error 含む) を tail
cmd_app_log() {
  require_bin
  local n="${1:-50}"
  if [ "${2:-}" = "--errors-only" ] || [ "${ERRORS_ONLY:-}" = "1" ]; then
    "$KAIKEI_BIN" --tail-app-log="$n" --errors-only
  else
    "$KAIKEI_BIN" --tail-app-log="$n"
  fi
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

# Round 9 ㉟ — ソース変更を検知して自動で再ビルド + smoke-report
#
# 監視対象:
#   - src/, src-tauri/src/, src-tauri/Cargo.toml, scripts/verify*
# トリガ後の処理:
#   1. アプリを quit
#   2. npm run build (next out/)
#   3. tauri build --bundles app --debug
#   4. /Applications/KAIKEI LOCAL.app に差し替え + 署名
#   5. open
#   6. scripts/verify-app.sh smoke-report → /tmp に保存
#   7. パスを stdout に出して、次の変更を待つ
#
# fswatch があれば使う (Brew install fswatch)、なければ 2 秒間隔ポーリング fallback。
cmd_watch() {
  local repo_root
  repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
  cd "$repo_root"

  echo "==> watch モード開始 (Ctrl+C で停止)"
  echo "    監視: src/ src-tauri/src/ scripts/verify*"

  do_rebuild() {
    echo ""
    echo "==> 変更検知 — 再ビルド開始 ($(date '+%H:%M:%S'))"
    osascript -e 'quit app "KAIKEI LOCAL"' 2>/dev/null || true
    killall kaikei 2>/dev/null || true
    sleep 1
    if ! npm run build >/tmp/kaikei-watch-build.log 2>&1; then
      echo "  ✗ next build 失敗 — /tmp/kaikei-watch-build.log を確認"
      return 1
    fi
    if ! npx tauri build --bundles app --debug >/tmp/kaikei-watch-tauri.log 2>&1; then
      echo "  ✗ tauri build 失敗 — /tmp/kaikei-watch-tauri.log を確認"
      return 1
    fi
    rm -rf "/Applications/KAIKEI LOCAL.app"
    cp -R "src-tauri/target/debug/bundle/macos/KAIKEI LOCAL.app" /Applications/
    codesign --force --deep --sign - \
      --entitlements src-tauri/entitlements.plist --options runtime \
      "/Applications/KAIKEI LOCAL.app" >/dev/null 2>&1 || true
    open "/Applications/KAIKEI LOCAL.app"
    sleep 5
    local report
    report=$(cmd_smoke_report 2>/dev/null) || report=""
    echo "  ✓ ビルド成功 / smoke-report: $report"
  }

  # 初回 1 回ビルド
  do_rebuild || true

  if command -v fswatch >/dev/null 2>&1; then
    echo "    (fswatch でリアルタイム監視中)"
    # -1 を付けず連続監視。0.8s デバウンス相当の集約のため -l 0.8 を使う
    fswatch -l 0.8 -o src src-tauri/src scripts | while read -r _; do
      do_rebuild || true
    done
  else
    echo "    (fswatch なし — 2 秒間隔ポーリング fallback)"
    local last_sig=""
    while true; do
      local sig
      sig=$(find src src-tauri/src scripts -type f \
        \( -name '*.ts' -o -name '*.tsx' -o -name '*.rs' -o -name '*.toml' -o -name '*.sh' -o -name '*.applescript' \) \
        -newer /tmp/.kaikei-watch-marker 2>/dev/null | sort | sha256sum 2>/dev/null | awk '{print $1}')
      if [ -z "$last_sig" ]; then
        last_sig="$sig"
        touch /tmp/.kaikei-watch-marker
      elif [ "$sig" != "$last_sig" ]; then
        last_sig="$sig"
        touch /tmp/.kaikei-watch-marker
        do_rebuild || true
      fi
      sleep 2
    done
  fi
}

# Round 11 ㉨ — smoke-report の HTML 版。
# Markdown だと file:// 参照が GitHub プレビュー等で表示されない問題があるので、
# data-uri (base64 PNG) で画像を直接埋め込む単一ファイル HTML を吐く。
# 出力: /tmp/kaikei-verify-<UTC>.html (Markdown と同時に)
cmd_smoke_report_html() {
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local out="${1:-/tmp/kaikei-verify-${ts}.html}"
  local app_ver
  app_ver=$(awk -F'"' '/"version"[[:space:]]*:/ {print $4; exit}' "$SCRIPT_DIR/../src-tauri/tauri.conf.json" 2>/dev/null || echo "?")

  # 4 画面のスクショを撮る (smoke-report と同じ流れ)
  local shot_dashboard shot_inbox shot_journals shot_logs
  cmd_navigate "/dashboard" >/dev/null 2>&1 || true
  shot_dashboard=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-dashboard.png" 2>/dev/null) || shot_dashboard=""
  cmd_navigate "/inbox" >/dev/null 2>&1 || true
  shot_inbox=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-inbox.png" 2>/dev/null) || shot_inbox=""
  cmd_navigate "/journals" >/dev/null 2>&1 || true
  shot_journals=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-journals.png" 2>/dev/null) || shot_journals=""
  cmd_navigate "/settings/ai-ocr-log" >/dev/null 2>&1 || true
  shot_logs=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-ai-ocr-log.png" 2>/dev/null) || shot_logs=""

  local scan_json inbox_summary log_lines app_errors
  scan_json=$(cmd_simulate_scan 2>&1 || true)
  log_lines=$(cmd_tail_log 20 2>/dev/null || true)
  app_errors=$(ERRORS_ONLY=1 cmd_app_log 30 2>/dev/null || true)
  inbox_summary=$(cmd_db_dump photo_inbox 2>/dev/null | python3 -c "
import json,sys
try:
  rows = json.load(sys.stdin)
except Exception:
  rows = []
print(f'<li>行数: {len(rows)}</li>')
buckets = {}
for r in rows:
  s = r.get('state', '?')
  buckets[s] = buckets.get(s, 0) + 1
for k in sorted(buckets):
  print(f'<li>{k}: {buckets[k]}</li>')
" 2>/dev/null || echo "<li>(parse 失敗)</li>")

  # PNG → base64 data-uri 化
  img_data_uri() {
    local p="$1"
    if [ -z "$p" ] || [ ! -f "$p" ]; then echo ""; return; fi
    local b64
    b64=$(base64 -i "$p" 2>/dev/null || base64 < "$p" 2>/dev/null || echo "")
    [ -n "$b64" ] && echo "data:image/png;base64,${b64//$'\n'/}"
  }
  local du_dashboard du_inbox du_journals du_logs
  du_dashboard=$(img_data_uri "$shot_dashboard")
  du_inbox=$(img_data_uri "$shot_inbox")
  du_journals=$(img_data_uri "$shot_journals")
  du_logs=$(img_data_uri "$shot_logs")

  # HTML 出力 — シングルファイル (CSS インライン、画像 data-uri)
  {
    cat <<HTML
<!doctype html>
<html lang="ja"><head><meta charset="utf-8"/>
<title>KAIKEI LOCAL — 検証レポート $ts</title>
<style>
  body { font-family: -apple-system,BlinkMacSystemFont,sans-serif; max-width:960px; margin:24px auto; padding:0 16px; color:#111; }
  h1 { font-size:24px; }
  h2 { font-size:18px; margin-top:32px; padding-bottom:6px; border-bottom:1px solid #e5e5e5; }
  h3 { font-size:14px; margin-top:18px; color:#444; }
  pre { background:#f6f7f9; padding:12px; border-radius:6px; font-size:11px; white-space:pre-wrap; max-height:300px; overflow:auto; }
  ul { padding-left: 1.4em; }
  img { max-width:100%; border:1px solid #e5e5e5; border-radius:6px; margin:8px 0; }
  .meta { color:#666; font-size:12px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .checklist li { margin:4px 0; }
</style>
</head><body>
<h1>KAIKEI LOCAL — 検証レポート</h1>
<p class="meta">生成日時 (UTC): $ts &middot; アプリバージョン: v$app_ver &middot; ホスト: $(uname -srm)</p>

<h2>simulate-scan</h2>
<pre>$(printf '%s' "$scan_json" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')</pre>

<h2>photo_inbox サマリー</h2>
<ul>
$inbox_summary
</ul>

<h2>scan.log 末尾 20 行</h2>
<pre>$(printf '%s' "$log_lines" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')</pre>
HTML
    if [ -n "$app_errors" ]; then
      echo "<h2>アプリ本体ログの WARN/ERR</h2>"
      echo "<pre>$(printf '%s' "$app_errors" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')</pre>"
    fi
    cat <<HTML
<h2>UI スクリーンショット (4 画面)</h2>
<div class="grid">
HTML
    for pair in \
      "ダッシュボード:$du_dashboard" \
      "受信箱:$du_inbox" \
      "仕訳帳:$du_journals" \
      "AI OCR ログ:$du_logs" ; do
      label="${pair%%:*}"
      uri="${pair#*:}"
      if [ -n "$uri" ]; then
        echo "  <div><h3>$label</h3><img src=\"$uri\" alt=\"$label\"/></div>"
      fi
    done
    cat <<HTML
</div>

<h2>LLM レビュー欄</h2>
<ul class="checklist">
  <li>[ ] 致命的 UI 異常: なし / あり (詳細)</li>
  <li>[ ] 新機能の表示確認: <em>(該当する場合の所見)</em></li>
  <li>[ ] ログに新規エラー: なし / あり (詳細)</li>
  <li>[ ] 全体所見: </li>
</ul>

<hr/>
<p class="meta"><em>このレポートは <code>scripts/verify-app.sh smoke-report-html</code> で生成されました</em></p>
</body></html>
HTML
  } > "$out"

  echo "$out"
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
# Round 4 で導入、Round 7 ㊓ で複数ページのスクショに拡張。
# ラウンド完了時に「最後の検証はこういう状態だった」を残してユーザに引き継ぎ
# やすくするため。
# Round 10 ㉤ — 主要 UI フロー (ダッシュボード → 受信箱 → 仕訳帳 → 設定)
# を navigate + screencapture で連続キャプチャし、ffmpeg で MP4 にまとめる。
#
# 出力: /tmp/kaikei-demo-<UTC>.mp4 (1 fps × 各画面 4 秒 = 16 秒程度)
# 用途: リリース前のスモークデモを動画 1 個でユーザーに渡せる。
#
# ffmpeg が無ければ警告して終了。screencapture は標準。
cmd_demo() {
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "ERROR: ffmpeg がインストールされていません — \`brew install ffmpeg\`"
    return 1
  fi
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local out="${1:-/tmp/kaikei-demo-${ts}.mp4}"
  local frame_dir
  frame_dir=$(mktemp -d -t kaikei-demo-XXXXXX)
  echo "==> demo 録画開始 (frames: $frame_dir)"

  # 各シーンで 4 frame (= 4 秒@1fps) を取る
  local frame_no=0
  capture_scene() {
    local route="$1"
    local label="$2"
    cmd_navigate "$route" >/dev/null 2>&1 || true
    sleep 1.2  # NavigateBridge の poll 周期 + render
    for _ in 1 2 3 4; do
      frame_no=$((frame_no + 1))
      local fname
      fname=$(printf "%s/frame-%04d.png" "$frame_dir" "$frame_no")
      cmd_ui_screenshot "$fname" >/dev/null 2>&1 || true
      sleep 1
    done
    echo "  ✓ $label ($route)"
  }

  capture_scene "/dashboard" "ダッシュボード"
  capture_scene "/inbox" "受信箱"
  capture_scene "/journals" "仕訳帳"
  capture_scene "/settings/ai-ocr-log" "AI OCR ログ"

  echo "==> ffmpeg で MP4 化"
  ffmpeg -y -framerate 1 \
    -i "$frame_dir/frame-%04d.png" \
    -c:v libx264 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
    "$out" 2>&1 | tail -3

  rm -rf "$frame_dir"
  echo "$out"
}

cmd_smoke_report() {
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local out="${1:-/tmp/kaikei-verify-${ts}.md}"
  local app_ver
  app_ver=$(awk -F'"' '/"version"[[:space:]]*:/ {print $4; exit}' "$SCRIPT_DIR/../src-tauri/tauri.conf.json" 2>/dev/null || echo "?")

  # ㊓ Round 7: 複数ページのスクショを取って Markdown に並べる。
  # navigate を使ってアプリ内 SPA ナビゲーション → 1.5 秒待ってスクショ。
  local shot_dashboard shot_inbox shot_journals shot_logs
  cmd_navigate "/dashboard" >/dev/null 2>&1 || true
  shot_dashboard=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-dashboard.png" 2>/dev/null) || shot_dashboard=""
  cmd_navigate "/inbox" >/dev/null 2>&1 || true
  shot_inbox=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-inbox.png" 2>/dev/null) || shot_inbox=""
  cmd_navigate "/journals" >/dev/null 2>&1 || true
  shot_journals=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-journals.png" 2>/dev/null) || shot_journals=""
  cmd_navigate "/settings/ai-ocr-log" >/dev/null 2>&1 || true
  shot_logs=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-ai-ocr-log.png" 2>/dev/null) || shot_logs=""

  local scan_json inbox_json log_lines app_errors
  scan_json=$(cmd_simulate_scan 2>&1 || true)
  inbox_json=$(cmd_db_dump photo_inbox 2>/dev/null || echo "[]")
  log_lines=$(cmd_tail_log 20 2>/dev/null || true)
  # ㊘ Round 8: アプリ本体ログから WARN/ERR 行のみを 30 行抽出
  app_errors=$(ERRORS_ONLY=1 cmd_app_log 30 2>/dev/null || true)

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
    if [ -n "$app_errors" ]; then
      echo "## アプリ本体ログの WARN/ERR (㊘ webview console.error 含む)"
      echo ""
      echo '```'
      echo "$app_errors"
      echo '```'
      echo ""
    fi
    echo "## UI スクリーンショット (㊓ 複数ページ)"
    echo ""
    for pair in \
      "ダッシュボード:$shot_dashboard" \
      "受信箱:$shot_inbox" \
      "仕訳帳:$shot_journals" \
      "AI OCR ログ:$shot_logs" ; do
      label="${pair%%:*}"
      path="${pair#*:}"
      if [ -n "$path" ]; then
        echo "### $label"
        echo ""
        echo "ファイル: \`$path\`"
        if command -v file >/dev/null 2>&1 && [ -f "$path" ]; then
          # Markdown 画像埋込: file:// URL で参照 (ローカル MD ビューアなら表示可)
          echo ""
          echo "![${label}](file://${path})"
        fi
        echo ""
      fi
    done
    # ㉣ Round 10: LLM (Claude チャット) が後から見て評価する欄をテンプレ
    # として用意。レポート単体ではここは空のまま、チャットの Claude が
    # 「このスクショ群を見て UI が壊れていないか」を評価して埋める。
    echo "## LLM レビュー欄 (㉣)"
    echo ""
    echo "<!-- このセクションは Claude チャット側で埋める想定。"
    echo "     スクショ群とログを基に "
    echo "       1) 致命的な UI 異常 (空白画面 / クラッシュ / レンダー乱れ) があるか"
    echo "       2) 直近ラウンドの新機能 (Round N の主要 PR) がスクショに映っているか"
    echo "       3) アプリ本体ログ (WARN/ERR) に新規エラーが増えていないか"
    echo "     を 3〜5 行でコメント -->"
    echo ""
    echo "- [ ] 致命的 UI 異常: なし / あり (詳細)"
    echo "- [ ] 新機能の表示確認: <該当する場合の所見>"
    echo "- [ ] ログに新規エラー: なし / あり (詳細)"
    echo "- [ ] 全体所見: "
    echo ""
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
    app-log|errors)            cmd_app_log "$@" ;;
    activate)                  cmd_activate ;;
    navigate|nav)              cmd_navigate "$@" ;;
    smoke)                     cmd_smoke ;;
    smoke-report|report)       cmd_smoke_report "$@" ;;
    smoke-report-html|html)    cmd_smoke_report_html "$@" ;;
    watch)                     cmd_watch ;;
    demo|video)                cmd_demo "$@" ;;
    help|-h|--help)            usage ;;
    *) echo "unknown subcommand: $sub" >&2; usage; exit 2 ;;
  esac
}

main "$@"
