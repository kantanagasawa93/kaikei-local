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

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
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

## 次ラウンド (Round 31) 候補

推し優先順は ㊗ → ㊰ → ㊱ → ㊋ → ㊊。

### ㊗ v0.3.1 リリース実発火 ★★★★★ (prep 済み・creds 待ち)
- version bump + CHANGELOG + DRY_RUN 検証は Round 29.5/30 で完了済み (`ea22c7b` +本ラウンド)
- 要・ユーザ操作 (5 分): ①Apple ID の App 用パスワード `kaikei-release` を削除 (旧パスワードは
  チャットログに平文で残っていて keychain 上まだ有効 = セキュリティ課題) → ②新パスワード生成
  → ③`scripts/release-setup-credentials.sh` で AC_PASSWORD profile 再作成
- その後 `source ~/.kaikei-release.env && scripts/release.sh v0.3.1` で Claude 単独で発火可能
- これが通ると release.sh 初の end-to-end 完走 + Intel x64 実配布 + updater の x86_64 経路開通

### ㊰ 家事按分と減価償却仕訳の整合検証 ★★★★
- Round 30 で固定資産→償却仕訳 (611 事業分 + 190 家事分) を作れるようになった。
  家事按分ページの「再計算」が 611 を按分対象にすると二重按分になるリスクを検証し、
  按分対象科目から 611 を除外 or 警告を出す
- 対象: src/app/(app)/allocations/page.tsx + 検証は verify-app.sh db-dump

### ㊱ journals/page.tsx (1,269 行) の分割 ★★★
- settings (Round 30) と同じ要領で src/components/journals/ にカード/モーダルを切り出し
- 対象: src/app/(app)/journals/page.tsx

### ㊋ freee/MF エクスポートの税区分マッピング表 ★★★ (Round 29 から持ち越し)
- kaikei tax_classes.code → freee/MF の税区分名への変換表で手読み替えを不要に
- 対象: src/lib/journal-export.ts (TAX_CODE_TO_FREEE / _TO_MF マップ) — vitest テスト付きで

### ㊊ auto_rules の stale ルール掃除 ★★★ (Round 29 から持ち越し)
- 正答率<30% or 90 日以上未適用のルールを「見直し候補」として /auto-rules 上部に提示
- 対象: src/lib/auto-rules.ts (detectStaleRules) + src/app/(app)/auto-rules/page.tsx

### 候補プール (旧 Round 29 候補の残り)
- ⓐ 定期取引候補の一括ルール化 / ⓑ partner Undo 複数段戻し / ⓒ 失敗 bucket 一括再試行
- ⓓ readiness スヌーズ / ⓔ verify-app.sh regression サブコマンド
- ⓕ updater フォールバック OS/アーキ別 / ⓖ 再 OCR 中断ボタン
- eslint 既存 19 エラーの解消 (hoisted 関数の使用前参照 / setState-in-effect — 旧ページ 17 箇所)

### ✓ Round 30 で完了した項目 (履歴) — テーマ「申告ロジックの正しさ + 品質基盤」
- ㊕ 固定資産「N年分を仕訳化」: 12/31 付の償却仕訳 (611 事業分 + 190 家事分 / 資産科目) 一括作成
  + fixed_asset_depreciations 記録 + 重複ガード。これまで台帳表示のみで申告に流れていなかった
- ㊖ 減価償却を税法整合に: 国税庁償却率表 (ceil(1000/n)/1000)・備忘価額1円・償却限度額繰越。
  旧実装は最終年一括計上で限度額超過だった (depreciation.ts 全面書き直し)
