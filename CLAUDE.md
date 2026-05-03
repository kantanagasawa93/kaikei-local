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

## 次ラウンド (Round 15) 候補 — ユーザは「全部やって」希望

新チャット起動時、起動ルーチン後にこの候補を 1 ラウンドにパックして実装する。
推し優先順は ㉹ → ㉺ → ㉻ → ㉼ → ㉽。

### ㉹ v0.3.0 リリース ★★★★★
- Round 14 までで release-rollback の CI 対応 + DRY_RUN まで完備。
- 手元: `scripts/release-setup-credentials.sh` → `scripts/release.sh v0.3.0`

### ㉺ 受信箱「再 OCR」モーダルでオプション選択 ★★★
- 目的: Round 14 ㉵ は Shift+クリックで two-pass を発火するが分かりにくい。
  ボタン押下で {ja-only / en-only / two-pass} 選択モーダル
- 対象: inbox/page.tsx の InboxCard
- commit サイズ: 中 (~100 行)

### ㉻ アンインストール GUI 「データ全消去」 ★★★
- 目的: Round 14 ㉷ の `--wipe-data` を設定画面から発火できる UI ボタンに。
  二重確認 (text input で "DELETE" 入力) → Tauri command 経由で削除
- 対象: src/app/(app)/settings/page.tsx + lib.rs に Tauri command 露出
- commit サイズ: 中 (~150 行)

### ㉼ verify-app.sh の自己診断 doctor サブコマンド ★★★
- 目的: 「verify-app.sh 自体が動かない」時の最初の確認 (KAIKEI_BIN /
  fswatch / ffmpeg / Python3 / app data dir / app_settings の存在等)
- 対象: scripts/verify-app.sh に cmd_doctor を追加
- commit サイズ: 小〜中 (~120 行)

### ㉽ migration history を Tauri command で公開 ★★
- 目的: 「DB migration が v6 まで適用されてるか」を UI / verify-app.sh から
  確認できるよう、_sqlx_migrations を JSON で返す Tauri command
- 対象: lib.rs に migrations_status command + verify-app.sh 経由でも引ける
- commit サイズ: 小 (~80 行)

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

