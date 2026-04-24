#!/usr/bin/env bash
# ============================================================
# kaikei: GitHub Release を作ってDMGをアップロードする
#
# 事前:
#   - ghコマンド (GitHub CLI) でログイン済み (gh auth status)
#   - Developer ID 証明書をお持ちなら scripts/build-signed.sh を先に使う
#   - ない場合は素の `npx tauri build --bundles dmg` で未署名DMGを作る
#
# 使い方:
#   # タグを付けてリリース
#   scripts/release.sh v0.1.0
#
#   # 未署名DMGでリリース
#   UNSIGNED=1 scripts/release.sh v0.1.0-beta
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "ERROR: タグを指定してください (例: scripts/release.sh v0.1.0)"
  exit 1
fi

# バージョン欄にタグ名から v を外して書き込む
VERSION="${TAG#v}"

if ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI (gh) がインストールされていません"
  exit 1
fi

# Rust toolchain
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

# 1. ビルド
if [ -n "${UNSIGNED:-}" ]; then
  echo "==> 未署名ビルド"
  npx tauri build --bundles dmg
else
  echo "==> 署名+公証ビルド (scripts/build-signed.sh)"
  ./scripts/build-signed.sh
fi

# 2. 生成された DMG を探す
DMG_SRC=$(ls src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1)
if [ -z "$DMG_SRC" ]; then
  echo "ERROR: DMG が見つかりません (src-tauri/target/release/bundle/dmg/)"
  exit 1
fi

# 3. 推奨ファイル名にリネーム
DMG_FINAL="KAIKEI_LOCAL.dmg"
cp "$DMG_SRC" "/tmp/$DMG_FINAL"
echo "==> Prepared: /tmp/$DMG_FINAL ($(du -h /tmp/$DMG_FINAL | awk '{print $1}'))"

# 4. GitHub Release 作成 (既にあれば再利用)
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "==> Release $TAG は既存。アセットを差し替えます"
  gh release upload "$TAG" "/tmp/$DMG_FINAL" --clobber
else
  echo "==> Release $TAG を新規作成"
  gh release create "$TAG" \
    --title "KAIKEI LOCAL $VERSION" \
    --notes "自動生成された KAIKEI LOCAL のリリースです。\n\n詳しい変更点は CHANGELOG または commit 履歴を参照してください。" \
    "/tmp/$DMG_FINAL"
fi

echo ""
echo "✅ 完了"
echo "   ダウンロード URL (latest 固定):"
echo "   https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/latest/download/$DMG_FINAL"