- ㊗ e-Tax 減価償却明細: 事業専用割合 ×100 バグ修正 + 月数月割り + 率表準拠 (etax/mapping.ts)
- ㊘ 基礎控除の令和7年度改正対応 (2025 年分以降 58〜95 万の新テーブル、年 param 追加)
- ㊙ vitest 導入 + 金額系ユニットテスト 49 件 (`npm run test`)。@tauri-apps/* は src/test-stubs/ で差し替え
- ㊚ localDb ネスト select パーサを localdb-parse.ts に純関数抽出 + 回帰テスト。
  `.single()` 0 件時に [] ではなく null を返すよう修正 (Supabase 互換)
- ㊛ 月次推移 PL に対象外科目のゼロ行が混ざるのを修正 (reports.ts)
- ㊜ settings/page.tsx を 8 コンポーネントに分割 (1,269 → 約 100 行、src/components/settings/)。
  バックアップ meta.json の version "0.1.0" 固定を実バージョン取得に
- ㊝ eslint ignore 追加 (src-tauri/target 等の偽エラー 2,500+ 件 → 実エラー 19 件に)
- ㊞ (Round 29.5) v0.3.1 prep: version 3 ファイル + CHANGELOG + release.sh DRY_RUN 検証

### ✓ Round 29 で完了した項目 (履歴)
- 巨大ファイル分割 (inbox/page.tsx 2,216 → 1,417 行、src/components/inbox/)
- AI OCR 使用量モニタ (ai-ocr-usage.ts + 設定画面 UsageStatsRow)
- Vision フォールバック (AI OCR 失敗時に Vision OCR で仮仕訳)
- Gemini quota バナー / Tier 1 課金キー切替 / 429 明示エラー (f408b31, 517921d, 8e03798)
- x86_64 ビルド修復 (cocoa BOOL ABI ヘルパ) + release.sh 修正 5 連発 (notarytool profile 等)

### ✓ Round 28 で完了した項目 (履歴)
- 軽い積み残し: AI OCR 文言を Gemini ベースに統一 ("Claude OCR" → "AI OCR" 一括置換)
- ㊦ 定期取引候補をワンクリックで auto_rules に登録 (recurring.ts createAutoRuleFromCandidate + dashboard ボタン)
- ㊧ 仕訳エクスポートに freee 振替形式 / マネーフォワード仕訳帳形式 (journal-export.ts)
- ⓐ /journals?from=&to= で前年同期比較 (summarizeByDateRange + shiftYear)
- ⓑ partner 統合の Undo (partner-cleanup.ts mergePartnerVariant/undoPartnerMerge + snapshot stack)
- ⓒ 受信箱「失敗」タブで failure bucket 別件数 + クリックフィルタ (classifyOcrError ベース)
- ⓓ readiness カードを設定画面から通年表示 (ReadinessCard in settings)
- ⓔ verify-app.sh demo-scenario に bulk delete + Undo (新 demo action demo-bulk-delete-undo)
- ⓕ updater 失敗フォールバックを GitHub Releases /latest に固定
- ⓖ inbox bulk 再 OCR に進捗バー (done/total/ok/fail + 上部固定 progress)
- ㊗ v0.3.0 公証付きリリース: 持ち越し (要・対話的 credential セットアップ)

### ✓ Round 27 で完了した項目 (履歴)
- ㊤ 定期取引候補の自動検出 (lib/recurring.ts + dashboard widget)
- ㊥ OCR 信頼度推定 (ocrConfidence — vendor/amount/date/items 充足率)
- ⓐ partner 表記ゆれ検出 + 統合 (detectPartnerVariants + mergeVariantPair)
- ⓑ 破棄タブでフィルタ中の N 件を candidate に一括復元
- ⓒ 月次グラフ年度比較 (前年同月の薄い棒を重ねる)
- ⓓ 受信箱 bulk Vision OCR 再実行 (selected を loop で reocrInboxRow)
- ⓔ verify-app.sh autorun に release.sh DRY_RUN プレビュー追記
- ⓕ 古い receipt_failed (30 日経過) を自動 stale_failure dismissed
- ⓖ ScoreSignalsBadge ESC キーで sticky popover を閉じる

### ✓ Round 26 で完了した項目 (履歴)
- ㊢ 過去サジェストを partner 連動に (selector + filter)
- ㊣ partner-cleanup: 1 ヶ月に 1 回 toast 通知 (新規 lib/partner-cleanup.ts)
- ⓐ readiness check に receipt_failed (state) を追加
- ⓑ 破棄 reason 別 click filter (Badge クリックで toggle)
- ⓒ 月次グラフ tooltip に年間平均/中央値 + 平均比デルタ
- ⓓ 仕訳 bulk delete + Undo (BULK_DELETE_UNDO_KEY スタック)
- ⓔ verify-release.sh で LP に v<TAG> が含まれるかチェック
- ⓕ inbox dismissed タブに「最終物理削除」日時表示
- ⓖ updater 再試行 (transient エラーは 10 秒後 1 回 retry)

### ✓ Round 25 で完了した項目 (履歴)
- ㊠ 確定申告期 (1/1〜3/15) 準備状況カード (etax/readiness.ts + dashboard 統合)
- ㊡ 過去 90 日の仕訳から複製サジェスト (journals/new に History Card)
- ⓐ partner 一覧の使用回数 Badge (0 = 未使用、>0 = 使用 N)
- ⓑ 破棄タブで reason 別件数バッジ (期限切れ/重複/過去類似/手動)
- ⓒ 月次グラフドリルダウンを from/to レンジに (URL クエリ対応)
- ⓓ 仕訳 bulk toolbar に借方/貸方合計表示
- ⓔ verify-release.sh で docs サイト導線確認 (DMG リンク含有チェック)
- ⓕ 90 日超 dismissed の物理削除 (purgeOldDismissed in boot.tsx)
- ⓖ ScoreSignalsBadge を click でもトグル (touch/keyboard 対応)

### ✓ Round 24 で完了した項目 (履歴)
- ㊞ 取引先名 → 勘定科目の自動補完 (suggestAccountForVendor)
- ㊟ ダッシュ「要確認の仕訳」ウィジェット (amber Card → /journals?incomplete=1)
- ⓐ 重複検出に file_hash (SHA-256) を追加 (file_hash → ocr_text → なし の順)
- ⓑ 領収書一覧 bulk delete + CSV export
- ⓒ updater「今すぐ確認」ボタン (UpdaterCheckCard in 設定)
- ⓓ smoke-report に _sqlx_migrations 状態を追加
- ⓔ 月次グラフ年度切替セレクタ (chartYear state + availableYears)
- ⓕ tax_classes / accounts マスタ画面 + マスタ index ページ
- ⓖ 受信箱「破棄」タブで expired_30d フィルタ

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

