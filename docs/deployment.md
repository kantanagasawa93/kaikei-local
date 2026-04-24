# 配布・運用オペレーション

KAIKEI LOCAL を友達に配布する際に必要なサーバー側の準備。
アプリ本体 (Mac デスクトップ) は完全ローカルで動くが、
AI 読み取り機能と有料プラン課金のみサーバー側の整備が必要。

## 現状

- **デスクトップアプリ**: 完成、[Releases](https://github.com/kantanagasawa93/kaikei-local/releases) から DMG 配布中
- **`api.kaikei-local.com`**: **DNS 未登録 / 未デプロイ** (2026-04-24 時点)
- **Stripe Checkout URL**: 未設定 (LP の `#` リンクのまま)

AI 読み取り機能と有料プランは、以下の手順でサーバー側を整えない限り動作しない。

## サーバー側デプロイ

### 1. Vercel に `api-server/` をデプロイ

```bash
cd api-server
# Vercel CLI でログイン済みの状態で
vercel --prod
```

Vercel 側で環境変数を設定:

| 変数名 | 内容 | 取得元 |
|---|---|---|
| `ANTHROPIC_API_KEY` | (Google Gemini を Anthropic 経由で使う設計の場合は Claude API key) | https://console.anthropic.com |
| `GEMINI_API_KEY` | Google Gemini 2.5 Flash の API key | https://aistudio.google.com/apikey |
| `STRIPE_SECRET_KEY` | Stripe シークレットキー | https://dashboard.stripe.com |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | Stripe ダッシュボードで webhook 登録後 |
| `UPSTASH_REDIS_REST_URL` | Redis REST エンドポイント | https://upstash.com |
| `UPSTASH_REDIS_REST_TOKEN` | Redis トークン | 同上 |
| `RESEND_API_KEY` | ライセンスキー配信メール送信用 | https://resend.com |
| `ADMIN_SECRET` | 手動ライセンス発行 API の保護 | 任意の長い文字列 |

### 2. カスタムドメインを `api.kaikei-local.com` に設定

Vercel プロジェクト → Settings → Domains で追加。
レジストラー側で DNS CNAME レコードを `cname.vercel-dns.com` に設定。

### 3. Stripe webhook 登録

Stripe ダッシュボード → Developers → Webhooks → エンドポイント追加:

- URL: `https://api.kaikei-local.com/api/stripe/webhook`
- イベント: `checkout.session.completed`, `customer.subscription.deleted`

登録後に表示される signing secret を Vercel の `STRIPE_WEBHOOK_SECRET` に設定。

### 4. Stripe Checkout URL の作成

Stripe → Products で商品を 2 つ作成:

- **月額プラン**: ¥980 / month, recurring
- **年額プラン**: ¥9,800 / year, recurring

各 Price の `Payment Link` を作成して URL を取得。

## LP の Stripe リンク差し替え

`site/index.html` と `docs/index.html` 両方を編集:

```html
<!-- 月額プラン加入ボタン -->
<a href="https://buy.stripe.com/<生成された月額プラン URL>" class="hero-cta" ...>
  月額プランに加入
</a>

<!-- 年額プラン加入ボタン -->
<a href="https://buy.stripe.com/<生成された年額プラン URL>" class="hero-cta" ...>
  年額プランに加入
</a>
```

コミット → push → GitHub Pages 反映 (数分)。

## 新バージョンのリリース

```bash
# 1. tauri.conf.json の version を上げる (例: 0.2.0)
# 2. package.json の version も同じに
# 3. main に commit/push

# 4. Release スクリプトで DMG ビルド & Release 作成
scripts/release.sh v0.2.0
# or 未署名版
UNSIGNED=1 scripts/release.sh v0.2.0-beta.1
```

LP の DL URL は `/releases/latest/download/KAIKEI_LOCAL.dmg` 固定なので、
Release が最新化されれば自動で新 DMG が降ってくる。

## デプロイ前に出回ると困るもの

- **AI OCR を売ると詐欺になる**: サーバー未デプロイなら LP の料金プランは隠すか「開発中」表示にする
- **ライセンスキー検証が失敗する**: 購入したのに認証されない → 返金対応必要

アプリ側は `lib/ai-ocr.ts` の `probeApiServer()` で起動時に生存確認し、
死んでいれば AI 機能をグレーアウトして案内文を出すよう実装済み。
