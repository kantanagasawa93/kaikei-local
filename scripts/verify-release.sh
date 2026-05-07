#!/usr/bin/env bash
# ============================================================
# scripts/verify-release.sh <tag>
#
# scripts/release.sh で公開した GitHub Release が
# 「ユーザーがダウンロードして問題なくインストールできる状態」になっているかを
# 完全自動で検証する Round 6 ㊊ 用ツール。
#
# 検証項目:
#   1. gh release view で release が存在する
#   2. 各 DMG asset の URL (latest/download) が HTTP 200 を返す
#   3. arm64 / x64 / latest 互換 の 3 ファイルが揃っている
#   4. ダウンロードした DMG が:
#      - 署名済み (spctl --assess --type install)
#      - 公証ステープル済み (xcrun stapler validate)
#      - 期待アーキテクチャの .app が中に入っている (file コマンドで確認)
#
# 使い方:
#   scripts/verify-release.sh v0.3.0
#   QUICK=1 scripts/verify-release.sh v0.3.0   # DL+公証チェック skip (URL 200 だけ)
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "ERROR: タグを指定してください (例: scripts/verify-release.sh v0.3.0)"
  exit 2
fi

PASS_COLOR="\033[32m"
FAIL_COLOR="\033[31m"
WARN_COLOR="\033[33m"
RESET="\033[0m"
failures=0
warnings=0
pass() { printf "  ${PASS_COLOR}✓${RESET} %s\n" "$1"; }
fail() { printf "  ${FAIL_COLOR}✗${RESET} %s\n" "$1"; failures=$((failures+1)); }
warn() { printf "  ${WARN_COLOR}!${RESET} %s\n" "$1"; warnings=$((warnings+1)); }

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "?/?")
LATEST_BASE="https://github.com/${REPO}/releases/latest/download"

echo ""
echo "==> 1. GitHub Release の存在確認 (tag=$TAG)"
if gh release view "$TAG" >/dev/null 2>&1; then
  pass "Release $TAG が存在"
  RELEASE_INFO=$(gh release view "$TAG" --json assets,publishedAt,isDraft,isPrerelease -q ".")
  is_draft=$(echo "$RELEASE_INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('isDraft', False))")
  is_pre=$(echo "$RELEASE_INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('isPrerelease', False))")
  if [ "$is_draft" = "True" ]; then
    fail "isDraft = True — Release が draft 状態。publish が必要"
  fi
  if [ "$is_pre" = "True" ]; then
    warn "isPrerelease = True — pre-release のため latest/download には向かない"
  fi
  # Latest 判定は GitHub API の /releases/latest を直接叩いて判別
  latest_tag=$(gh api "repos/$REPO/releases/latest" -q .tag_name 2>/dev/null || echo "")
  if [ "$latest_tag" = "$TAG" ]; then
    pass "/releases/latest = $TAG"
  else
    warn "/releases/latest = $latest_tag (この検査対象 $TAG ではない)"
  fi
else
  fail "Release $TAG が見つかりません — まず scripts/release.sh $TAG で作ってください"
  echo ""
  printf "${FAIL_COLOR}NG${RESET}: 致命エラー $failures 件\n"
  exit 1
fi

