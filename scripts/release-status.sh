#!/usr/bin/env bash
# ============================================================
# scripts/release-status.sh
#
# Round 15 ㉹: リリース動線の総合状況ダッシュボード。
# 「v0.3.0 を打つ前に何が揃ってて何が足りないか」を 1 コマンドで一覧。
#
# 表示項目:
#   1. ローカル/リモート git の同期状況 (ahead/behind)
#   2. ローカル既存 git tag (最新 5 つ)
#   3. GitHub Release 一覧 (最新 5 つ + isLatest 表示)
#   4. CHANGELOG.md の最新エントリ (バージョン抽出)
#   5. tauri.conf.json / package.json / Cargo.toml の version 一致確認
#   6. APPLE 認証情報の有無 (Setup 済み / 未設定)
#   7. 次に打てる候補バージョン (major/minor/patch bump 提案)
#   8. リリース打つコマンド一覧 (UNSIGNED / NOTARIZE_SKIP / 公証付き)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PASS_COLOR="\033[32m"
FAIL_COLOR="\033[31m"
WARN_COLOR="\033[33m"
DIM_COLOR="\033[2m"
RESET="\033[0m"
ok()   { printf "  ${PASS_COLOR}✓${RESET} %s\n" "$1"; }
fail() { printf "  ${FAIL_COLOR}✗${RESET} %s\n" "$1"; }
warn() { printf "  ${WARN_COLOR}!${RESET} %s\n" "$1"; }
dim()  { printf "  ${DIM_COLOR}%s${RESET}\n" "$1"; }

echo ""
echo "==> 1. git 同期"
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
git fetch origin >/dev/null 2>&1 || true
AHEAD=$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo "0")
BEHIND=$(git rev-list --count "HEAD..@{u}" 2>/dev/null || echo "0")
ok "branch: $CURRENT_BRANCH"
if [ "$AHEAD" -eq 0 ] && [ "$BEHIND" -eq 0 ]; then
  ok "リモートと同期済み"
elif [ "$BEHIND" -gt 0 ]; then
  fail "ローカルがリモートより $BEHIND コミット遅れ — git pull が必要"
elif [ "$AHEAD" -gt 0 ]; then
  warn "ローカルがリモートより $AHEAD コミット進んでいる (release.sh が自動 push)"
fi

echo ""
echo "==> 2. ローカル既存 tag (新しい順 5 件)"
LOCAL_TAGS=$(git tag --sort=-creatordate | head -5)
if [ -z "$LOCAL_TAGS" ]; then
  dim "(なし)"
else
  echo "$LOCAL_TAGS" | sed 's/^/  /'
fi

echo ""
echo "==> 3. GitHub Releases (最新 5 件)"
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  RELEASES=$(gh release list --limit 5 2>/dev/null || true)
  LATEST_TAG=$(gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/latest" -q .tag_name 2>/dev/null || echo "")
  if [ -z "$RELEASES" ]; then
    dim "(なし)"
  else
    while IFS= read -r line; do
      printf "  %s\n" "$line"
    done <<< "$RELEASES"
  fi
  if [ -n "$LATEST_TAG" ]; then
    ok "/releases/latest = $LATEST_TAG"
  fi
else
  warn "gh が未認証 — gh auth login で設定してください"
fi

echo ""
echo "==> 4. CHANGELOG.md の最新エントリ"
if [ -f CHANGELOG.md ]; then
  TOP_VERSION=$(grep -m 1 -E "^## v?[0-9]" CHANGELOG.md 2>/dev/null || true)
  if [ -n "$TOP_VERSION" ]; then
    ok "最新セクション: $TOP_VERSION"
  else
    warn "バージョンセクション (## v...) が見つかりません"
  fi
else
  warn "CHANGELOG.md が存在しません"
fi

echo ""
echo "==> 5. version 一致確認 (tauri.conf.json / package.json / Cargo.toml)"
TAURI_VER=$(awk -F'"' '/"version"[[:space:]]*:/ {print $4; exit}' src-tauri/tauri.conf.json 2>/dev/null || echo "?")
PKG_VER=$(awk -F'"' '/"version"[[:space:]]*:/ {print $4; exit}' package.json 2>/dev/null || echo "?")
CARGO_VER=$(grep -m 1 '^version =' src-tauri/Cargo.toml 2>/dev/null | awk -F'"' '{print $2}' || echo "?")
echo "  tauri.conf.json : $TAURI_VER"
echo "  package.json    : $PKG_VER"
echo "  src-tauri/Cargo : $CARGO_VER"
if [ "$TAURI_VER" = "$PKG_VER" ] && [ "$PKG_VER" = "$CARGO_VER" ]; then
  ok "全部一致"
else
  fail "バージョン不一致 — 3 ファイル全部を bump してください"
fi

echo ""
echo "==> 6. APPLE 認証情報"
HAS_ENV_FILE=0
if [ -f "$HOME/.kaikei-release.env" ]; then
  HAS_ENV_FILE=1
  ok "~/.kaikei-release.env あり (release.sh が自動 source)"
else
  warn "~/.kaikei-release.env なし — scripts/release-setup-credentials.sh を実行"
fi
if security find-identity -v -p codesigning 2>/dev/null | grep -qF "Developer ID Application"; then
  ok "Developer ID Application 証明書 (keychain)"
else
  fail "Developer ID Application 証明書なし — Apple Developer 登録 + Xcode で作成"
fi
if xcrun notarytool history --keychain-profile "AC_PASSWORD" >/dev/null 2>&1; then
  ok "notarytool profile (AC_PASSWORD) あり"
else
  warn "notarytool profile なし — release-setup-credentials.sh が作成"
fi

echo ""
echo "==> 7. 次に打てる候補バージョン"
if [ "$TAURI_VER" != "?" ]; then
  IFS='.' read -r MAJ MIN PAT <<< "$TAURI_VER"
  echo "  現在: $TAURI_VER"
  echo "  patch bump: $MAJ.$MIN.$((PAT + 1))"
  echo "  minor bump: $MAJ.$((MIN + 1)).0"
  echo "  major bump: $((MAJ + 1)).0.0"
fi

echo ""
echo "==> 8. リリースを打つコマンド"
if [ "$HAS_ENV_FILE" -eq 1 ]; then
  echo "  公証付き  : scripts/release.sh v$TAURI_VER"
else
  echo "  公証付き  : scripts/release-setup-credentials.sh"
  echo "             scripts/release.sh v$TAURI_VER"
fi
echo "  公証 skip : NOTARIZE_SKIP=1 scripts/release.sh v$TAURI_VER"
echo "  未署名    : UNSIGNED=1 scripts/release.sh v$TAURI_VER"
echo "  dry-run   : DRY_RUN=1 scripts/release.sh v$TAURI_VER"
echo ""
echo "  健康診断: scripts/verify-release.sh v$TAURI_VER"
echo "  取り消し: scripts/release-rollback.sh v$TAURI_VER"
