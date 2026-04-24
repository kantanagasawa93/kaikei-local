#!/usr/bin/env bash
# ============================================================
# ARM ビルドの最新 DMG から手元の KAIKEI LOCAL.app を置き換えて起動する。
# build-all.sh 完走後に呼ぶことで「反映されてない」問題をゼロにする。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="KAIKEI LOCAL"
DMG="src-tauri/target/release/bundle/dmg/${APP_NAME}_0.1.0_aarch64.dmg"
APP_IN_APPLICATIONS="/Applications/${APP_NAME}.app"
# 新 make-dmg.sh はアンダースコアの volname を使う（旧 tauri 版は空白）
VOLUME_NEW="/Volumes/KAIKEI_LOCAL"
VOLUME_OLD="/Volumes/${APP_NAME}"

if [ ! -f "$DMG" ]; then
  echo "ERROR: DMG not found: $DMG"
  exit 1
fi

echo "==> 既存アプリを終了"
osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
# 強制終了のバックアップ（graceful quit を 1 秒待つ）
sleep 1
pkill -x "${APP_NAME}" 2>/dev/null || true

# 念のため既にマウントされている古い DMG を外す
for v in "$VOLUME_NEW" "$VOLUME_OLD"; do
  if [ -d "$v" ]; then
    hdiutil detach "$v" -quiet || true
  fi
done

echo "==> DMG をマウント"
hdiutil attach "$DMG" -nobrowse -quiet

# 新・旧どちらのボリューム名でも対応
VOLUME=""
for v in "$VOLUME_NEW" "$VOLUME_OLD"; do
  if [ -d "$v/${APP_NAME}.app" ]; then
    VOLUME="$v"
    break
  fi
done

if [ -z "$VOLUME" ]; then
  echo "ERROR: .app not found in any mounted volume"
  hdiutil detach "$VOLUME_NEW" -quiet 2>/dev/null || true
  hdiutil detach "$VOLUME_OLD" -quiet 2>/dev/null || true
  exit 1
fi

echo "==> /Applications/ に上書きコピー (from $VOLUME)"
rm -rf "$APP_IN_APPLICATIONS"
cp -R "$VOLUME/${APP_NAME}.app" /Applications/

echo "==> DMG をアンマウント"
hdiutil detach "$VOLUME" -quiet

echo "==> アプリを起動"
open -a "$APP_NAME"

echo ""
echo "✅ インストール完了 & 起動"
echo "   $(date -r "$APP_IN_APPLICATIONS")"
