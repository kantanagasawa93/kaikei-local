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

## 自律検証 (Round 2 で導入、Round 6 で navigate 追加)

ユーザに「アプリ立ち上げて」を頼まずに、Claude 単独で E2E 検証できる:

```bash
scripts/verify-app.sh navigate /inbox      # アプリ内ナビゲーション (㊎)
scripts/verify-app.sh ui-screenshot        # 起動中の窓を PNG 保存
scripts/verify-app.sh smoke-report         # スキャン+DB+ログ+スクショを Markdown に
scripts/verify-app.sh db-dump photo_inbox  # DB を JSON 配列で
scripts/verify-release.sh v0.3.0           # リリース DMG の URL probe + 公証チェック
```

## 次ラウンド (Round 24) 候補 — ユーザは「全部やって」希望 (10 個)

新チャット起動時、起動ルーチン後にこの候補を 1 ラウンドにパックして実装する。
推し優先順は ㊗ → ㊞ → ㊟ → ⓐ → ⓑ → ⓒ → ⓓ → ⓔ → ⓕ → ⓖ。

ユーザの判断 / 操作を増やさない方向に偏重。

### ㊗ v0.3.0 公証付きリリース実発火 ★★★★★ (持ち越し中)
- credentials を入れた瞬間に `release.sh v0.3.0` で発火可能 (3〜5 ラウンド持ち越し)

### ㊞ 仕訳の自動補完: 取引先名 → 勘定科目 ★★★★
- partners.default_account_code を仕訳画面で活用。摘要に partner.name が含まれてたら
  default_account_code を自動セット (ユーザは確認だけ)
- 対象: src/lib/auto-journal.ts の suggestAccount + journals/new + edit

### ㊟ ダッシュボードに「要確認の仕訳」ウィジェット ★★★★
- Round 23 ⓓ の判定ロジックを再利用。ダッシュボードに「要確認 N 件」のカードを
  出してクリックで /journals?incomplete=1 へ遷移
- 対象: dashboard/page.tsx + journals/page.tsx の URL クエリ受理拡張

### ⓐ 重複領収書統合の対象に Vision OCR 結果も含める ★★★
- 現状 Round 23 ⓐ は ocr_text 先頭一致のみ。同一画像 (file_hash) の比較も追加
- 対象: photo-scanner.ts に SHA256 計算 (Tauri command 経由)

### ⓑ 領収書一覧 bulk delete + bulk export ★★★
- Round 22 ㊛ パターンを receipts に。CSV エクスポートも同梱
- 対象: src/app/(app)/receipts/page.tsx

### ⓒ updater 自動チェックを「設定」画面から手動実行 ★★
- 現状は起動 4 秒後の自動チェックのみ。「今すぐ確認」「最新の状態か診断」ボタン
- 対象: settings/page.tsx + auto-updater.ts

### ⓓ verify-app.sh smoke-report に migrations 状態を追加 ★★
- migrations_status の v1〜v9 出力をレポートに含める
- 対象: scripts/verify-app.sh

### ⓔ 月次グラフに「年度切替」セレクタ ★★★
- 過去年度をプルダウンで選んで比較
- 対象: dashboard/page.tsx (loadMonthly に year 引数)

### ⓕ tax_classes / accounts マスタ画面 ★★★
- DB には入ってるが UI 未実装。閲覧 + ユーザ追加 + デフォルト変更
- 対象: src/app/(app)/masters/{tax-classes,accounts}/page.tsx (新規)

### ⓖ 受信箱「破棄」タブで「expired_30d」だけフィルタ ★★
- Round 23 ㊜ で auto_dismissed_reason に "expired_30d" を入れた。
  「期限切れだけ復活したい」需要のために理由別フィルタ
- 対象: src/app/(app)/inbox/page.tsx

### ✓ Round 23 で完了した項目 (履歴)
- ㊜ 30 日経過の未閲覧 candidate を自動 dismissed (boot.tsx で 1 日 1 回 sweep)
- ㊝ AI OCR 失敗の自動リトライ (network/server bucket だけ 1 回)
- ⓐ 重複領収書の自動統合 (ocr_text 先頭 60 文字一致 + 過去 90 日)
- ⓑ 月次リマインダー (LaunchAgent 経由、月末/2月15日/3月10日)
- ⓒ 仕訳の検索バー (摘要 + 金額レンジ)
- ⓓ 不完全な仕訳の amber Badge + 「要確認のみ」フィルタ
- ⓔ 年度サマリ PDF に issuer_settings (屋号/owner/住所/インボイス番号)
- ⓕ 連写バーストの代表のみ取り込み (representsBurst)
- ⓖ 受信箱上部に直近スキャンサマリーバー (取込/除外/重複統合 + 設定リンク)
- 写真スキャン厳格フィルタ (常時 ON、設定トグル無し) — Round 22.5 で対応済み

