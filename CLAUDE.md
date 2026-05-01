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

## 次ラウンド (Round 3) 候補 — ユーザは「全部やって」希望

新チャット起動時、起動ルーチン後にこの候補を 1 ラウンドにパックして実装する。
推し優先順は ⓐ → ⓓ → ⓑ → ⓔ → ⓒ。

### ⓐ Migration recovery (致命バグ修正) ★★★★★
- 目的: sqlx の checksum mismatch (`migration 1 was previously applied but
  has been modified`) で v4+ が end user 環境で適用されない問題を修正
- 対象: `src/lib/localDb.ts` (Database.load を catch + 自動復旧)
- やること:
  - Database.load 失敗時に "previously applied" エラーを検出
  - DB ファイルを `kaikei.db.bak-<ts>` にバックアップ
  - `DELETE FROM _sqlx_migrations` → 再 load (idempotent な SCHEMA_SQL に依存)
  - 復旧成功時は info toast、失敗時はバックアップ手順を案内
- 注: Round 2 では開発機の `_sqlx_migrations` を手動クリアして v4 適用を確認済み。
  本番ユーザにはまだ未到達 → 最優先で修正する
- commit サイズ: 中 (~150 行)

### ⓑ v0.3.0 リリース実行 (Round 2 成果物の配布) ★★★★
- 目的: Round 2 で整備した Universal Binary 動線を実 Release に反映
- 対象: `scripts/release.sh v0.3.0` を発火 (要 APPLE_* env)、changelog 追記
- やること:
  - APPLE_SIGNING_IDENTITY 等を確認 → `scripts/release.sh v0.3.0`
  - arm64 + x64 両 DMG が GitHub Release に揃うこと、
    `https://github.com/.../releases/latest/download/KAIKEI_LOCAL_x64.dmg` が 200 を返すこと
- commit サイズ: 小 (~50 行)

### ⓒ verify-app.sh の CI 化 ★★
- 目的: Round 開始時の状態確認を自動化 (cargo check + tsc + next build + .app smoke)
- 対象: `.github/workflows/verify-round.yml` (新規)
- macOS runner で: `npm ci` → `cargo check` → `npx tauri build --bundles app --debug`
  → 起動 → `--db-dump=photo_inbox` で sanity check
- 課題: macOS runner は遅い (1 ジョブ 8〜10 分)。on demand (workflow_dispatch) スタートが現実的
- commit サイズ: 中 (~100 行)

### ⓓ 受信箱「クイック確定」モード ★★★★
- 目的: candidate のカードで「確定」を押したらその場で auto-journal が背後で
  走って journals まで作成する 1-click フロー
- 対象: `src/app/(app)/inbox/page.tsx` + `src/lib/auto-journal.ts`
- やること:
  - 1 件単位の `quickConfirmOne(inboxId)` を auto-journal に追加
  - candidate / receipt 両状態で「⚡ いますぐ仕訳化」ボタン (進行スピナー)
  - 結果トーストに「仕訳 #journal_id を作成」リンク
- commit サイズ: 中 (~120 行)

### ⓔ Vision OCR 結果の rich preview ★★
- 受信箱カードで OCR テキストを行単位ハイライト (金額・日付・店名候補を色分け)
- 領収書として登録する前から「これくらい読めてる」が分かる
- 対象: `src/app/(app)/inbox/page.tsx` + `src/lib/receipt-classifier.ts` (行スコア API 公開)
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
- **sqlx の checksum mismatch (Round 1〜2 で発覚)**: `_sqlx_migrations` に記録された hash と現在の SCHEMA_SQL の hash が違うと sqlx は「migration N was previously applied but has been modified」を投げて、それ以降のマイグレーションが一切走らない。Round 2 で v4 が適用されない事故が発生 → 開発機は手動で `DELETE FROM _sqlx_migrations` で復旧。本番では Round 3 ⓐ で自動復旧を実装予定。SCHEMA_SQL を「絶対に既存版数の中身を変えない」運用が原則 (新規版数を追加するのみ)
- **SQLite で CHECK 制約を変えるにはテーブル再作成必要**: ALTER TABLE ... DROP CHECK は無いので、新テーブル作成 → INSERT SELECT → DROP → RENAME。Round 2 v4 で `state` enum 拡張時に採用

