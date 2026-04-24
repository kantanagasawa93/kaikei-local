#!/usr/bin/env bash
# macOS 26 の TCC が "KAIKEI LOCAL" のような空白入りボリューム名を拒否するため、
# tauri-bundler の bundle_dmg.sh を使わず自前で DMG を作る。
# 内部ボリューム名は "KAIKEI_LOCAL"（アンダースコア）だがユーザに見える
# .app は "KAIKEI LOCAL.app" のままなので、インストール体験は変わらない。
#
# Usage: make-dmg.sh <path/to/.app> <output/path/to/file.dmg>
set -euo pipefail

APP_PATH="$1"
DMG_OUT="$2"

if [ ! -d "$APP_PATH" ]; then
  echo "ERROR: app not found: $APP_PATH"
  exit 1
fi

VOLNAME_SAFE="KAIKEI_LOCAL"
TMP_DIR="$(mktemp -d -t kaikei-dmg)"
TMP_DMG="${TMP_DIR}/raw.dmg"

trap 'rm -rf "$TMP_DIR"' EXIT

# 1. .app を一時フォルダへコピー（Applications へのシンボリックリンクも作成しておくとユーザ体験が良い）
echo "==> staging"
STAGE="${TMP_DIR}/stage"
mkdir -p "$STAGE"
cp -R "$APP_PATH" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

# 2. RW DMG を作成
echo "==> hdiutil create (volname=${VOLNAME_SAFE})"
hdiutil create -srcfolder "$STAGE" -volname "$VOLNAME_SAFE" \
  -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW "$TMP_DMG" >/dev/null

# 3. UDZO（圧縮）に変換
echo "==> hdiutil convert to UDZO"
rm -f "$DMG_OUT"
hdiutil convert "$TMP_DMG" -format UDZO -imagekey zlib-level=9 -o "$DMG_OUT" >/dev/null

echo "==> ${DMG_OUT}"
ls -lh "$DMG_OUT"
