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

## 次ラウンド (Round 4) 候補 — ユーザは「全部やって」希望

新チャット起動時、起動ルーチン後にこの候補を 1 ラウンドにパックして実装する。
推し優先順は ㊀ → ㊂ → ㊁ → ㊃ → ㊄。

### ㊀ v0.3.0 実リリース発火 ★★★★★
- 目的: Round 2/3 で揃えた Universal Binary + 自動仕訳精度向上を実配布
- 対象: `scripts/release.sh v0.3.0` (要 APPLE_* env)
- やること:
  - 環境変数 4 種 (APPLE_SIGNING_IDENTITY / APPLE_ID / APPLE_PASSWORD /
    APPLE_TEAM_ID) を確認 → スクリプト発火
  - arm64 + x64 両 DMG が GitHub Release に並ぶこと、`*_x64.dmg` の URL が 200
  - LP の changelog セクションに v0.3.0 ハイライトを表示
- 注: 認証情報なしのチャットからは打てないので、ユーザの手元シェルで叩く
- commit サイズ: 小 (~50 行 — LP 文言反映のみ。リリース自体はスクリプト)

### ㊁ 既知 OCR 失敗パターンの自動学習 ★★★
- 目的: receipt_failed 行の last_error を集計 → 同じパターン再発時に「再試行
  しても無駄」と判定して silent skip
- 対象: `src/lib/auto-journal.ts` + `src/lib/error-reporter.ts`
- やること:
  - last_error を正規化 (License limit / network timeout / vendor parse 等)
  - 連続失敗 3 回以上のパターンを app_settings に保存
  - quickConfirmOne 起動時にチェックして、該当パターンなら「もう一度押す前に
    設定を見直してください」モーダル
- commit サイズ: 中 (~150 行)

### ㊂ 仕訳の差し戻し→受信箱再投入 ★★★★
- 目的: 自動仕訳された結果が不正だった時に、journal を消して inbox 行を
  candidate に戻して再仕訳するフロー
- 対象: `src/app/(app)/journals/page.tsx` (削除アクション拡張) + `src/lib/journal-commit.ts`
- やること:
  - 受信箱由来の仕訳の削除メニューに「ゴミ箱 + 受信箱に戻す」を追加
  - photo_inbox.state を 'candidate' に + imported_receipt_id クリア
  - claude_result_json は保持 (再 OCR 不要なら同じ結果で再仕訳できる)
- commit サイズ: 中 (~120 行)

### ㊃ rich preview の hover ツールチップ ★★
- 目的: 受信箱カードの色分け行を hover すると、その種別の説明と、
  AI OCR で送った場合に取れる情報の例を表示
- 対象: `src/app/(app)/inbox/page.tsx` (RichOcrPreview)
- commit サイズ: 小 (~50 行)

### ㊄ verify-app.sh smoke の Markdown レポート ★★
- 目的: smoke の結果を `verify-report-<ts>.md` に書き出して、ユーザに渡す
  時に「最後に検証したときの結果」を毎回見せる
- 対象: `scripts/verify-app.sh`
- やること:
  - smoke の結果 (件数・最終スキャン日時・最近のエラー) を Markdown 化
  - 起動時に最新レポートをアプリ内で表示するメニュー (Tauri command + UI)
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

