#!/usr/bin/env bash
# ============================================================
# scripts/release-precheck.sh
#
# scripts/release.sh を叩く前に「いま打って大丈夫か?」を全項目検証する。
# Round 4 ㊀ で導入: 過去のラウンドで「APPLE_* 忘れて途中で止まる」
# 「リポジトリが汚れてる状態でリリースする」事故を防ぐための安全網。
#
# 失敗時は exit 1。検証だけが目的なので副作用はない (DMG 作成等しない)。
#
# 使い方:
#   scripts/release-precheck.sh              # 署名+公証モード前提でフル検査
#   UNSIGNED=1 scripts/release-precheck.sh   # 未署名モード前提 (env チェックは skip)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PASS_COLOR="\033[32m"
FAIL_COLOR="\033[31m"
WARN_COLOR="\033[33m"
RESET="\033[0m"

failures=0
warnings=0

pass() { printf "  ${PASS_COLOR}✓${RESET} %s\n" "$1"; }
fail() { printf "  ${FAIL_COLOR}✗${RESET} %s\n" "$1"; failures=$((failures+1)); }
warn() { printf "  ${WARN_COLOR}!${RESET} %s\n" "$1"; warnings=$((warnings+1)); }

echo ""
echo "==> 1. ホスト OS"
if [ "$(uname)" = "Darwin" ]; then
  pass "macOS ($(sw_vers -productVersion) / $(uname -m))"
else
  fail "macOS ではありません: $(uname)"
fi

echo ""
echo "==> 2. リポジトリの状態"
if git diff-index --quiet HEAD --; then
  pass "ワーキングツリーがクリーン (未コミット変更なし)"
else
  fail "未コミットの変更があります — release.sh を打つ前にコミット/stash して下さい"
fi
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" = "main" ]; then
  pass "ブランチ: main"
else
  warn "main 以外のブランチで作業中: $current_branch (意図的なら無視)"
fi

echo ""
echo "==> 3. バージョン情報"
PKG_VER=$(awk -F'"' '/"version"/ {print $4; exit}' package.json)
TAURI_VER=$(awk -F'"' '/"version"[[:space:]]*:/ {print $4; exit}' src-tauri/tauri.conf.json)
CARGO_VER=$(awk -F'"' '/^version[[:space:]]*=/ {print $2; exit}' src-tauri/Cargo.toml)
echo "  package.json:       $PKG_VER"
echo "  tauri.conf.json:    $TAURI_VER"
echo "  src-tauri/Cargo.toml: $CARGO_VER"
if [ "$PKG_VER" = "$TAURI_VER" ] && [ "$TAURI_VER" = "$CARGO_VER" ]; then
  pass "3 ファイルでバージョン一致"
else
  fail "バージョン不一致 — 揃えてからリリースして下さい"
fi

echo ""
echo "==> 4. ツールチェイン"
if command -v cargo >/dev/null 2>&1; then
  pass "cargo: $(cargo --version)"
else
  fail "cargo が見つかりません"
fi
if command -v node >/dev/null 2>&1; then
  pass "node: $(node --version)"
else
  fail "node が見つかりません"
fi
if command -v npm >/dev/null 2>&1; then
  pass "npm: $(npm --version)"
else
  fail "npm が見つかりません"
fi
if command -v gh >/dev/null 2>&1; then
  pass "gh: $(gh --version | head -1)"
else
  fail "gh (GitHub CLI) が見つかりません"
fi
if rustup target list --installed 2>/dev/null | grep -q "x86_64-apple-darwin"; then
  pass "Rust target x86_64-apple-darwin がインストール済み (Intel ビルド可)"
else
  warn "Rust target x86_64-apple-darwin が未インストール — \`rustup target add x86_64-apple-darwin\`"
fi

echo ""
echo "==> 5. GitHub 認証"
if gh auth status >/dev/null 2>&1; then
  pass "gh auth status OK"
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "?")
  echo "    repo: $REPO"
else
  fail "gh にログインしていません — \`gh auth login\` してください"
fi

echo ""
echo "==> 6. Apple 署名・公証 env"
if [ -n "${UNSIGNED:-}" ]; then
  warn "UNSIGNED=1 が指定されています — 未署名 DMG (Gatekeeper 警告あり) になります"
elif [ -n "${NOTARIZE_SKIP:-}" ]; then
  # 署名はするが公証はスキップ。APPLE_SIGNING_IDENTITY だけ必要
  warn "NOTARIZE_SKIP=1 が指定されています — 署名のみ (公証なし) DMG。配布前の動作確認用"
  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    pass "APPLE_SIGNING_IDENTITY: SET"
    if command -v security >/dev/null 2>&1 \
       && security find-identity -v -p codesigning 2>/dev/null | grep -qF "$APPLE_SIGNING_IDENTITY"; then
      pass "APPLE_SIGNING_IDENTITY が keychain に存在"
    else
      warn "APPLE_SIGNING_IDENTITY が keychain で見つかりません — 名前のタイポ?"
    fi
  else
    fail "APPLE_SIGNING_IDENTITY が UNSET です (NOTARIZE_SKIP でも署名は必要)"
  fi
else
  for v in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
    if [ -n "${!v:-}" ]; then
      if [ "$v" = "APPLE_PASSWORD" ]; then
        pass "$v: SET (hidden)"
      else
        pass "$v: SET"
      fi
    else
      fail "$v が UNSET です"
    fi
  done
  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && command -v security >/dev/null 2>&1; then
    if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$APPLE_SIGNING_IDENTITY"; then
      pass "APPLE_SIGNING_IDENTITY が keychain に存在"
    else
      warn "APPLE_SIGNING_IDENTITY が keychain で見つかりません — 名前のタイポ?"
    fi
  fi
fi

echo ""
echo "==> 7. ディスク空き (DMG 作成に最低 2 GB は欲しい)"
free_gb=$(df -g . | awk 'NR==2 {print $4}')
if [ "$free_gb" -ge 2 ]; then
  pass "空き ${free_gb} GB"
else
  warn "空きが ${free_gb} GB しかありません — ビルド途中で詰まる可能性"
fi

echo ""
echo "==> 8. ローカル既存タグ"
TAG="${1:-}"
if [ -n "$TAG" ]; then
  if git tag --list | grep -qx "$TAG"; then
    warn "ローカルに既存タグ $TAG があります — release.sh は --clobber で上書きしますがご注意"
  else
    pass "$TAG は新規タグ"
  fi
fi

echo ""
echo "============================================================"
if [ "$failures" -eq 0 ]; then
  printf "${PASS_COLOR}OK${RESET}: 致命エラー 0 件 / 警告 ${warnings} 件\n"
  echo "次のコマンドでリリースを発火できます:"
  if [ -n "${UNSIGNED:-}" ]; then
    echo "  UNSIGNED=1 scripts/release.sh ${TAG:-vX.Y.Z}"
  elif [ -n "${NOTARIZE_SKIP:-}" ]; then
    echo "  NOTARIZE_SKIP=1 scripts/release.sh ${TAG:-vX.Y.Z}"
  else
    echo "  scripts/release.sh ${TAG:-vX.Y.Z}"
  fi
  exit 0
else
  printf "${FAIL_COLOR}NG${RESET}: 致命エラー ${failures} 件 / 警告 ${warnings} 件 — 先に修正してください\n"
  exit 1
fi
