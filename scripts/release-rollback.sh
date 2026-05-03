#!/usr/bin/env bash
# ============================================================
# scripts/release-rollback.sh <tag>
#
# 直前 (or 過去) の GitHub Release / git tag / ローカル DMG を安全に取り消す。
# 「scripts/release.sh v0.3.0 を打ったけど何か変だった」という時の救命ボタン。
#
# 取り消す内容:
#   1. GitHub Release (gh release delete)
#   2. リモート git tag (git push --delete origin <tag>)
#   3. ローカル git tag (git tag -d <tag>)
#   4. /tmp/KAIKEI_LOCAL*.dmg のキャッシュ (release.sh が作る一時 DMG)
#   5. /tmp/kaikei-built-dmgs.txt (build-all.sh のメモ)
#
# 安全策:
#   - 各ステップで yes/no 確認 (FORCE=1 でスキップ)
#   - dry-run で何が消されるかだけ表示するモード (--dry-run)
#   - latest tag だけは追加で「本当に?」を 2 回確認
#
# 使い方:
#   scripts/release-rollback.sh v0.3.0
#   scripts/release-rollback.sh v0.3.0 --dry-run   # 実行せず予告のみ
#   FORCE=1 scripts/release-rollback.sh v0.3.0     # 全プロンプト y で進める
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-}"
DRY=""
if [ "${2:-}" = "--dry-run" ]; then DRY="1"; fi

if [ -z "$TAG" ]; then
  echo "ERROR: タグを指定してください (例: scripts/release-rollback.sh v0.3.0)"
  exit 2
fi

PASS_COLOR="\033[32m"
FAIL_COLOR="\033[31m"
WARN_COLOR="\033[33m"
RESET="\033[0m"

confirm() {
  local prompt="$1"
  if [ -n "${FORCE:-}" ] || [ -n "$DRY" ]; then return 0; fi
  read -r -p "$prompt [y/N] " ans
  case "$ans" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

run_or_dry() {
  if [ -n "$DRY" ]; then
    printf "${WARN_COLOR}[dry-run]${RESET} %s\n" "$*"
  else
    "$@"
  fi
}

# 0. 状態確認
echo ""
echo "==> rollback 対象 ($TAG):"
release_exists="false"
if gh release view "$TAG" >/dev/null 2>&1; then
  release_exists="true"
  echo "  GitHub Release: あり"
  gh release view "$TAG" --json publishedAt,assets -q '.assets[].name' | sed 's/^/    - /'
else
  echo "  GitHub Release: なし"
fi

local_tag="false"
if git tag --list | grep -qx "$TAG"; then
  local_tag="true"
  echo "  ローカル git tag: あり"
else
  echo "  ローカル git tag: なし"
fi

remote_tag="false"
if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "$TAG"; then
  remote_tag="true"
  echo "  リモート git tag: あり"
else
  echo "  リモート git tag: なし"
fi

# latest 判定
LATEST_TAG=$(gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/latest" -q .tag_name 2>/dev/null || echo "")
if [ "$LATEST_TAG" = "$TAG" ]; then
  printf "  ${WARN_COLOR}注意:${RESET} %s は現在 latest です。削除すると一つ前の release が latest に格上げされます\n" "$TAG"
  if [ -z "$DRY" ] && [ -z "${FORCE:-}" ]; then
    confirm "本当に latest release を削除しますか?" || { echo "中止"; exit 0; }
  fi
fi

if [ "$release_exists" = "false" ] && [ "$local_tag" = "false" ] && [ "$remote_tag" = "false" ]; then
  echo ""
  printf "${PASS_COLOR}既に何もありません。${RESET}\n"
  exit 0
fi

echo ""

# 1. GitHub Release
if [ "$release_exists" = "true" ]; then
  if confirm "GitHub Release $TAG を削除しますか?"; then
    run_or_dry gh release delete "$TAG" --yes --cleanup-tag
    # --cleanup-tag は同名のリモートタグも一緒に消すので remote_tag を false 扱い
    remote_tag="false"
  fi
fi

# 2. リモート tag (Release 削除で消えてなければ)
if [ "$remote_tag" = "true" ]; then
  if confirm "リモート git tag origin/$TAG を削除しますか?"; then
    run_or_dry git push --delete origin "$TAG"
  fi
fi

# 3. ローカル tag
if [ "$local_tag" = "true" ]; then
  if confirm "ローカル git tag $TAG を削除しますか?"; then
    run_or_dry git tag -d "$TAG"
  fi
fi

# 4. /tmp の DMG キャッシュ
echo ""
TMP_DMGS=()
for f in /tmp/KAIKEI_LOCAL.dmg /tmp/KAIKEI_LOCAL_arm64.dmg /tmp/KAIKEI_LOCAL_x64.dmg /tmp/kaikei-built-dmgs.txt; do
  if [ -e "$f" ]; then
    TMP_DMGS+=("$f")
  fi
done
if [ ${#TMP_DMGS[@]} -gt 0 ]; then
  echo "==> /tmp に build-all.sh / release.sh のキャッシュ:"
  for f in "${TMP_DMGS[@]}"; do echo "  $(basename "$f") ($(du -h "$f" 2>/dev/null | awk '{print $1}'))"; done
  if confirm "上記キャッシュも削除しますか?"; then
    for f in "${TMP_DMGS[@]}"; do
      run_or_dry rm -f "$f"
    done
  fi
fi

echo ""
if [ -n "$DRY" ]; then
  printf "${WARN_COLOR}dry-run 終了 — 何も消していません${RESET}\n"
else
  printf "${PASS_COLOR}rollback 完了${RESET}\n"
fi
