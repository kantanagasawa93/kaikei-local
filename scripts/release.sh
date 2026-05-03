#!/usr/bin/env bash
# ============================================================
# kaikei: GitHub Release を作ってDMGをアップロードする
#
# v0.3.0 から Apple Silicon + Intel 両アーキの DMG を 3 つアップロードする:
#   - KAIKEI_LOCAL.dmg          (Apple Silicon — デフォルト/latest 互換)
#   - KAIKEI_LOCAL_arm64.dmg    (Apple Silicon 明示)
#   - KAIKEI_LOCAL_x64.dmg      (Intel)
#
# Apple Silicon を default にする理由:
#   - 新規ユーザーの 95%+ が M1〜M4
#   - LP / install ガイドの既存リンク (KAIKEI_LOCAL.dmg) を温存できる
#
# 事前:
#   - ghコマンド (GitHub CLI) でログイン済み (gh auth status)
#   - Developer ID 証明書をお持ちなら scripts/build-signed.sh を先に使う
#   - ない場合は素の `npx tauri build --bundles dmg` で未署名DMGを作る
#
# 使い方:
#   scripts/release.sh v0.3.0                # 署名+公証で両アーキビルド
#   UNSIGNED=1 scripts/release.sh v0.3.0-beta # 未署名 (ARM のみ)
#   ARCH=arm64 scripts/release.sh v0.3.0     # ARM だけ作って x64 は省略
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

# 0. Round 4 ㊀ で導入: フル precheck を回して失敗してたら止める。
# SKIP_PRECHECK=1 で無効化可能だが、通常は必ず通すこと。
if [ -z "${SKIP_PRECHECK:-}" ]; then
  echo ""
  echo "==> 0. Precheck"
  if ! "$(dirname "$0")/release-precheck.sh" "$TAG"; then
    echo ""
    echo "ERROR: precheck が失敗しました。SKIP_PRECHECK=1 で強制発火できますが推奨しません"
    exit 1
  fi
fi

# Rust toolchain
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

# 1. ビルド
ASSETS=()
if [ -n "${UNSIGNED:-}" ]; then
  echo "==> 未署名ビルド (ARM only)"
  npx tauri build --bundles dmg
  DMG_SRC=$(ls src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1)
  if [ -z "$DMG_SRC" ]; then
    echo "ERROR: DMG が見つかりません"
    exit 1
  fi
  cp "$DMG_SRC" "/tmp/KAIKEI_LOCAL.dmg"
  cp "$DMG_SRC" "/tmp/KAIKEI_LOCAL_arm64.dmg"
  ASSETS+=("/tmp/KAIKEI_LOCAL.dmg" "/tmp/KAIKEI_LOCAL_arm64.dmg")
