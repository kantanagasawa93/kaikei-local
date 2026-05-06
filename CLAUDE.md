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

## 次ラウンド (Round 23) 候補 — ユーザは「全部やって」希望 (10 個)

新チャット起動時、起動ルーチン後にこの候補を 1 ラウンドにパックして実装する。
推し優先順は ㊗ → ㊜ → ㊝ → ⓐ → ⓑ → ⓒ → ⓓ → ⓔ → ⓕ → ⓖ。

### ㊗ v0.3.0 公証付きリリース実発火 ★★★★★ (Round 21-22 で持ち越し)
- 手元で `scripts/release-setup-credentials.sh` → `scripts/release.sh v0.3.0`
- updater bundle (latest.json + .app.tar.gz + .sig) は release.sh 側で自動同梱
- Apple credentials が用意できた瞬間に発火可能

### ㊜ tax_classes / accounts マスタ画面を実装 ★★★★
- 現状 DB には入っているが UI から閲覧/編集できない
- 対象: src/app/(app)/masters/ 配下に新規 page (税区分 + 勘定科目)
- commit サイズ: 中 (~200 行)

### ㊝ 仕訳の検索バー (摘要 + 金額レンジ) ★★★★
- 仕訳が増えると monthFilter だけでは足りない。摘要 LIKE + 金額の上限/下限
- 対象: journals/page.tsx (既存 monthFilter / tagFilter と並列化)
- commit サイズ: 中 (~150 行)

### ⓐ 月次グラフに「年度切替」セレクタ ★★★
- 現状は今年度のみ。過去年度をプルダウンで選んで月次推移を比較
- 対象: dashboard/page.tsx (loadMonthly に year 引数)
- commit サイズ: 小 (~80 行)

### ⓑ 領収書一覧の bulk delete + bulk export ★★★
- Round 22 ㊛ で journals に bulk select を入れた。同パターンを receipts に
- 対象: src/app/(app)/receipts/page.tsx
- commit サイズ: 中 (~120 行)

### ⓒ ScoreSignalsBadge をクリックで詳細モーダル化 ★★
- Round 22 ⓖ の popover は hover 限定。タッチ機種・キーボードのみのユーザは
  click でも開けるように
- 対象: src/app/(app)/inbox/page.tsx ScoreSignalsBadge
- commit サイズ: 小 (~50 行)

### ⓓ partners 一括承認時にメモを残す ★★
- Round 22 ⓑ で承認時に notes から [auto-learned] 行を消すが、「いつ承認したか」
  が分からない。承認日時を notes に追記する
- 対象: src/app/(app)/partners/page.tsx の bulkApprove
- commit サイズ: 小 (~30 行)

### ⓔ 年度サマリ PDF にロゴ + 発行者情報を入れる ★★★
- issuer_settings (Round 2 ㊁) を読んで PDF ヘッダに屋号 + 住所 + インボイス番号
- 対象: src/lib/pdf-export.ts の exportFiscalYearSummaryPdf
- commit サイズ: 中 (~100 行)

### ⓕ updater 自動チェックを「設定」画面から手動実行できるように ★★
- 現状は起動 4 秒後の自動チェックのみ。設定画面で「今すぐ確認」ボタン
- 対象: src/app/(app)/settings/page.tsx + auto-updater.ts
- commit サイズ: 小 (~60 行)

### ⓖ verify-app.sh smoke-report に migrations 状態を追加 ★★
- 現状は DB 内容のダンプのみ。migrations_status の出力 (v1〜v9) を含める
- 対象: scripts/verify-app.sh の cmd_smoke_report
- commit サイズ: 小 (~40 行)

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
- **photo_inbox の「未判定」雪崩問題**: 写真ライブラリ全件を素直に取り込むと、家族写真・風景・チャットスクショが全部 candidate になって受信箱が詰まる。Round 23 で **厳格フィルタ** を導入: photos.rs Stage 0 で isHidden / 短辺<600px / アスペクト比>1:5 を弾き、photo-scanner.ts と scanner.rs で「OCR テキスト空 + classifier.score==0」を photo_inbox に INSERT すらしない (file も削除)。app_settings.inbox_strict_filter='false' で OFF 可能 (デフォルト ON)。scan 結果に `skipped` 件数を返して toast に併記
- **PHAsset.isFavorite (♥) は強シグナル扱いしない**: Round 21 ⓐ で classifier に +0.10 のスコアブーストを入れたのは妥当だが、Round 23 当初に追加した「♥なら厳格フィルタ免除」は誤り。♥は家族写真・思い出・友人スナップにも付くので「領収書として必ず取り込む」根拠にはならない。score ブーストは「OCR で何か読めた時の弱い positive シグナル」として残し、フィルタ免除は外す

