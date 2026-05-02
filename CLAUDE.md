@AGENTS.md

# Working agreement (PDCA mode)

- 何でも許可。確認なしで自律的に進めて OK
- ラウンド単位で区切る (1 ラウンド = 1 commit)
- ラウンド開始時に **次候補 4-5 個を提案**。ユーザが「全部やって」「順に」なら全部 1 ラウンドにパック。番号指定ならその候補だけ
- 検証ルーチン: lint → build (Rust + TS) → commit → (許可後) ローカル app 差し替え + 起動

## デプロイコマンド (このプロジェクトは Tauri デスクトップなので "公開先" はリリース DMG)

```bash
# 1) ローカルアプリを最新ビルドに差し替え (実機検証用)
osascript -e 'quit app "KAIKEI LOCAL"' 2>/dev/null; killall kaikei 2>/dev/null; sleep 1
npm run build && npx tauri build --bundles app --debug
rm -rf "/Applications/KAIKEI LOCAL.app"
cp -R "src-tauri/target/debug/bundle/macos/KAIKEI LOCAL.app" /Applications/
codesign --force --deep --sign - --entitlements src-tauri/entitlements.plist --options runtime "/Applications/KAIKEI LOCAL.app"
open "/Applications/KAIKEI LOCAL.app"

# 2) 公式リリース (署名+公証+両アーキ DMG → GitHub Release)
scripts/release.sh v0.X.Y
```

## コミット文体

タイトル: `PDCA Round <N>: <一言要約>`