else
  echo "==> 署名+公証ビルド (scripts/build-all.sh — ARM + Intel)"
  ./scripts/build-all.sh

  # build-all.sh は /tmp/kaikei-built-dmgs.txt にパスを書き残してくれる
  if [ ! -f /tmp/kaikei-built-dmgs.txt ]; then
    echo "ERROR: /tmp/kaikei-built-dmgs.txt が見つかりません"
    exit 1
  fi

  # ARM DMG を /tmp/KAIKEI_LOCAL.dmg と /tmp/KAIKEI_LOCAL_arm64.dmg に
  # コピー (既存ダウンロード URL の互換性確保 + 明示 arch 名)
  ARM_DMG=$(grep aarch64 /tmp/kaikei-built-dmgs.txt | head -1 || true)
  X64_DMG=$(grep x64 /tmp/kaikei-built-dmgs.txt | head -1 || true)

  if [ -n "$ARM_DMG" ] && [ -f "$ARM_DMG" ]; then
    cp "$ARM_DMG" "/tmp/KAIKEI_LOCAL.dmg"        # latest 互換
    cp "$ARM_DMG" "/tmp/KAIKEI_LOCAL_arm64.dmg"   # 明示
    ASSETS+=("/tmp/KAIKEI_LOCAL.dmg" "/tmp/KAIKEI_LOCAL_arm64.dmg")
    echo "==> ARM DMG: $ARM_DMG"
  fi
  if [ -n "$X64_DMG" ] && [ -f "$X64_DMG" ]; then
    cp "$X64_DMG" "/tmp/KAIKEI_LOCAL_x64.dmg"
    ASSETS+=("/tmp/KAIKEI_LOCAL_x64.dmg")
    echo "==> Intel DMG: $X64_DMG"
  fi

  if [ ${#ASSETS[@]} -eq 0 ]; then
    echo "ERROR: 1 つも DMG が見つかりません"
    exit 1
  fi
fi

echo ""
echo "==> アップロード予定 (${#ASSETS[@]} 個):"
for f in "${ASSETS[@]}"; do
  echo "   $(basename "$f") ($(du -h "$f" | awk '{print $1}'))"
done

# 1.5. CHANGELOG.md の対応バージョンセクションを抜き出して release notes に。
#       Round 8 ㊔ で導入: ハードコード → CHANGELOG 連動 にして「リリースノートが
#       存在しないバージョンを誤公開する」事故を防ぐ。
NOTES_FILE=$(mktemp)
trap 'rm -f "$NOTES_FILE"' EXIT
if [ -f CHANGELOG.md ]; then
  # `## v0.3.0` から次の `## v` までを抽出 (awk で 1pass)
  awk -v ver="$VERSION" '
    BEGIN { capturing = 0 }
    # "## v0.3.0" or "## v0.3.0 <space>"
    /^## v[0-9]/ {
      if (capturing) { exit }
      if ($2 == "v" ver || index($0, "v" ver " ") > 0 || index($0, "v" ver "$") > 0) {
        capturing = 1
        print
        next
      }
    }
    capturing == 1 { print }
  ' CHANGELOG.md > "$NOTES_FILE"
fi

# CHANGELOG にセクションが無ければハードコードを fallback にする (壊さない)
if [ ! -s "$NOTES_FILE" ]; then
  cat > "$NOTES_FILE" <<EOF
KAIKEI LOCAL $VERSION

ダウンロード:
- Apple Silicon (M1〜M4): KAIKEI_LOCAL.dmg または KAIKEI_LOCAL_arm64.dmg
- Intel Mac: KAIKEI_LOCAL_x64.dmg

詳しい変更点は CHANGELOG.md または commit 履歴を参照してください。
EOF
  echo "==> CHANGELOG.md に v$VERSION のセクションが見つかりません。fallback notes を使用"
else
  # ダウンロードリンクを末尾に追記
  cat >> "$NOTES_FILE" <<EOF

---
**ダウンロード:**
- Apple Silicon (M1〜M4): \`KAIKEI_LOCAL.dmg\` / \`KAIKEI_LOCAL_arm64.dmg\`
- Intel Mac: \`KAIKEI_LOCAL_x64.dmg\`
EOF
  echo "==> CHANGELOG.md から v$VERSION のリリースノートを抽出しました ($(wc -l < "$NOTES_FILE") 行)"
fi

# 2. GitHub Release 作成 (既にあれば再利用)
if gh release view "$TAG" >/dev/null 2>&1; then
  echo ""
  echo "==> Release $TAG は既存。アセットを差し替えます"
  gh release upload "$TAG" "${ASSETS[@]}" --clobber
  # notes も更新
  gh release edit "$TAG" --notes-file "$NOTES_FILE" >/dev/null
else
  echo ""
  echo "==> Release $TAG を新規作成"
  gh release create "$TAG" \
    --title "KAIKEI LOCAL $VERSION" \
    --notes-file "$NOTES_FILE" \
    "${ASSETS[@]}"
fi

REPO_OWNER=$(gh repo view --json nameWithOwner -q .nameWithOwner)
echo ""
echo "✅ 完了"
echo "   Apple Silicon (latest 互換):"
echo "   https://github.com/$REPO_OWNER/releases/latest/download/KAIKEI_LOCAL.dmg"
echo "   Apple Silicon (明示):"
echo "   https://github.com/$REPO_OWNER/releases/latest/download/KAIKEI_LOCAL_arm64.dmg"
echo "   Intel Mac:"
echo "   https://github.com/$REPO_OWNER/releases/latest/download/KAIKEI_LOCAL_x64.dmg"
