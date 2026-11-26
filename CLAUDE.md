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
#    ※ ビルド後に **起動中の KAIKEI LOCAL を終了して /Applications を新ビルドに差し替える**
#      (build-all.sh → install-and-open.sh)。ユーザが作業中かもしれない時は先に一言伝えるか、
#      SKIP_LOCAL_INSTALL=1 を付けて差し替えを止める
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

## 実データに触れない検証 (Round 33 で導入)

ユーザの本物のアプリ (/Applications の KAIKEI LOCAL) は使用中のことが多い。**killall / quit は使わない**。
新しいビルドは HOME を差し替えた別インスタンスで動かす:

```bash
APP="$PWD/src-tauri/target/debug/bundle/macos/KAIKEI LOCAL.app"
FAKE=<スクラッチ>/home   # DB・領収書・ログ・WebKit ストレージが全部この下に出来る
open -g -n "$APP" --env HOME="$FAKE" --env CFFIXED_USER_HOME="$FAKE"   # -g: 前面に出さない
PID=$(pgrep -f "target/debug/bundle/macos/KAIKEI LOCAL.app/Contents/MacOS/kaikei")
HOME="$FAKE" CFFIXED_USER_HOME="$FAKE" "$APP/Contents/MacOS/kaikei" --navigate=/journals
screencapture -x -o -l <CGWindowID> out.png   # 裏にある窓でも撮れる
kill "$PID"                                    # テスト用だけを PID 指定で止める
```

- 空の `$FAKE` = 新規インストールの再現。実データで試す時は
  `sqlite3 "$REAL/kaikei.db" "VACUUM INTO '$FAKE/.../kaikei.db'"` + `cp -cR receipts inbox` でコピーを作り、
  コピー側の app_settings から `license_key` と `ai_ocr_consent` を消してから起動する (外部送信を起こさない)
- 裏にある窓は WebKit が CSS トランジションと描画を間引く。サイドバーの選択表示が古いまま・
  一覧が空に見えるのは撮るのが早いだけのことが多い → 8 秒以上待って撮り直す
- `npm run test` は本番と同じマイグレーションを当てたインメモリ SQLite で動く (`installTestDb()`)

## 次ラウンド (Round 34) 候補

Round 33 の全体レビューで見つけて、まだ直していないもの。推し優先順は ㊀ → ㊁ → ㊂ → ㊃ → ㊄。

### ㊀ 未分類 (999) 明細の付け替えツール ★★★★★
- 他社ソフトの CSV を取り込んだ帳簿には 999 (未分類) の明細が大量に残る (交際費・外注費・カード/銀行口座名など、
  科目表に無い名前で来たもの)。Round 33 で「集計から黙って消える」は止めた (未分類として警告) が、
  正しい科目に直す手段が手作業しか無い
- 元の科目名 (journal_lines.account_name) ごとに件数・金額を出し、まとめて科目を付け替える画面を作る
- 対象: src/app/(app)/tax-return/page.tsx の警告からリンク + src/lib/accounts.ts resolveAccountByName

### ㊁ 消費税ページの計算検証 ★★★★ (課税事業者なので実害あり)
- consumption-tax/page.tsx の集計を税区分ベースで検算 (簡易課税 / 2 割特例 / 本則)。vitest 付きで
- ダッシュボード・journal-export にも「コード先頭の数字で売上/経費を判定」が残っている → classifyAccountCode に統一

### ㊂ e-Tax XTX の XSD 適合 ★★★★
- KOA020 / KOA210 / RSH / IT 部が xmllint で XSD 不適合 (envelope.ts のコメントは「e-Tax で表示できた」としている)。
  様式ごとに XSD を通す vitest を追加し、不適合を潰す
- 年度をまたいだ時に前年の入力が残る (etax ページの state)、予定納税の欄が無い

### ㊃ 給与所得のある年の申告 ★★★
- 給与所得控除 (令和8〜9年分は 220 万円以下 → 74 万円) が未実装で、いまは警告だけ
- 源泉徴収票 (withholding_slips) の給与を所得に入れる

### ㊄ 銀行 CSV まわり ★★★
- bank-csv.ts: 符号・日付の解釈が銀行によってずれる (parseCardRows は未使用のまま)
- 定期取引 → ルール化が入金に対応していない / auto_rules の stale ルール掃除 (旧 ㊊)

### 候補プール
- 証憑 ZIP 取込の再照合 / キーワードによる科目の誤判定 / Vision フォールバック時の金額
- Vision ハンドラの解放漏れ / launchd の plist パス・引数 / ヘッドレススキャンの停止 / 遅れて届く写真 (スキャン窓の重なり)
- checksum 修復の経路 / updater のオフライン時バナー / 請求書 PDF の改ページ・発注書からの作成
- 取引先「未使用」判定が請求書を見ていない / ocr.ts の Tesseract を CDN から読んでいる
- 科目セレクトに DB の科目 (マスタ取込分) が出ない / 請求書の whAuto が保存されない / 原本 PDF を開くボタン
- journals/page.tsx の分割 (旧 ㊱) / freee・MF エクスポートの税区分マッピング表 (旧 ㊋)
- eslint 既存 8 エラーの解消 (hoisted 関数の使用前参照 6 / setState-in-effect 2)
- api-server (Vercel) の修正は **未デプロイ** (`cd api-server && vercel --prod`): OCR の利用回数を失敗時に返す / Stripe webhook の署名必須化