echo ""
echo "==> 2. 期待されるアセット 3 つの存在確認"
expected_assets=("KAIKEI_LOCAL.dmg" "KAIKEI_LOCAL_arm64.dmg" "KAIKEI_LOCAL_x64.dmg")
asset_names=$(echo "$RELEASE_INFO" | python3 -c "
import json,sys
info = json.load(sys.stdin)
for a in info.get('assets', []):
    print(a['name'])
")
for asset in "${expected_assets[@]}"; do
  if echo "$asset_names" | grep -qx "$asset"; then
    size_bytes=$(echo "$RELEASE_INFO" | python3 -c "
import json,sys
info = json.load(sys.stdin)
for a in info.get('assets', []):
    if a['name'] == '$asset':
        print(a.get('size', 0))
        break
")
    size_mb=$(awk "BEGIN { printf \"%.1f\", $size_bytes / 1024 / 1024 }")
    if [ "$(awk "BEGIN { print ($size_mb < 5) }")" = "1" ]; then
      warn "$asset: ${size_mb} MB しかありません — 壊れた DMG?"
    else
      pass "$asset (${size_mb} MB)"
    fi
  else
    fail "$asset が release に存在しません"
  fi
done

echo ""
echo "==> 3. 公開 URL (latest/download) が 200 を返すか"
for asset in "${expected_assets[@]}"; do
  url="${LATEST_BASE}/${asset}"
  # GitHub は redirects するので -L で追う。-I HEAD で速く
  status=$(curl -sILo /dev/null -w "%{http_code}" "$url" -L --max-time 30 || echo "000")
  if [ "$status" = "200" ]; then
    pass "$asset → HTTP $status"
  else
    fail "$asset → HTTP $status (URL: $url)"
  fi
done

if [ -n "${QUICK:-}" ]; then
  echo ""
  echo "==> 4. DL + 公証チェックは QUICK=1 のためスキップ"
else
  echo ""
  echo "==> 4. ARM DMG をダウンロードして公証 + 署名 + .app 抽出を検証"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  arm_dmg="$TMP/KAIKEI_LOCAL_arm64.dmg"

  if curl -fsSL --max-time 120 "${LATEST_BASE}/KAIKEI_LOCAL_arm64.dmg" -o "$arm_dmg" 2>/dev/null; then
    pass "DL 完了 ($(du -h "$arm_dmg" | awk '{print $1}'))"

    # 公証ステープル済みか
    if xcrun stapler validate "$arm_dmg" 2>&1 | grep -q "ready to be distributed"; then
      pass "stapler validate: 公証ステープル済み"
    else
      warn "stapler validate 失敗 — 公証なし or staple 未実行 (Gatekeeper 警告が出る可能性)"
    fi

    # spctl で Gatekeeper 受け入れチェック
    if spctl -a -vv --type install "$arm_dmg" 2>&1 | grep -q "accepted"; then
      pass "spctl: Gatekeeper accepted"
    else
      warn "spctl: Gatekeeper not accepted — 未署名 / 公証なしの可能性"
    fi

    # マウントして .app の architecture を確認
    mount_point=$(hdiutil attach -nobrowse -noverify -noautoopen "$arm_dmg" 2>/dev/null | tail -1 | awk '{print $NF}' || true)
    if [ -n "$mount_point" ] && [ -d "$mount_point" ]; then
      app="$mount_point/KAIKEI LOCAL.app"
      if [ -d "$app" ]; then
        bin="$app/Contents/MacOS/kaikei"
        if [ -x "$bin" ]; then
          arch_info=$(file "$bin" 2>&1 | head -1)
          if echo "$arch_info" | grep -q "arm64"; then
            pass ".app の binary は arm64 ✓"
          else
            warn ".app の binary が arm64 ではない: $arch_info"
          fi
        else
          fail ".app の binary (kaikei) が見つかりません"
        fi
      else
        fail ".app が DMG にマウントされていません"
      fi
      hdiutil detach -quiet "$mount_point" 2>/dev/null || true
    else
      warn "DMG をマウントできませんでした (中身検査 skip)"
    fi
  else
    warn "DL 失敗 (URL は 200 を返したが本体取れず) — 中身検査 skip"
  fi
fi

echo ""
echo "==> 5. docs サイト (kantanagasawa93.github.io) の導線確認"
# Round 25 ⓔ + Round 26 ⓔ: install.html / index.html で
#  - DMG リンク (latest/download or releases/download) が含まれてるか
#  - リリースタグ (= $TAG) が body 内に文字列として現れるか
#    → 古いバージョンが LP に残っていないかの「最新追従」確認
DOCS_BASE="https://kantanagasawa93.github.io/kaikei-local"
TAG_BARE="${TAG#v}"  # v0.3.0 → 0.3.0
for path in "/install.html" "/"; do
  url="${DOCS_BASE}${path}"
  status=$(curl -sILo /dev/null -w "%{http_code}" "$url" -L --max-time 30 || echo "000")
  if [ "$status" = "200" ]; then
    body=$(curl -fsSL --max-time 30 "$url" 2>/dev/null || echo "")
    if echo "$body" | grep -q "KAIKEI_LOCAL.dmg\|releases/latest/download\|releases/download"; then
      pass "${path} — ページ表示 + DMG リンクあり"
    else
      warn "${path} — 200 だが DMG リンクが見つからない (LP 更新忘れ?)"
    fi
    # Round 26 ⓔ: リリースタグが LP 本文に現れているか
    # (latest/download URL を使う場合は version が出ない可能性もあるので warn 止め)
    if echo "$body" | grep -q "v${TAG_BARE}\|$TAG"; then
      pass "${path} — リリース v${TAG_BARE} が LP に反映されている"
    else
      warn "${path} — LP 本文に v${TAG_BARE} が見つからない (latest URL 利用なら OK / 旧 ver 表記が残ってる可能性)"
    fi
  elif [ "$status" = "404" ]; then
    if [ "$path" = "/" ]; then
      fail "${path} → HTTP $status (LP が公開されていない)"
    else
      warn "${path} → HTTP 404 (このページは未公開)"
    fi
  else
    warn "${path} → HTTP $status"
  fi
done

echo ""
echo "============================================================"
if [ "$failures" -eq 0 ]; then
  printf "${PASS_COLOR}OK${RESET}: 致命エラー 0 件 / 警告 ${warnings} 件\n"
  echo "ユーザは https://github.com/${REPO}/releases/latest からダウンロードできます。"
  exit 0
else
  printf "${FAIL_COLOR}NG${RESET}: 致命エラー ${failures} 件 / 警告 ${warnings} 件 — リリースに不備があります\n"
  exit 1
fi
