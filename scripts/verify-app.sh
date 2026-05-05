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
#   simulate-action <name>   起動中アプリで allowlist された action を発火
#                            (scan-now / journalize-all-receipts / open-help)
#   demo-scenario            /inbox → scan-now → スクショの典型シナリオを実行
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
#   autorun [<msg>]          AUTOPUSH=1 必須。ビルド → smoke-report → commit
#                            + push まで自動。main ブランチでは不可
#   doctor [--fix]           verify-app.sh が動かない時の自己診断
#                            (KAIKEI_BIN / 必須コマンド / DB / ログ / 起動状態)
#                            --fix で「アプリ起動」「brew install (要 BREW_INSTALL=1)」
#                            等の自動修復を試行
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

# ㊇ Round 17: 起動中アプリの allowlist された action を発火する
# (例: simulate-action scan-now)
cmd_simulate_action() {
  require_bin
  local action="${1:?action 名を指定}"
  "$KAIKEI_BIN" --simulate-action="$action"
  cmd_activate
  sleep 1.5
}

# ㊇ Round 17: navigate + action + sleep を組合せた典型シナリオ。
# /inbox に飛んで「今すぐスキャン」を発火し、4 秒後にスクショを撮る。
# demo 動画の素材生成に使う。
cmd_demo_scenario() {
  cmd_navigate "/inbox"
  cmd_simulate_action "scan-now"
  sleep 4
  local out
  out=$(cmd_ui_screenshot "/tmp/kaikei-demo-scenario-$(date -u +%Y%m%dT%H%M%SZ).png")
  echo "$out"
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
  # ㊆ Round 17: git のメタも HTML レポートに埋込み (どの commit のレポートか追跡可能)
  local git_sha git_branch git_subject git_dirty
  git_sha=$(cd "$SCRIPT_DIR/.." && git rev-parse --short HEAD 2>/dev/null || echo "?")
  git_branch=$(cd "$SCRIPT_DIR/.." && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  git_subject=$(cd "$SCRIPT_DIR/.." && git log -1 --format=%s 2>/dev/null || echo "?")
  if cd "$SCRIPT_DIR/.." && ! git diff-index --quiet HEAD -- 2>/dev/null; then
    git_dirty="(dirty: 未 commit の変更あり)"
  else
    git_dirty=""
  fi

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
<p class="meta">
  生成日時 (UTC): $ts &middot; アプリバージョン: v$app_ver &middot; ホスト: $(uname -srm)
</p>
<p class="meta">
  git: <code>$git_sha</code> on <code>$git_branch</code> $git_dirty<br>
  最新 commit: <em>$(printf '%s' "$git_subject" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')</em>
</p>

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

# Round 13 ㉳ — autorun: ビルド → smoke-report → 成功なら git commit + push
#
# Claude が PDCA を「人手介入なしで 1 ラウンド」走らせる時の自走モード。
#
# 安全策:
#   - 必ず main 以外のブランチで実行 (current branch != main)
#   - 環境変数 AUTOPUSH=1 が必須 (うっかり起動防止)
#   - コミットメッセージは引数 or "PDCA autorun: <ts>" を default
#   - smoke-report の生成に成功した時のみ commit + push
#
# 使い方:
#   AUTOPUSH=1 scripts/verify-app.sh autorun "Round 13 自動コミット"
cmd_autorun() {
  if [ "${AUTOPUSH:-}" != "1" ]; then
    echo "ERROR: AUTOPUSH=1 が必要です (うっかり起動防止)"
    return 2
  fi
  local repo_root current_branch
  repo_root="$(cd "$SCRIPT_DIR/.." && pwd)"
  cd "$repo_root"
  current_branch=$(git rev-parse --abbrev-ref HEAD)
  if [ "$current_branch" = "main" ]; then
    echo "ERROR: main ブランチでは autorun を実行できません (別ブランチで作業してください)"
    return 2
  fi
  if git diff-index --quiet HEAD --; then
    echo "ERROR: コミット対象の変更がありません"
    return 2
  fi

  local msg="${1:-PDCA autorun: $(date -u +%Y%m%dT%H%M%SZ)}"
  echo "==> 1. ビルドと再差し替え"
  osascript -e 'quit app "KAIKEI LOCAL"' 2>/dev/null || true
  killall kaikei 2>/dev/null || true
  sleep 1
  if ! npm run build >/tmp/kaikei-autorun-build.log 2>&1; then
    echo "  ✗ next build 失敗"; return 1
  fi
  if ! npx tauri build --bundles app --debug >/tmp/kaikei-autorun-tauri.log 2>&1; then
    echo "  ✗ tauri build 失敗"; return 1
  fi
  rm -rf "/Applications/KAIKEI LOCAL.app"
  cp -R "src-tauri/target/debug/bundle/macos/KAIKEI LOCAL.app" /Applications/
  codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist \
    --options runtime "/Applications/KAIKEI LOCAL.app" >/dev/null 2>&1 || true
  open "/Applications/KAIKEI LOCAL.app"
  sleep 5
  echo "==> 2. smoke-report 生成"
  local report
  report=$(cmd_smoke_report 2>/dev/null) || true
  if [ -z "$report" ] || [ ! -f "$report" ]; then
    echo "  ✗ smoke-report 失敗"; return 1
  fi
  echo "  ✓ $report"

  echo "==> 3. git commit + push"
  git add -A
  git commit -m "$msg" || true
  git push origin "$current_branch"
  echo "  ✓ pushed to origin/$current_branch"
}

# Round 16 ㊂ — doctor --fix: 自動で直せる項目を試みる。
# 現状サポート:
#   - KAIKEI LOCAL.app が起動していなければ open
#   - kaikei.db 不在 → アプリ起動を待つ (open + sleep 6 + 再検査)
#   - fswatch / ffmpeg 未インストール → brew install (BREW_INSTALL=1 が必要)
cmd_doctor_fix() {
  local PC="\033[32m" FC="\033[31m" WC="\033[33m" RC="\033[0m"
  echo ""
  echo "==> doctor --fix (自動修復試行)"

  # 1. アプリが起動していなければ open
  if ! pgrep -f "KAIKEI LOCAL" >/dev/null; then
    if [ -d "/Applications/KAIKEI LOCAL.app" ]; then
      printf "  ${WC}!${RC} アプリ未起動 → open します\n"
      open "/Applications/KAIKEI LOCAL.app"
      sleep 5
      if pgrep -f "KAIKEI LOCAL" >/dev/null; then
        printf "  ${PC}✓${RC} 起動成功\n"
      else
        printf "  ${FC}✗${RC} 起動できませんでした\n"
      fi
    else
      printf "  ${FC}✗${RC} /Applications/KAIKEI LOCAL.app がありません — まずビルドして配置してください\n"
    fi
  fi

  # 2. オプションコマンドの brew install (明示 opt-in 必須)
  if [ -n "${BREW_INSTALL:-}" ] && command -v brew >/dev/null 2>&1; then
    for c in fswatch ffmpeg; do
      if ! command -v "$c" >/dev/null 2>&1; then
        printf "  ${WC}!${RC} brew install %s ...\n" "$c"
        brew install "$c" >/dev/null 2>&1 \
          && printf "  ${PC}✓${RC} %s OK\n" "$c" \
          || printf "  ${FC}✗${RC} %s 失敗\n" "$c"
      fi
    done
  elif [ -z "${BREW_INSTALL:-}" ]; then
    printf "  ${WC}!${RC} BREW_INSTALL=1 を付けると fswatch / ffmpeg を自動 brew install します\n"
  fi

  # ㊌ Round 18: データ整合性 (photo_inbox / receipts の orphan) を削除確認付きで除去
  echo ""
  echo "==> 3. データ整合性の orphan 削除"
  local app_data="$HOME/Library/Application Support/dev.kaikei.app"
  if [ -f "$app_data/kaikei.db" ]; then
    local orphans
    orphans=$(sqlite3 "$app_data/kaikei.db" \
      "SELECT id || '|' || COALESCE(file_path,'') FROM photo_inbox WHERE file_path IS NOT NULL" 2>/dev/null \
      | while IFS='|' read -r id path; do
          if [ -n "$path" ] && [ ! -f "$path" ]; then
            echo "$id"
          fi
        done)
    local orphan_count
    orphan_count=$(echo -n "$orphans" | grep -c '^.' || true)

    local receipt_orphans
    receipt_orphans=$(sqlite3 "$app_data/kaikei.db" \
      "SELECT id || '|' || COALESCE(image_url,'') FROM receipts WHERE image_url LIKE 'file://%'" 2>/dev/null \
      | while IFS='|' read -r id url; do
          local rpath="${url#file://}"
          if [ -n "$rpath" ] && [ ! -f "$rpath" ]; then
            echo "$id"
          fi
        done)
    local receipt_orphan_count
    receipt_orphan_count=$(echo -n "$receipt_orphans" | grep -c '^.' || true)

    if [ "$orphan_count" -eq 0 ] && [ "$receipt_orphan_count" -eq 0 ]; then
      printf "  ${PC}✓${RC} orphan なし\n"
    else
      [ "$orphan_count" -gt 0 ] && printf "  ${WC}!${RC} photo_inbox orphan: $orphan_count 件\n"
      [ "$receipt_orphan_count" -gt 0 ] && printf "  ${WC}!${RC} receipts orphan: $receipt_orphan_count 件\n"
      if [ -t 0 ]; then
        read -r -p "  これらを削除しますか? [y/N] " ans
        case "$ans" in
          [yY]|[yY][eE][sS])
            if [ "$orphan_count" -gt 0 ]; then
              echo "$orphans" | while read -r id; do
                [ -n "$id" ] && sqlite3 "$app_data/kaikei.db" \
                  "DELETE FROM photo_inbox WHERE id='$id'" 2>/dev/null || true
              done
              printf "  ${PC}✓${RC} photo_inbox $orphan_count 件削除\n"
            fi
            if [ "$receipt_orphan_count" -gt 0 ]; then
              echo "$receipt_orphans" | while read -r id; do
                [ -n "$id" ] && sqlite3 "$app_data/kaikei.db" \
                  "DELETE FROM receipts WHERE id='$id'" 2>/dev/null || true
              done
              printf "  ${PC}✓${RC} receipts $receipt_orphan_count 件削除\n"
            fi
            ;;
          *) printf "  ${WC}!${RC} 削除を中止\n" ;;
        esac
      else
        printf "  ${WC}!${RC} 非対話シェル: 自動削除しません\n"
      fi
    fi
  else
    printf "  ${WC}!${RC} kaikei.db なし — skip\n"
  fi

  echo ""
  echo "==> 自動修復後の再検査:"
  cmd_doctor
}

# Round 15 ㉼ — 自己診断: verify-app.sh が動かないと言われた時に最初に叩く。
# 期待: 全部 ✓ ならスクリプト各サブコマンドが動く前提が揃っている。
cmd_doctor() {
  local pass=0 fail=0 warn=0
  local PC="\033[32m" FC="\033[31m" WC="\033[33m" RC="\033[0m"
  ok()   { printf "  ${PC}✓${RC} %s\n" "$1"; pass=$((pass+1)); }
  bad()  { printf "  ${FC}✗${RC} %s\n" "$1"; fail=$((fail+1)); }
  yel()  { printf "  ${WC}!${RC} %s\n" "$1"; warn=$((warn+1)); }

  echo ""
  echo "==> 1. KAIKEI_BIN"
  if [ -x "$KAIKEI_BIN" ]; then
    ok "KAIKEI_BIN: $KAIKEI_BIN"
    local ver
    ver=$("$KAIKEI_BIN" --verify-help 2>/dev/null | head -1 || echo "?")
    ok "  → $ver"
  else
    bad "KAIKEI_BIN 不在: $KAIKEI_BIN"
    bad "  → CLAUDE.md のデプロイコマンドで /Applications に差し替えてください"
  fi

  echo ""
  echo "==> 2. 必須コマンド"
  for c in osascript screencapture python3 sqlite3 curl; do
    if command -v "$c" >/dev/null 2>&1; then
      ok "$c"
    else
      bad "$c が PATH にありません"
    fi
  done

  echo ""
  echo "==> 3. オプションコマンド"
  for c in fswatch ffmpeg; do
    if command -v "$c" >/dev/null 2>&1; then
      ok "$c (PATH: $(command -v "$c"))"
    else
      yel "$c なし (\`brew install $c\` で導入推奨)"
    fi
  done

  echo ""
  echo "==> 4. app data dir"
  local app_data="$HOME/Library/Application Support/dev.kaikei.app"
  if [ -d "$app_data" ]; then
    ok "$app_data"
    if [ -f "$app_data/kaikei.db" ]; then
      local size
      size=$(du -h "$app_data/kaikei.db" | awk '{print $1}')
      ok "  kaikei.db ($size)"
      # _sqlx_migrations の件数
      local n
      n=$(sqlite3 "$app_data/kaikei.db" "SELECT COUNT(*) FROM _sqlx_migrations" 2>/dev/null || echo "?")
      ok "  _sqlx_migrations: $n 件"
    else
      yel "kaikei.db なし — まずアプリを 1 度起動してください"
    fi
    if [ -d "$app_data/inbox" ]; then
      local n
      n=$(find "$app_data/inbox" -maxdepth 1 -type f \( -name "*.jpg" -o -name "*.png" \) 2>/dev/null | wc -l | tr -d ' ')
      ok "  inbox/ ($n 枚)"
    else
      yel "inbox/ なし"
    fi
  else
    bad "$app_data が存在しません — アプリを起動してください"
  fi

  echo ""
  echo "==> 5. ログディレクトリ"
  local logs="$HOME/Library/Logs/dev.kaikei.app"
  local scan_log_dir="$HOME/Library/Logs/KAIKEI LOCAL"
  if [ -d "$logs" ]; then
    ok "$logs"
  else
    yel "$logs なし"
  fi
  if [ -d "$scan_log_dir" ]; then
    ok "$scan_log_dir"
  else
    yel "$scan_log_dir なし (まだ scanner が動いてない)"
  fi

  echo ""
  echo "==> 6. アプリ起動状態 (process check)"
  if pgrep -f "KAIKEI LOCAL" >/dev/null; then
    ok "KAIKEI LOCAL.app が実行中 (navigate / ui-screenshot が使える)"
  else
    yel "KAIKEI LOCAL.app は起動していない (まず open で起動してください)"
  fi

  echo ""
  echo "==> 7. screencapture 権限 (osascript の Accessibility)"
  # System Events 経由で簡易にプロセス一覧を取り、TCC 拒否を検知
  if osascript -e 'tell application "System Events" to count of processes' >/dev/null 2>&1; then
    ok "osascript / System Events: OK"
  else
    yel "System Events 拒否の可能性 — 設定 > プライバシー > オートメーション で許可"
  fi

  echo ""
  echo "==> 8. データ整合性チェック (㊌ Round 18)"
  local app_data="$HOME/Library/Application Support/dev.kaikei.app"
  if [ -f "$app_data/kaikei.db" ]; then
    # photo_inbox.file_path が指す JPG が消えてる行を探す
    local orphans
    orphans=$(sqlite3 "$app_data/kaikei.db" \
      "SELECT id || '|' || COALESCE(file_path,'') FROM photo_inbox WHERE file_path IS NOT NULL" 2>/dev/null \
      | while IFS='|' read -r id path; do
          if [ -n "$path" ] && [ ! -f "$path" ]; then
            echo "$id"
          fi
        done)
    local orphan_count
    orphan_count=$(echo -n "$orphans" | grep -c '^.' || true)

    # receipts.image_url が file:// で消えてるものを検出
    local receipt_orphans
    receipt_orphans=$(sqlite3 "$app_data/kaikei.db" \
      "SELECT id || '|' || COALESCE(image_url,'') FROM receipts WHERE image_url LIKE 'file://%'" 2>/dev/null \
      | while IFS='|' read -r id url; do
          local rpath="${url#file://}"
          if [ -n "$rpath" ] && [ ! -f "$rpath" ]; then
            echo "$id"
          fi
        done)
    local receipt_orphan_count
    receipt_orphan_count=$(echo -n "$receipt_orphans" | grep -c '^.' || true)

    if [ "$orphan_count" -eq 0 ] && [ "$receipt_orphan_count" -eq 0 ]; then
      ok "整合性: photo_inbox / receipts に orphan なし"
    else
      [ "$orphan_count" -gt 0 ] && yel "photo_inbox に orphan $orphan_count 件 (file_path が消えてる)"
      [ "$receipt_orphan_count" -gt 0 ] && yel "receipts に orphan $receipt_orphan_count 件 (image_url が消えてる)"
      yel "  → \`scripts/verify-app.sh doctor --fix\` で確認後に削除可能"
    fi
  else
    yel "kaikei.db なし — 整合性チェック skip"
  fi

  echo ""
  echo "============================================================"
  if [ "$fail" -eq 0 ]; then
    printf "${PC}OK${RC}: 致命エラー 0 件 / 警告 ${warn} 件\n"
    return 0
  else
    printf "${FC}NG${RC}: 致命エラー ${fail} 件 / 警告 ${warn} 件 — 上の ✗ を直してください\n"
    return 1
  fi
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
  # Round 12 ㉮: シーンタイトルを別途 metadata.tsv に記録 → 後で drawtext
  local frame_no=0
  : > "$frame_dir/labels.tsv" # frame_no \t label
  capture_scene() {
    local route="$1"
    local label="$2"
    cmd_navigate "$route" >/dev/null 2>&1 || true
    sleep 1.2
    for _ in 1 2 3 4; do
      frame_no=$((frame_no + 1))
      local fname
      fname=$(printf "%s/frame-%04d.png" "$frame_dir" "$frame_no")
      cmd_ui_screenshot "$fname" >/dev/null 2>&1 || true
      printf "%d\t%s\n" "$frame_no" "$label" >> "$frame_dir/labels.tsv"
      sleep 1
    done
    echo "  ✓ $label ($route)"
  }

  capture_scene "/dashboard" "ダッシュボード"
  capture_scene "/inbox" "受信箱"
  capture_scene "/journals" "仕訳帳"
  capture_scene "/settings/ai-ocr-log" "AI OCR ログ"

  # Round 12 ㉮: 各 frame ごとに drawtext でシーンタイトルを焼き込み
  # システムフォント (NotoSansCJK) を使う; 失敗したら無 overlay で MP4 化
  local font="/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"
  if [ ! -f "$font" ]; then
    font="/System/Library/Fonts/Helvetica.ttc"
  fi
  echo "==> 各フレームにラベル overlay (font: $(basename "$font"))"
  while IFS=$'\t' read -r fno label; do
    local src dst
    src=$(printf "%s/frame-%04d.png" "$frame_dir" "$fno")
    dst=$(printf "%s/labeled-%04d.png" "$frame_dir" "$fno")
    if [ ! -f "$src" ]; then continue; fi
    # 左下に半透明黒帯 + 白タイトル
    ffmpeg -y -loglevel error -i "$src" \
      -vf "drawbox=x=20:y=ih-90:w=420:h=60:color=black@0.55:t=fill,drawtext=fontfile='$font':text='$label':x=40:y=h-72:fontsize=32:fontcolor=white" \
      "$dst" >/dev/null 2>&1 || cp "$src" "$dst"
  done < "$frame_dir/labels.tsv"

  echo "==> ffmpeg で MP4 化"
  ffmpeg -y -framerate 1 \
    -i "$frame_dir/labeled-%04d.png" \
    -c:v libx264 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" \
    "$out" 2>&1 | tail -3

  rm -rf "$frame_dir"
  echo "$out"
}

cmd_smoke_report() {
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  local out="${1:-/tmp/kaikei-verify-${ts}.md}"
  local app_ver git_sha git_branch git_subject git_dirty
  app_ver=$(awk -F'"' '/"version"[[:space:]]*:/ {print $4; exit}' "$SCRIPT_DIR/../src-tauri/tauri.conf.json" 2>/dev/null || echo "?")
  # ㊆ Round 17: git メタも Markdown 版に
  git_sha=$(cd "$SCRIPT_DIR/.." && git rev-parse --short HEAD 2>/dev/null || echo "?")
  git_branch=$(cd "$SCRIPT_DIR/.." && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  git_subject=$(cd "$SCRIPT_DIR/.." && git log -1 --format=%s 2>/dev/null || echo "?")
  if cd "$SCRIPT_DIR/.." && ! git diff-index --quiet HEAD -- 2>/dev/null; then
    git_dirty=" (dirty)"
  else
    git_dirty=""
  fi

  # ㊓ Round 7: 複数ページのスクショを取って Markdown に並べる。
  # navigate を使ってアプリ内 SPA ナビゲーション → 1.5 秒待ってスクショ。
  # ㉸ Round 14: NO_GUI=1 (CI 等で GUI 起動不可) なら全部 skip
  local shot_dashboard shot_inbox shot_journals shot_logs
  if [ -z "${NO_GUI:-}" ]; then
    cmd_navigate "/dashboard" >/dev/null 2>&1 || true
    shot_dashboard=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-dashboard.png" 2>/dev/null) || shot_dashboard=""
    cmd_navigate "/inbox" >/dev/null 2>&1 || true
    shot_inbox=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-inbox.png" 2>/dev/null) || shot_inbox=""
    cmd_navigate "/journals" >/dev/null 2>&1 || true
    shot_journals=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-journals.png" 2>/dev/null) || shot_journals=""
    cmd_navigate "/settings/ai-ocr-log" >/dev/null 2>&1 || true
    shot_logs=$(cmd_ui_screenshot "/tmp/kaikei-verify-${ts}-ai-ocr-log.png" 2>/dev/null) || shot_logs=""
  fi

  local scan_json inbox_json log_lines app_errors
  if [ -n "${NO_GUI:-}" ]; then
    scan_json='{"skipped":"NO_GUI=1 のため simulate-scan は実行しない"}'
  else
    scan_json=$(cmd_simulate_scan 2>&1 || true)
  fi
  inbox_json=$(cmd_db_dump photo_inbox 2>/dev/null || echo "[]")
  log_lines=$(cmd_tail_log 20 2>/dev/null || true)
  # ㊘ Round 8: アプリ本体ログから WARN/ERR 行のみを 30 行抽出
  app_errors=$(ERRORS_ONLY=1 cmd_app_log 30 2>/dev/null || true)
  # ㉫ Round 12: 自動破棄理由 (auto_dismissed_reason) を集計してパターン上位を表示
  local autodismiss_summary
  autodismiss_summary=$(echo "$inbox_json" | python3 -c "
import json, sys, collections
try:
  rows = json.load(sys.stdin)
except Exception:
  rows = []
reasons = []
for r in rows:
  if r.get('state') != 'dismissed':
    continue
  raw = r.get('auto_dismissed_reason') or ''
  if not raw:
    continue
  try:
    j = json.loads(raw)
  except Exception:
    continue
  kws = j.get('matched_keywords') or []
  if kws:
    reasons.append(' / '.join(kws[:3]))
total = len(reasons)
if total == 0:
  print('(自動破棄された行はありません)')
else:
  c = collections.Counter(reasons)
  print(f'自動破棄 {total} 件のパターン上位:')
  for kw, cnt in c.most_common(5):
    print(f'  {cnt:>3}x  {kw}')
" 2>/dev/null || echo "(集計失敗)")

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
    echo "- git: \`$git_sha\` on \`$git_branch\`$git_dirty — _${git_subject}_"
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
    echo "## 自動破棄パターン上位 (㉫)"
    echo ""
    echo '```'
    echo "$autodismiss_summary"
    echo '```'
    echo ""
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
    simulate-action|action)    cmd_simulate_action "$@" ;;
    demo-scenario|scenario)    cmd_demo_scenario ;;
    smoke)                     cmd_smoke ;;
    smoke-report|report)       cmd_smoke_report "$@" ;;
    smoke-report-html|html)    cmd_smoke_report_html "$@" ;;
    watch)                     cmd_watch ;;
    demo|video)                cmd_demo "$@" ;;
    autorun)                   cmd_autorun "$@" ;;
    doctor)
      if [ "${1:-}" = "--fix" ]; then cmd_doctor_fix; else cmd_doctor; fi
      ;;
    help|-h|--help)            usage ;;
    *) echo "unknown subcommand: $sub" >&2; usage; exit 2 ;;
  esac
}

main "$@"