本文構造:
```
R<N>-A <要約>:
  - 何をしたか / なぜ / 影響範囲
R<N>-B <要約>:
  ...

検証:
  - cargo check: ✓ / ✗ (errors)
  - tsc --noEmit: ✓ / ✗
  - .app bundle: ✓ / ✗
  - 実機: <あれば>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## 守りどころ
- 写真・領収書データは **ローカル DB と APPDATA 配下のみ**。Claude OCR への送信は明示同意がある時だけ
- migration を増やす時は `migrations.rs` のバージョンを 1 上げる + `lib.rs` の `sql_migrations` Vec に追加
- objc 0.2 + cocoa 0.26 + block 0.1 で FFI を書く慣習。新規 ObjC API は `Class::get` で動的解決 → 古い OS でも crash しない
- `next build` は `next.config.ts` に `output: "export"` がある前提で `out/` を吐く
- アセット URL は asset:// (convertFileSrc) ではなく **`read_image_file` Tauri command + Blob URL** 経由 (パススコープ問題回避)

## 自律検証 (Round 2 で導入、毎ラウンド使用)

ユーザに「アプリ立ち上げて」を頼まずに、Claude 単独で E2E 検証できる:

```bash
scripts/verify-app.sh ui-screenshot  # 起動中の窓をPNGで保存
scripts/verify-app.sh simulate-scan  # ヘッドレススキャン JSON 出力
scripts/verify-app.sh db-dump photo_inbox   # DB を JSON 配列で
scripts/verify-app.sh tail-log 50    # ~/Library/Logs/.../scan.log 末尾
scripts/verify-app.sh smoke          # 上記を順に
```

CLI 直叩き: `/Applications/KAIKEI LOCAL.app/Contents/MacOS/kaikei --verify-help`

## 次ラウンド (Round 6) 候補 — ユーザは「全部やって」希望

新チャット起動時、起動ルーチン後にこの候補を 1 ラウンドにパックして実装する。
推し優先順は ㊊ → ㊋ → ㊌ → ㊍ → ㊎。

### ㊊ v0.3.0 公証付きリリース実発火 ★★★★★
- 目的: Round 5 までで NOTARIZE_SKIP=1 までは Claude で打てるが、Gatekeeper 警告が
  出ない正式 DMG はユーザの手元で公証付き発火が必要
- 手元手順 (再掲):
  ```
  # Apple Developer Account: https://appleid.apple.com で app-specific password 生成
  xcrun notarytool store-credentials AC_PASSWORD \
    --apple-id "k.nagasawa.pc@gmail.com" \
    --team-id "6FU765RJ9M" \
    --password "<app-specific-password>"
  export APPLE_SIGNING_IDENTITY="Developer ID Application: kanta nagasawa (6FU765RJ9M)"
  export APPLE_ID="k.nagasawa.pc@gmail.com"
  export APPLE_PASSWORD="@keychain:AC_PASSWORD"
  export APPLE_TEAM_ID="6FU765RJ9M"
  scripts/release-precheck.sh v0.3.0   # 全項目 ✓
  scripts/release.sh v0.3.0            # 公証付きリリース
  ```

### ㊋ 受信箱「いますぐ仕訳化」の事前 warn (1 件単位) ★★★
- 目的: Round 5 ㊆ で「全部仕訳化」前の事前 warn は付けたが、quickConfirmOne
  にも同じロジックを入れる。1 件押す前にも license/consent エラーを止める
- 対象: src/lib/auto-journal.ts: quickConfirmOne 冒頭で getFailureStats →
  actionable な top 原因が 2 件以上で confirm
- commit サイズ: 小 (~50 行)

### ㊌ 受信箱から領収書詳細を直接 hover プレビュー ★★★
- 目的: 受信箱カードを hover すると右側に領収書のフル画像 + Vision OCR の
  rich preview が拡大表示されて、確定前にどんな写真かよく分かる
- 対象: src/app/(app)/inbox/page.tsx
- やること: portal で固定位置の preview pane、hover 出入り debounce
- commit サイズ: 中 (~150 行)

### ㊍ 仕訳の「差し戻し」アクションを安全な undo に拡張 ★★★★
- 目的: Round 4 ㊂ で「受信箱に戻す」を入れたが、誤操作で押しても元に戻せない
- 対象: src/lib/auto-journal.ts: reverseJournalToInbox の前にスナップショット
  を取っておき、直近 N 件は復元できるようにする (app_settings に JSON で保存)
- UI: 仕訳帳に「直近の差し戻しを取り消す」ボタン
- commit サイズ: 中〜大 (~200 行)

### ㊎ verify-app.sh の追加サブコマンド: navigate ★★
- 目的: 「受信箱に飛んでスクショ」「設定 → AI OCR ログに飛んでスクショ」を
  Claude 単独でやる動線。現状 osascript でキー操作が出来ない (TCC) のを
  Tauri command 経由 (window.location 操作) で代替
- 対象: src-tauri/src/lib.rs に navigate_to コマンド + scripts/verify-app.sh
  に navigate サブコマンド
- commit サイズ: 小〜中 (~100 行)

## 学習済みアンチパターン (再発防止メモ)

- **Vision の `VNRequestTextRecognitionLevel` 値**: `Accurate = 0`, `Fast = 1`。逆に書くと OCR が常に 0 行を返す事故になる。Apple ヘッダの `NS_ENUM` の宣言順がそのまま raw value
- **iPhone カメラ写真は HEIC**: PHImageManager から取った原本データを `.jpg` 拡張子で保存しても中身は HEIC。WebView 表示が壊れるので CIImage で JPEG に再エンコードする (photos.rs `ensure_jpeg`)
- **Tauri の asset プロトコル `$APPDATA` スコープ**: 絶対パスとの比較で NFD/NFC 等の細かい不整合があり信頼性が低い。`read_image_file` Rust コマンド + Blob URL に統一して回避
- **next.config.ts の `output: "export"` 不在**: `next build` が `out/` を作らず `tauri build` がコケる。今は明示設定済み
- **scanner の stderr が消える**: `open --args` 経由で起動された子プロセスの stdio は plist の StandardErrorPath には届かない。scanner 自身がログファイル (`~/Library/Logs/KAIKEI LOCAL/scan.log`) に追記する設計に
- **VNDetectDocumentSegmentationRequest は false positive 多い**: 「文書らしい矩形」は壁掛け絵・PC モニタ画面・ガジェットラベル等にも反応する。これだけで「領収書」判定するのは無理 → 必ず VNRecognizeText のキーワード判定と組み合わせる
- **NSPredicate の variadic format**: `predicateWithFormat:`+可変長は Rust FFI 不可。`predicateWithFormat:argumentArray:` (NSArray) 経由必須
- **DB migration が UI 起動なしで走らない**: tauri-plugin-sql は最初の `Database.load(...)` 呼出時にマイグレーション。CLI scanner が migration 当たってない DB を触ると table 不在エラー → CLI 側で `sqlite_master` チェックして graceful exit する設計に
- **sqlx の checksum mismatch**: `_sqlx_migrations` に記録された hash と現在の SCHEMA_SQL の hash が違うと sqlx は「migration N was previously applied but has been modified」を投げて、それ以降のマイグレーションが一切走らない。Round 3 ⓐ で `db_repair_migration_checksum` Tauri command + localDb.ts の自動復旧を実装済み (DB 自動バックアップ → `_sqlx_migrations` クリア → 再 load)。SCHEMA_SQL を「絶対に既存版数の中身を変えない」運用が原則 (新規版数を追加するのみ)
- **SQLite で CHECK 制約を変えるにはテーブル再作成必要**: ALTER TABLE ... DROP CHECK は無いので、新テーブル作成 → INSERT SELECT → DROP → RENAME。Round 2 v4 で `state` enum 拡張時に採用

