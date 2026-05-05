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

# Round 16 ㉾: release-status を release.sh 冒頭で自動表示。
# version 不一致 / behind / Apple 認証 未設定などを最速で見せる。
# SKIP_STATUS=1 で省略可能だが、通常は出した方が安心。
if [ -z "${SKIP_STATUS:-}" ]; then
  echo ""
  echo "==> -1. release-status (Round 15 ㉹ で導入したダッシュボード)"
  "$(dirname "$0")/release-status.sh" || true
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

# 0.5 Round 12 ㉪: リモート main との同期確認。
# gh release create は HEAD の commit にタグを打つので、未 push の commit が
# あると「DMG はビルドされたが、release は古い commit を指している」事故が
# 起きる。事前に同期チェックして必要なら push する。
if [ -z "${SKIP_PUSH_CHECK:-}" ]; then
  echo ""
  echo "==> 0.5 リモート main との同期確認"
  git fetch origin >/dev/null 2>&1 || true
  AHEAD=$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo "0")
  BEHIND=$(git rev-list --count "HEAD..@{u}" 2>/dev/null || echo "0")
  if [ "$BEHIND" -gt 0 ]; then
    echo "ERROR: ローカルがリモートより $BEHIND コミット遅れています — git pull してから再実行"
    exit 1
  fi
  if [ "$AHEAD" -gt 0 ]; then
    echo "  ローカルがリモートより $AHEAD コミット進んでいます。push してから release を打ちます。"
    if [ -z "${SKIP_PUSH:-}" ]; then
      git push origin HEAD
    else
      echo "  (SKIP_PUSH=1 のため push を skip — gh release create が失敗する可能性大)"
    fi
  else
    echo "  ✓ リモートと同期済み"
  fi
fi

# Rust toolchain
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

# Round 11 ㉥: ユーザが既に release-setup-credentials.sh を実行済みなら
# ~/.kaikei-release.env が存在し、APPLE_* env が一発で揃う。
# UNSIGNED=1 / NOTARIZE_SKIP=1 が指定されている時は env なしで進める。
if [ -z "${UNSIGNED:-}" ] && [ -z "${NOTARIZE_SKIP:-}" ] && [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  if [ -f "$HOME/.kaikei-release.env" ]; then
    echo "==> ~/.kaikei-release.env を自動 source (Round 11 ㉥)"
    # shellcheck disable=SC1090
    source "$HOME/.kaikei-release.env"
  else
    cat <<EOF

⚠️  APPLE_* env が未設定で、~/.kaikei-release.env も見つかりません。

公証付きリリースを打つには、先に下記を 1 回だけ実行してください (対話的):
  scripts/release-setup-credentials.sh

それで以下が自動で揃います:
  - keychain に notarytool credential profile (AC_PASSWORD) を保存
  - ~/.kaikei-release.env に APPLE_SIGNING_IDENTITY / APPLE_ID /
    APPLE_PASSWORD (=@keychain:AC_PASSWORD) / APPLE_TEAM_ID を書き出し

完了後に再度このコマンド (scripts/release.sh $TAG) を打つと、
~/.kaikei-release.env が自動 source されます。

未署名で構わない場合は:
  UNSIGNED=1 scripts/release.sh $TAG          # 完全未署名 (arm64 のみ)
  NOTARIZE_SKIP=1 scripts/release.sh $TAG     # 署名はする / 公証だけ skip
EOF
    exit 1
  fi
fi

# Round 13 ㉯: DRY_RUN=1 でビルド以降を全部 stub にして、何が実行されるかだけ
# 表示する。precheck と push-check は通常通り走るので「リリース直前の最終確認」
# として使える。
if [ -n "${DRY_RUN:-}" ]; then
  cat <<DRY

==> DRY_RUN=1 — ビルド/署名/公証/upload は実行しません。

以下のステップが実行される予定です:
  1. tauri build --bundles app (--target x86_64-apple-darwin も)
  2. .app 署名 (codesign with $APPLE_SIGNING_IDENTITY)
  3. DMG 自前作成 (scripts/make-dmg.sh)
  4. notarytool submit + stapler staple
     ($([ -n "${NOTARIZE_SKIP:-}" ] && echo "(NOTARIZE_SKIP=1 — 公証 skip)" || echo "(公証あり)"))
  5. CHANGELOG.md から v$VERSION セクションを抽出 → release notes
  6. gh release create $TAG (or upload で既存 release に差し替え)
  7. verify-release.sh QUICK=1 で URL 200 健康診断

実打ちは DRY_RUN を外して再実行してください:
  scripts/release.sh $TAG

DRY
  exit 0
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

# Round 9 ㊙: リリース直後の自動健康診断。
# 公証なし版でも URL 200 と asset 3 種類の存在は確認できる。
# CDN 反映に少し遅延があるので 5 秒待ってから。
if [ -z "${SKIP_VERIFY:-}" ]; then
  echo ""
  echo "==> 5 秒待って verify-release.sh で健康診断"
  sleep 5
  if QUICK=1 "$(dirname "$0")/verify-release.sh" "$TAG"; then
    echo "✅ verify-release.sh: OK"
  else
    echo "⚠️  verify-release.sh: 警告あり — 手動で内容を確認してください"
    echo "   問題があれば: scripts/release-rollback.sh $TAG で取り消せます"
  fi
fi
