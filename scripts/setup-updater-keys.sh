#!/usr/bin/env bash
# ============================================================
# scripts/setup-updater-keys.sh
#
# Round 20 ㊓: Tauri updater plugin の signing key を生成する補助。
# tauri-plugin-updater は public/private 鍵対で署名を検証する仕組みで、
# private key (秘密鍵) はリポジトリに入れずに環境変数で渡し、
# public key (公開鍵) は tauri.conf.json に埋める運用。
#
# このスクリプトは:
#   1. tauri signer generate で .key / .key.pub を生成
#   2. ~/.kaikei-updater.env に TAURI_SIGNING_PRIVATE_KEY を書き出し (chmod 600)
#   3. ~/.kaikei-updater.pub.txt に公開鍵を書き出し
#   4. tauri.conf.json への埋め込み手順を案内
#
# 注: 鍵は 1 度生成したら保管必須。失うと既存 v0.x 系から v0.y 系の
# auto-update ができなくなる。public key は変更不可 (= 鍵ペアを変えると
# 既存インストール済みアプリは新リリースを検証できない)。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

PASS_COLOR="\033[32m"
FAIL_COLOR="\033[31m"
WARN_COLOR="\033[33m"
RESET="\033[0m"

# 既存チェック
PRIV="$HOME/.kaikei-updater.key"
PUB="$HOME/.kaikei-updater.pub.txt"
ENV_FILE="$HOME/.kaikei-updater.env"

if [ -f "$PRIV" ]; then
  printf "${WARN_COLOR}!${RESET} %s が既に存在します。\n" "$PRIV"
  echo "  鍵を再生成すると、既存ユーザは auto-update できなくなります。"
  echo "  本当に上書きする場合は手動で削除してから再実行: rm $PRIV"
  exit 1
fi

# Tauri CLI の存在確認
if ! command -v cargo >/dev/null 2>&1; then
  printf "${FAIL_COLOR}✗${RESET} cargo が PATH にありません。Rust toolchain をインストールしてください。\n"
  exit 1
fi
if ! cargo tauri --help >/dev/null 2>&1; then
  echo "==> Tauri CLI 未インストール — npx tauri を使います"
  TAURI_CMD="npx tauri"
else
  TAURI_CMD="cargo tauri"
fi

echo ""
echo "==> 1. signing key 生成 (パスワード入力を求められます)"
$TAURI_CMD signer generate --write-keys "$PRIV" --force

if [ ! -f "$PRIV" ]; then
  printf "${FAIL_COLOR}✗${RESET} 鍵ファイルが見つかりません — Tauri CLI の出力を確認してください\n"
  exit 1
fi

echo ""
echo "==> 2. private key を ~/.kaikei-updater.env に書き出し"
chmod 600 "$PRIV"
{
  echo "# KAIKEI LOCAL Tauri updater signing key (Round 20 ㊓)"
  echo "# build 時に環境変数として渡すと、tauri build がバイナリに署名する。"
  echo "# このファイルは絶対に git に入れないこと。"
  echo "export TAURI_SIGNING_PRIVATE_KEY=\"\$(cat $PRIV)\""
  echo "export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=\"\""  # passphrase あれば書き換え
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
printf "${PASS_COLOR}✓${RESET} %s\n" "$ENV_FILE"

echo ""
echo "==> 3. public key を ~/.kaikei-updater.pub.txt に保存"
if [ -f "$PRIV.pub" ]; then
  cp "$PRIV.pub" "$PUB"
  printf "${PASS_COLOR}✓${RESET} %s\n" "$PUB"
fi

echo ""
echo "============================================================"
printf "${PASS_COLOR}セットアップ完了${RESET}\n"
echo ""
echo "次の手順 (手動):"
echo "  1. tauri.conf.json の \"plugins\" セクションに updater 設定を追加"
echo "     (Round 21 ㊓ で本実装予定 — 現状は keys 生成のみ)"
echo ""
echo "    \"plugins\": {"
echo "      \"updater\": {"
echo "        \"endpoints\": [\"https://github.com/kantanagasawa93/kaikei-local/releases/latest/download/latest.json\"],"
echo "        \"pubkey\": \"$(cat "$PUB" 2>/dev/null | tr -d '\n')\""
echo "      }"
echo "    }"
echo ""
echo "  2. 公開する build 時に signing key を環境変数として渡す:"
echo "     source ~/.kaikei-updater.env"
echo "     scripts/release.sh v0.x.0"
echo ""
echo "  3. release.sh が latest.json + .sig ファイルも GitHub Release にアップ"
echo "     (Round 21 で release.sh 拡張予定)"
