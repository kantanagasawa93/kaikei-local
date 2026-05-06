#!/usr/bin/env bash
# ============================================================
# scripts/release-followup.sh <tag>
#
# Round 17 ㊃: リリース後にやることのチェックリスト + リリース統計を 1 コマンドで。
#
# 表示項目:
#   1. 対象 release の基本情報 (タグ / publishedAt / 公開からの経過時間)
#   2. asset 別ダウンロード数 (gh api で /releases/<id>/assets を引く)
#   3. リリース commit からのプッシュ数 (release tag 以降に main へ追加された commit 数)
#   4. アプリ内 update notification の状態 (まだ未実装ならその旨)
#   5. やることチェックリスト (LP 更新 / SNS / 既存ユーザ連絡 / ロードマップ更新)
#
# 使い方:
#   scripts/release-followup.sh v0.2.0
#   scripts/release-followup.sh           # 引数省略時は /releases/latest
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PASS_COLOR="\033[32m"
WARN_COLOR="\033[33m"
DIM_COLOR="\033[2m"
RESET="\033[0m"

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "?/?")
TAG="${1:-}"
if [ -z "$TAG" ]; then
  TAG=$(gh api "repos/$REPO/releases/latest" -q .tag_name 2>/dev/null || echo "")
  if [ -z "$TAG" ]; then
    echo "ERROR: latest release が取れません — タグを引数に指定してください"
    exit 2
  fi
fi

echo ""
echo "==> 1. Release $TAG 基本情報"
INFO=$(gh release view "$TAG" --json tagName,publishedAt,assets,url -q . 2>/dev/null || echo "")
if [ -z "$INFO" ]; then
  echo "  ${WARN_COLOR}!${RESET} Release が見つかりません"
  exit 1
fi
PUBLISHED=$(echo "$INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('publishedAt',''))")
URL=$(echo "$INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('url',''))")
echo "  publishedAt: $PUBLISHED"
echo "  url:         $URL"
# 公開からの経過時間 (Python で日時計算)
ELAPSED=$(python3 -c "
from datetime import datetime, timezone
try:
  pub = datetime.fromisoformat('$PUBLISHED'.replace('Z', '+00:00'))
  now = datetime.now(timezone.utc)
  delta = now - pub
  d = delta.days
  h = delta.seconds // 3600
  m = (delta.seconds % 3600) // 60
  print(f'{d} 日 {h} 時間 {m} 分')
except Exception:
  print('-')
" 2>/dev/null || echo "-")
echo "  経過時間:    $ELAPSED"

echo ""
echo "==> 2. アセット別ダウンロード数"
echo "$INFO" | python3 -c "
import json, sys
info = json.load(sys.stdin)
assets = info.get('assets', [])
if not assets:
  print('  (アセットなし)')
else:
  total = 0
  for a in assets:
    name = a.get('name', '?')
    dl = a.get('downloadCount', 0)
    size = a.get('size', 0)
    total += dl
    print(f'  {dl:>5}x  {name}  ({size/1024/1024:.1f} MB)')
  print(f'  合計: {total} DL')
"

echo ""
echo "==> 3. リリース commit からの追加 push"
git fetch --tags origin >/dev/null 2>&1 || true
if git rev-parse "$TAG" >/dev/null 2>&1; then
  AHEAD=$(git rev-list --count "$TAG..origin/main" 2>/dev/null || echo "?")
  echo "  $TAG 以降 origin/main に積まれた commit: $AHEAD"
  if [ "$AHEAD" != "?" ] && [ "$AHEAD" -gt 0 ]; then
    echo "  最新 5 件:"
    # head の早期 EOF で git log が SIGPIPE → set -e が反応する事故を回避
    { git log --oneline "$TAG..origin/main" 2>/dev/null || true; } | head -5 | sed 's/^/    /' || true
  fi
else
  printf "  ${WARN_COLOR}!${RESET} ローカルに $TAG の tag がありません — git fetch --tags してください\n"
fi

echo ""
echo "==> 4. アプリ内 update 通知"
printf "  ${DIM_COLOR}(現状未実装 — Round 18+ 候補)${RESET}\n"
echo "  実装案: lib/update-check.ts を有効化して GitHub Releases API を週 1 で確認"

echo ""
echo "==> 5. やることチェックリスト"
cat <<'EOF'
  [ ] LP (docs/index.html, docs/en/index.html) のバージョン表記を更新
  [ ] CHANGELOG.md の次バージョンセクションを書き始める
  [ ] SNS / ブログで告知 (Twitter / note / dev.to)
  [ ] 既存ユーザに更新依頼 (LP の「アップデートあり」バナー / メール)
  [ ] roadmap (CLAUDE.md「次ラウンド候補」) を見直し
  [ ] 自分の実機を v0.3.0 DMG で再インストールして smoke-report を取る
       scripts/verify-release.sh v0.3.0
       scripts/verify-app.sh smoke-report
EOF

# Round 20 ㊖: SNS シェアテキスト自動生成
# CHANGELOG から最新セクションのハイライトを抜いて X / note 用に整形
echo ""
echo "==> 6. SNS シェアテキスト (㊖)"
RELEASE_URL="https://github.com/${REPO}/releases/tag/${TAG}"
LATEST_DOWNLOAD="https://github.com/${REPO}/releases/latest/download/KAIKEI_LOCAL.dmg"

# CHANGELOG から ## v<TAG> のセクションを抽出 (release.sh と同じロジック)
HIGHLIGHTS=""
if [ -f CHANGELOG.md ]; then
  VERSION="${TAG#v}"
  HIGHLIGHTS=$(awk -v ver="$VERSION" '
    BEGIN { capturing = 0 }
    /^## v[0-9]/ {
      if (capturing) { exit }
      if (index($0, "v" ver " ") > 0 || index($0, "v" ver "$") > 0 || $2 == "v" ver) {
        capturing = 1
        next
      }
    }
    capturing == 1 && /^- / { print }
  ' CHANGELOG.md | head -3)
fi

echo "----- X / Twitter 用 (~280 字) -----"
cat <<X_TEXT
KAIKEI LOCAL ${TAG} を公開しました。
個人事業主向けの完全オフライン会計アプリ (Mac)。

新規:
$(echo "$HIGHLIGHTS" | head -3 | sed 's/^- /・/')

⬇️ ${LATEST_DOWNLOAD}
詳細: ${RELEASE_URL}
#KAIKEILOCAL #会計アプリ #確定申告
X_TEXT

echo ""
echo "----- note / blog 用 (~600 字) -----"
cat <<NOTE_TEXT
# KAIKEI LOCAL ${TAG} を公開しました

完全オフライン (クラウドへのデータ送信ゼロ) で動く、Mac 用の個人事業主向け
会計アプリ KAIKEI LOCAL の最新版を公開しました。

## このリリースのハイライト

$(echo "$HIGHLIGHTS" | head -5)

## ダウンロード

- Apple Silicon: ${LATEST_DOWNLOAD}
- Intel Mac: https://github.com/${REPO}/releases/latest/download/KAIKEI_LOCAL_x64.dmg

詳細なリリースノート: ${RELEASE_URL}

## このアプリは何?

- データは全てローカル SQLite に保存。クラウド送信なし
- iCloud 写真から領収書を自動抽出 (Vision OCR)
- 仕訳帳・領収書管理・青色申告・e-Tax XTX 出力まで
- 基本機能ずっと無料、AI OCR のみ任意の月額プラン
NOTE_TEXT