### ✓ Round 22 で完了した項目 (履歴)
- ㊚ updater 失敗時 404=未公開 を error 扱いしない (auto-updater + UpdateBanner 二重ガード)
- ㊛ 仕訳タグの一括操作 (bulk select + BulkTagModal + ワンクリック「経費精算済」)
- ⓐ ダッシュボード月次グラフを CSV 出力 (summarizeByMonth + buildMonthlySummaryCsv)
- ⓑ 取引先一覧で auto-learned バッジ + 一括承認/削除 (notes ベース判定)
- ⓒ 受信箱「全部既読」ボタン (markInboxAllViewed)
- ⓓ 月次グラフドリルダウン (棒クリック → /journals?month=YYYY-MM)
- ⓔ 年度サマリ PDF (exportFiscalYearSummaryPdf + buildFiscalYearSummary)
- ⓕ verify-app.sh autorun + watch に cmd_extract_log_errors 組込
- ⓖ 受信箱 ScoreSignalsBadge (hover popover、改行 + 色付き)

### ✓ Round 21 で完了した項目 (履歴)
- ㊘ tauri-plugin-updater 本格導入 (Cargo + lib.rs + tauri.conf.json + UI)
- ㊙ release.sh で latest.json + .app.tar.gz + .sig を Release 同梱
- ⓐ PHAsset.isFavorite を classifier の領収書スコアにブースト
- ⓑ photo_inbox 既読/未読 (migration v8 + 未確認バッジ + markInboxViewed)
- ⓒ journals tags (migration v9 + chip UI + TagEditModal)
- ⓓ ダッシュボード月次グラフ (12ヶ月の売上/経費 棒グラフ)
- ⓔ 仕訳の年度別 CSV エクスポート (会計年度 1/1〜12/31)
- ⓕ 取引先 OCR 自動学習 (vendor_name → partners 自動 INSERT + [auto-learned] notes)
- ⓖ verify-app.sh tail-stream サブコマンド (tail -F)

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
- **cocoa 0.26 の `BOOL` は Rust の `bool` 型エイリアス**: `BOOL != 0` 等の i32 比較で書くと `error[E0277]: can't compare bool with integer` が出る。`let b: BOOL = msg_send![..., isFavorite];` のように直接 `bool` として扱う (Round 21 ⓐ で踏んだ)
- **`npm install <pkg>` は package.json に無い既存依存を prune する**: tauri-plugin の dist が node_modules に「先に置かれている」運用 (= package.json 未記載) だと、`npm install` 1 回で `@tauri-apps/plugin-fs` 等が消える事故になる。Round 21 で plugin-process / plugin-updater を入れた瞬間、plugin-dialog/fs/log/shell/sql が全部消えて next build がコケた。対策: 全部の tauri-plugin を package.json に明示
- **tauri-plugin-updater の pubkey は tauri.conf.json plugins.updater.pubkey 必須**: 環境変数 TAURI_SIGNING_PRIVATE_KEY と対応する公開鍵を embed しないと「Could not fetch a valid release JSON」と「verify failed」のどちらかで失敗する。鍵生成は `npx -p @tauri-apps/cli tauri signer generate --ci -p "" -w ~/.kaikei-updater.key -f` で非対話化可能
- **Next 16 static export で `useSearchParams()` には Suspense boundary 必須**: 直接呼ぶと `useSearchParams() should be wrapped in a suspense boundary` で `next build` がコケる。static export (Tauri アプリ) なら `window.location.search` を `useEffect` 内で読む方がシンプル (Round 22 ⓓ で踏んだ)
- **photo_inbox の「未判定」雪崩問題**: 写真ライブラリ全件を素直に取り込むと、家族写真・風景・チャットスクショが全部 candidate になって受信箱が詰まる。Round 23 で **常時 ON のフィルタ** を導入: photos.rs Stage 0 で isHidden / 短辺<600px / アスペクト比>1:5 を弾き、photo-scanner.ts と scanner.rs で「OCR テキスト空 + classifier.score==0」を photo_inbox に INSERT すらしない (file も削除)。設定トグルは出さない (= ユーザに判断を求めない、付加価値が下がるため)。scan 結果に `skipped` 件数を返して toast に併記
- **PHAsset.isFavorite (♥) は強シグナル扱いしない**: Round 21 ⓐ で classifier に +0.10 のスコアブーストを入れたのは妥当だが、Round 23 当初に追加した「♥なら厳格フィルタ免除」は誤り。♥は家族写真・思い出・友人スナップにも付くので「領収書として必ず取り込む」根拠にはならない。score ブーストは「OCR で何か読めた時の弱い positive シグナル」として残し、フィルタ免除は外す

