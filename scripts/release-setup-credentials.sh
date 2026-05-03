#!/usr/bin/env bash
# ============================================================
# scripts/release-setup-credentials.sh
#
# v0.3.0 公証付きリリースを打つ前に必要な Apple 認証情報を
# 「対話的に 1 回だけ」セットアップする補助スクリプト。
#
# やること:
#   1. keychain に Developer ID Application 証明書があるか確認
#   2. APPLE_ID / APPLE_TEAM_ID を尋ねる (defaults を提示)
#   3. xcrun notarytool store-credentials AC_PASSWORD で
#      app-specific password を keychain に保存 (対話モードで入力)
#   4. ~/.kaikei-release.env に APPLE_* 4 種を書き出し
#   5. 完了案内: `source ~/.kaikei-release.env && scripts/release.sh v0.3.0`
#
# Round 10 ㉠ で導入: Round 5-9 の毎ラウンドで「APPLE 認証なし」と
# 引っかかっていたので、ユーザが 1 回だけ叩けば残りのラウンドで自動的に
# 公証付きリリースを打てる動線を作る。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PASS_COLOR="\033[32m"
FAIL_COLOR="\033[31m"
WARN_COLOR="\033[33m"
DIM_COLOR="\033[2m"
RESET="\033[0m"

# CLAUDE.md に記録されている defaults
DEFAULT_APPLE_ID="${APPLE_ID:-k.nagasawa.pc@gmail.com}"
DEFAULT_TEAM_ID="${APPLE_TEAM_ID:-6FU765RJ9M}"
DEFAULT_PROFILE="AC_PASSWORD"

ENV_FILE="$HOME/.kaikei-release.env"

echo ""
echo "==> 1. Developer ID 証明書 (keychain)"
SIGNING_LINE=$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -F "Developer ID Application" | head -1 || true)
if [ -z "$SIGNING_LINE" ]; then
  printf "${FAIL_COLOR}✗${RESET} Developer ID Application 証明書が keychain にありません。\n"
  echo "   先に Xcode → Preferences → Accounts → Manage Certificates から作成して"
  echo "   keychain に取り込んでください。"
  exit 1
fi
# `   1) HASH "Developer ID Application: <name> (<TEAM>)"`
SIGNING_NAME=$(echo "$SIGNING_LINE" | sed -E 's/^.*"(Developer ID Application: [^"]+)".*$/\1/')
EXTRACTED_TEAM=$(echo "$SIGNING_NAME" | sed -E 's/.*\(([A-Z0-9]+)\)$/\1/')
printf "${PASS_COLOR}✓${RESET} %s\n" "$SIGNING_NAME"
if [ -n "$EXTRACTED_TEAM" ]; then
  DEFAULT_TEAM_ID="$EXTRACTED_TEAM"
fi

echo ""
echo "==> 2. Apple ID と Team ID"
read -r -p "Apple ID [$DEFAULT_APPLE_ID]: " IN_APPLE_ID
APPLE_ID_VAL="${IN_APPLE_ID:-$DEFAULT_APPLE_ID}"
read -r -p "Team ID [$DEFAULT_TEAM_ID]: " IN_TEAM_ID
TEAM_ID_VAL="${IN_TEAM_ID:-$DEFAULT_TEAM_ID}"

echo ""
echo "==> 3. App-specific password を keychain に保存 (profile: $DEFAULT_PROFILE)"
echo "   ${DIM_COLOR}https://appleid.apple.com → セキュリティ → App用パスワード で生成${RESET}"
echo ""
# notarytool store-credentials は対話モードで password を尋ねる
xcrun notarytool store-credentials "$DEFAULT_PROFILE" \
  --apple-id "$APPLE_ID_VAL" \
  --team-id "$TEAM_ID_VAL"

echo ""
echo "==> 4. ~/.kaikei-release.env に env を書き出し"
cat > "$ENV_FILE" <<EOF
# KAIKEI LOCAL release credentials (Round 10 ㉠ で生成).
# 機密情報を含むため、絶対に git に入れないこと (~/ にあるので心配なし)。
#
# 使い方:
#   source ~/.kaikei-release.env
#   scripts/release-precheck.sh v0.3.0   # 全項目 ✓ を確認
#   scripts/release.sh v0.3.0            # 公証付きリリース発火

export APPLE_SIGNING_IDENTITY="$SIGNING_NAME"
export APPLE_ID="$APPLE_ID_VAL"
export APPLE_TEAM_ID="$TEAM_ID_VAL"
# 実 password ではなく keychain profile への参照 (notarytool が解決)
export APPLE_PASSWORD="@keychain:$DEFAULT_PROFILE"
EOF
chmod 600 "$ENV_FILE"
printf "${PASS_COLOR}✓${RESET} %s に書き出しました (chmod 600)\n" "$ENV_FILE"

echo ""
echo "============================================================"
printf "${PASS_COLOR}セットアップ完了${RESET}\n"
echo ""
echo "次のコマンドで v0.3.0 リリースを打てます:"
echo ""
echo "  source ~/.kaikei-release.env"
echo "  scripts/release-precheck.sh v0.3.0   # 全項目 ✓ を確認"
echo "  scripts/release.sh v0.3.0            # 公証付き DMG → GitHub Release"
echo ""
echo "(release.sh の最後で verify-release.sh が自動で走り、URL 200 確認まで)"
