#!/usr/bin/env bash
# ============================================================
# kaikei: signed + notarized .dmg build script
#
# 事前準備:
#   - Developer ID Application 証明書 がキーチェインに入っていること
#     ( security find-identity -v -p codesigning で確認 )
#   - Apple ID の app-specific password を発行済みであること
#   - Team ID を把握していること
#
# 環境変数 (~/.zshrc 等に定義しておくと便利):
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
#   export APPLE_ID="your@apple.id"
#   export APPLE_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # app-specific password
#   export APPLE_TEAM_ID="TEAMID"
#
# 使い方:
#   ./scripts/build-signed.sh
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY が未設定です}"
: "${APPLE_ID:?APPLE_ID が未設定です}"
: "${APPLE_PASSWORD:?APPLE_PASSWORD が未設定です (app-specific password)}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID が未設定です}"

echo "==> 署名ID: $APPLE_SIGNING_IDENTITY"

# Rust toolchain
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

# 1. Tauri build (署名込み)
echo "==> Tauri build"
APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
APPLE_ID="$APPLE_ID" \
APPLE_PASSWORD="$APPLE_PASSWORD" \
APPLE_TEAM_ID="$APPLE_TEAM_ID" \
npx tauri build --bundles dmg

DMG_DIR="src-tauri/target/release/bundle/dmg"
APP_DIR="src-tauri/target/release/bundle/macos"
DMG_FILE=$(ls "$DMG_DIR"/kaikei_*.dmg 2>/dev/null | head -1)
APP_FILE="$APP_DIR/kaikei.app"

if [ -z "$DMG_FILE" ]; then
  echo "ERROR: dmg not found in $DMG_DIR"
  exit 1
fi
echo "==> Built: $DMG_FILE"

# 2. 署名確認 (app bundle 側)
if [ -d "$APP_FILE" ]; then
  echo "==> codesign verify (.app)"
  codesign --verify --verbose=2 "$APP_FILE" || {
    echo "WARN: app verify failed, re-signing"
    codesign --force --deep --options runtime \
      --entitlements src-tauri/entitlements.plist \
      --sign "$APPLE_SIGNING_IDENTITY" "$APP_FILE"
  }
fi

# 3. 公証 submit
echo "==> Submit to Apple notary (この工程は数分かかることがあります)"
xcrun notarytool submit "$DMG_FILE" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait

# 4. staple (公証チケットを dmg に貼り付け)
echo "==> staple"
xcrun stapler staple "$DMG_FILE"

# 5. 検証
echo "==> Gatekeeper 確認"
spctl -a -vv --type install "$DMG_FILE" || true

echo ""
echo "✅ 完了: $DMG_FILE"
echo "   ファイルサイズ: $(ls -lh "$DMG_FILE" | awk '{print $5}')"
echo ""
echo "このdmgは Developer ID で署名 & 公証済みなので、"
echo "友達に渡しても初回起動時に警告なしで開けます。"
