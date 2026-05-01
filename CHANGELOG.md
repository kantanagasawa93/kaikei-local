# Changelog

KAIKEI LOCAL のリリースノート (PDCA ラウンド単位)。

## v0.3.0 (Round 2 + Round 3 成果)

### 受信箱・自動仕訳
- **クイック確定モード**: 受信箱の候補カードで「⚡ いますぐ仕訳化」をワンクリックすると、その場で AI OCR → 領収書登録 → 仕訳まで一気通貫
- **失敗の見える化と再試行**: AI OCR で詰まった写真を `receipt_failed` 状態で残し、エラー理由をカード上に赤バッジで表示。1 件ずつ or 一括で再試行可能
- **Claude OCR 結果の完全保存**: `photo_inbox.claude_result_json` に毎回のレスポンスを保存し、後で再仕訳・監査ができる
- **件数バッジ**: 受信箱フィルタタブに件数を表示 (未判定 6 / 領収書 4 / 失敗 1 / …)
- **未判定に戻す**: 「破棄」「違う」「失敗」のカードからワンクリックで未判定に戻せる逆操作

### 取り込みパフォーマンス
- **スマート増分スキャン**: iCloud から低画質サムネだけ先に取って文書判定 → 通った写真だけフルサイズダウンロード。1000 枚規模で iCloud 帯域が ~1/20 に
- **マイグレーション自動復旧**: sqlx の checksum mismatch を自動検出し、データベースをバックアップしたうえで `_sqlx_migrations` をリセット → マイグレーション再適用 (Round 1 の事故を再発防止)

### 仕訳帳
- **「📷 受信箱」バッジ**: 受信箱経由で自動仕訳された行に画像バッジを表示し、領収書一覧に飛べる

### 配布
- **Universal Binary 動線**: Apple Silicon (M1〜M4) + Intel Mac の両アーキテクチャに対応
  - Apple Silicon: `KAIKEI_LOCAL.dmg` または `KAIKEI_LOCAL_arm64.dmg`
  - Intel Mac: `KAIKEI_LOCAL_x64.dmg`
- LP / インストールガイドにアーキ別ダウンロードボタンを追加

### 自律検証 (開発者向け)
- `kaikei --simulate-scan` / `--db-dump=<table>` / `--tail-scan-log` の CLI 拡張
- `scripts/verify-app.sh smoke` で起動・スキャン・スクショまでを自動化
- GitHub Actions の `Verify Round` ワークフローで commit ごとに macOS で自動検証

---

## v0.2.0 (Round 1)

- Vision OCR の致命バグ修正 (`VNRequestTextRecognitionLevel` の値が逆だった)
- 受信箱の精度・表示・操作性を全面立て直し
- iCloud 写真スキャンの初期版 (PhotoKit + 文書検出フィルタ)
- AI OCR 送信ログビュアー (透明性のため、送信履歴を確認可能)
- LaunchAgent によるバックグラウンド定期スキャン

---

## v0.1.0 (初版)

- ローカル SQLite ベースの会計帳簿
- 領収書・仕訳・銀行明細・請求書・確定申告 (青色 / 白色) 対応
- e-Tax XTX 出力
