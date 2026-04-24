#!/usr/bin/env bash
# ============================================================
# kaikei: ARM + Intel 両方を署名・公証・staple する統合スクリプト
# 環境変数:
#   APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_SIGNING_IDENTITY:?APPLE_SIGNING_IDENTITY 未設定}"
: "${APPLE_ID:?APPLE_ID 未設定}"
: "${APPLE_PASSWORD:?APPLE_PASSWORD 未設定}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID 未設定}"

if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

build_arch() {
  local arch_name="$1"    # aarch64 or x64
  local target_flag="$2"  # "" for host (arm64), or "--target x86_64-apple-darwin"

  echo ""
  echo "=========================================="
  echo "  Building $arch_name"
  echo "=========================================="

  # tauri の DMG 作成は macOS 26 の TCC と相性が悪いため、--bundles app で .app のみ作る。
  # 公証は後段で DMG に対して行うので、tauri 実行時は APPLE_* を渡さず .app の notarize を skip する。
  # （渡すと tauri が .app を notarize するが、DMG 側で再 notarize が必要で二重コストになる）
  # shellcheck disable=SC2086
  env -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
    APPLE_SIGNING_IDENTITY="$APPLE_SIGNING_IDENTITY" \
    npx tauri build --bundles app $target_flag

  # .app の場所と DMG の出力先
  local app_dir dmg_file
  if [ "$arch_name" = "aarch64" ]; then
    app_dir="src-tauri/target/release/bundle/macos"
    dmg_file="src-tauri/target/release/bundle/dmg/KAIKEI LOCAL_0.1.0_aarch64.dmg"
  else
    app_dir="src-tauri/target/x86_64-apple-darwin/release/bundle/macos"
    dmg_file="src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/KAIKEI LOCAL_0.1.0_x64.dmg"
  fi
  local app_file="$app_dir/KAIKEI LOCAL.app"

  if [ ! -d "$app_file" ]; then
    echo "ERROR: .app not found: $app_file"
    exit 1
  fi

  # 署名検証（tauri は既に実施済みのはずだが念のため）
  codesign --verify --verbose=2 "$app_file" || {
    echo "WARN: app verify failed, re-signing"
    codesign --force --deep --options runtime \
      --entitlements src-tauri/entitlements.plist \
      --sign "$APPLE_SIGNING_IDENTITY" "$app_file"
  }

  # DMG 自前作成
  mkdir -p "$(dirname "$dmg_file")"
  "$(dirname "$0")/make-dmg.sh" "$app_file" "$dmg_file"

  # DMG 自体にも署名（友達に渡す時 Gatekeeper がスムーズに通るように）
  codesign --force --sign "$APPLE_SIGNING_IDENTITY" "$dmg_file"

  # 公証
  echo "==> Submit to Apple notary ($arch_name)"
  xcrun notarytool submit "$dmg_file" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  echo "==> staple ($arch_name)"
  xcrun stapler staple "$dmg_file"

  echo "==> Gatekeeper check"
  spctl -a -vv --type install "$dmg_file" || true

  echo "✅ $arch_name 完了: $dmg_file"
  echo "   size: $(ls -lh "$dmg_file" | awk '{print $5}')"

  # 呼び出し側が拾えるようにファイルパスを記録
  echo "$dmg_file" >> /tmp/kaikei-built-dmgs.txt
}

# 初期化
rm -f /tmp/kaikei-built-dmgs.txt
touch /tmp/kaikei-built-dmgs.txt

# ARM (ホスト)
build_arch "aarch64" ""

# Intel (クロスコンパイル)
build_arch "x64" "--target x86_64-apple-darwin"

echo ""
echo "=========================================="
echo "  全ビルド完了"
echo "=========================================="
cat /tmp/kaikei-built-dmgs.txt

# 毎回、手元の KAIKEI LOCAL を最新版に差し替えて起動する
echo ""
echo "==> ローカルアプリを置き換えて起動"
"$(dirname "$0")/install-and-open.sh"