### ✓ Round 33 で完了した項目 (履歴) — テーマ「全体レビュー: 失わない / 二重にしない / 引っ越せる」
- バックアップ・復元を Rust (backup.rs) に移設: VACUUM INTO スナップショット / 復元は次回起動時に適用 /
  別 Mac 向けの絶対パス書き換え / 新しいスキーマの拒否 / 自動バックアップも同方式で 7 世代
- 申告: 基礎控除の表を更新 (2025 / 2026–27 / 2028+)・青色控除後の合計所得で判定・青色控除は利益が上限 /
  科目の区分を科目表から判定 (classifyAccountCode)・未分類を警告 / e-Tax 経費・BS マッピング作り直し
- 仕訳: journal-save.ts (新規・編集を安全な順序で) / bulkDeleteJournals + Undo / 受信箱の二重仕訳化防止・
  失敗時ロールバック / CSV 取込の重複判定・別名解決・伝票番号 + 日付で束ねる
- 写真: migration v14 (photo_inbox.state_changed_at + トリガ) / OCR 失敗写真を残す / 重複統合は全文一致 /
  領収書が参照する画像は purge しない
- 家事按分 (allocations.ts) / 明細取込 (bank-journal.ts) / 請求書 (invoice-save.ts) / マスタ取込 /
  自動ルールの収支判定 — いずれもテスト付きでライブラリに切り出し
- 領収書: PDF 複数ページ + CMap 同梱 + 原本保持 / スマホ取込の一覧を実ファイルから作る・トークン必須・遅延起動
- プライバシー: AI OCR の同意チェックを全経路の入口に / サンプルの個人情報を架空データに
- 日付: 「今日」をローカル日付に (18 箇所) / 最小 macOS 11.0
- 配布: updater tarball の AppleDouble 混入を修正 (これまで自動アップデートは必ず失敗していた) /
  release.sh のタグ・バージョン検査 / CI を Node 24 + vitest に
- テスト 49 → 228 件 (実マイグレーションを当てたインメモリ SQLite: src/test-stubs/test-db.ts)、Rust 11 件

### ✓ Round 31–32 で完了した項目 (履歴、v0.3.2)
- 領収書発行 (doc_type) / 勘定科目ピッカー / PDF 領収書の画像化 / 請求書の税込入力と源泉徴収 /
  window.confirm → confirmDialog 全面移行 / 既存 raw PDF 領収書の JPEG 化移行
- v0.3.1・v0.3.2 は release.sh で公証付きリリース済み (旧 ㊗ は完了)

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
- **localDb は例外を投げない**: `await db.from(..).insert(..)` は失敗しても `{ data: null, error }` を返すだけ。`error` を見ないコードは「保存できたつもり」で先へ進む (マスタ取込は 1 件も保存せず「成功」と表示していた)。書き込みは必ず `const { error } = await ...; if (error) throw error;`
- **localDb にトランザクションは無い**: 「全部消してから入れ直す」は途中で失敗すると空になる。**新しい行を入れる → 参照を付け替える → 古い行を消す** の順にし、失敗時は新しい方を消して戻す (journal-save.ts / invoice-save.ts / allocations.ts が手本)
- **SQLite の真偽値は 0/1 で返る**: `rule.is_income !== tx.is_income` のように boolean と === で比べると常に不一致。比べる前に両辺を `Boolean()` に通す
- **localDb の insert は id を自動付与する**: id 列の無い表 (accounts / tax_classes は code が主キー) は `TABLES_WITHOUT_ID` に入れないと INSERT が必ず失敗する
- **使用中の kaikei.db をコピー・上書きしない**: WAL モードなので、ファイルコピーには直近のコミットが入らず、開いたままの DB を上書きすると次のチェックポイントで壊れる/巻き戻る。取り出しは `VACUUM INTO`、差し替えは次回起動時 (SQL プラグインが開く前) に行う
- **科目の区分をコードの先頭の数字で判定しない**: 取込で付く 999 (未分類) や A9xx (マスタ取込の採番) が売上にも経費にも入らず集計から消える。必ず `classifyAccountCode()` (科目表から引く) を使い、null は「未分類」として利用者に見せる
- **集計に自分が生成した仕訳を含めない**: 家事按分の「年間合計」に前回の按分仕訳が入っていて、再計算のたびに金額が変わっていた。生成物は id で除外してから集計する
- **「今日」に `new Date().toISOString().slice(0, 10)` を使わない**: UTC なので日本時間の 0〜9 時は前日になる。`todayLocal()` (date-utils.ts) を使う
- **金額の掛け算を浮動小数のままやらない**: `2.3 * 1500` は 3449.99… で切り捨てると 1 円欠ける。数量を整数に直してから掛ける (`lineAmount()`)
- **消費税の端数処理は「請求書ごと・税率ごとに 1 回」**: 行ごとに切り捨てて足すのは適格請求書の要件を満たさない
- **macOS の tar は AppleDouble (`._*`) を別エントリで書く**: tauri-plugin-updater は先頭のパス要素を落として展開するので、`._KAIKEI LOCAL.app` が混ざると展開先が壊れてアップデートが必ず失敗する。`COPYFILE_DISABLE=1 tar --no-mac-metadata` で作り、中身を検査する (release.sh)
- **伝票番号だけで仕訳を束ねない**: 番号が月ごと・年ごとに振り直される CSV では「同じ番号・別の日付」が後勝ちで上書きされて消える。番号 + 日付で束ねる
