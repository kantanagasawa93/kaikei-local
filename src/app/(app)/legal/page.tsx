"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function LegalPage() {
  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold">法的情報</h1>

      <Tabs defaultValue="privacy">
        <TabsList>
          <TabsTrigger value="privacy">プライバシーポリシー</TabsTrigger>
          <TabsTrigger value="terms">利用規約</TabsTrigger>
        </TabsList>

        <TabsContent value="privacy">
          <Card>
            <CardHeader>
              <CardTitle>プライバシーポリシー</CardTitle>
            </CardHeader>
            <CardContent className="prose prose-sm max-w-none space-y-4 text-sm leading-relaxed">
              <p className="text-muted-foreground">最終更新日: 2026年4月16日</p>

              <section>
                <h3 className="font-semibold text-base mt-4">1. はじめに</h3>
                <p>
                  KAIKEI LOCAL（以下「本アプリ」）は、個人事業主の会計業務を支援するデスクトップアプリケーションです。
                  本プライバシーポリシーは、本アプリにおけるお客様のデータの取り扱いについて説明します。
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">2. データの保存場所</h3>
                <p>
                  本アプリで入力された全てのデータ（仕訳、領収書画像、取引先情報、請求書、確定申告データ等）は、
                  お客様のMacのローカルストレージにのみ保存されます。
                </p>
                <p className="font-medium">
                  具体的な保存先: ~/Library/Application Support/dev.kaikei.app/
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">3. 外部送信について</h3>
                <p>本アプリは、オプトイン機能を使った場合に限り以下の外部通信を行います。これら以外の外部送信は一切行いません。</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>
                    <strong>AI 読み取り (明示同意時のみ):</strong> 領収書の AI 読み取り機能を利用する場合、
                    領収書画像 (base64) を <code>api.kaikei-local.com</code> 経由で Google Gemini 2.5 Flash に送信します。
                    初回利用時に明示同意を取得し、同意しない場合は従来の Tesseract OCR (オフライン処理) にフォールバックします。
                    画像はサーバー側で解析後に即時破棄され、AI モデルの学習には使用されません。
                  </li>
                  <li>
                    <strong>ライセンス検証 (購入者のみ):</strong> 有料プラン利用時のライセンスキー検証と月次利用枠チェックのため、
                    <code>api.kaikei-local.com</code> にライセンスキーを送信します。氏名・住所・納税データは送信しません。
                  </li>
                  <li>
                    <strong>郵便番号→住所検索 (任意):</strong> 設定画面で住所検索ボタンを押した時のみ、
                    郵便番号 7桁を <code>zipcloud.ibsnet.co.jp</code> に送信します。
                  </li>
                  <li>
                    <strong>LAN内通信:</strong> スマホからの領収書取込機能は、同一Wi-Fiネットワーク内のみで動作します。
                    インターネットへのデータ送信は行いません。
                  </li>
                </ul>
                <p className="text-xs text-muted-foreground mt-1">
                  納税者情報 (氏名・住所・利用者識別番号・マイナンバー等) はローカル DB にのみ保存され、
                  いかなる場合も外部サーバーに送信されません。
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">4. 収集しない情報</h3>
                <p>本アプリは以下の情報を収集しません:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>個人を識別できる情報（氏名、メールアドレス等）</li>
                  <li>利用状況の分析データ</li>
                  <li>クラッシュレポート</li>
                  <li>位置情報</li>
                  <li>Cookie やトラッキングデータ</li>
                </ul>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">5. データの管理</h3>
                <p>
                  お客様は「設定・ヘルプ」画面からいつでもデータのバックアップ・復元・削除を行えます。
                  アプリをアンインストールしてもデータフォルダは残りますので、
                  完全削除する場合はデータフォルダを手動で削除してください。
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">6. お問い合わせ</h3>
                <p>
                  本ポリシーに関するお問い合わせは、開発者までメールでご連絡ください:{" "}
                  <a
                    href="mailto:k.nagasawa.pc@gmail.com"
                    className="underline"
                  >
                    k.nagasawa.pc@gmail.com
                  </a>
                </p>
              </section>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="terms">
          <Card>
            <CardHeader>
              <CardTitle>利用規約</CardTitle>
            </CardHeader>
            <CardContent className="prose prose-sm max-w-none space-y-4 text-sm leading-relaxed">
              <p className="text-muted-foreground">最終更新日: 2026年4月16日</p>

              <section>
                <h3 className="font-semibold text-base mt-4">1. 本アプリについて</h3>
                <p>
                  KAIKEI LOCAL（以下「本アプリ」）は、個人事業主の日常的な会計業務および確定申告の準備を支援する
                  デスクトップアプリケーションです。
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">2. 免責事項（重要）</h3>
                <p className="font-medium text-destructive">
                  本アプリが算出する税額、所得額、消費税額等の数値は参考値であり、
                  正確性を保証するものではありません。
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>確定申告書の提出にあたっては、必ずご自身で内容を確認してください。</li>
                  <li>税務に関する判断は、税理士等の専門家にご相談ください。</li>
                  <li>本アプリの利用により生じた損害について、開発者は一切の責任を負いません。</li>
                  <li>税法の改正により、計算ロジックが最新の法令に対応していない場合があります。</li>
                </ul>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">3. 利用条件</h3>
                <ul className="list-disc pl-5 space-y-1">
                  <li>本アプリは個人利用を目的としています。</li>
                  <li>1ライセンスにつき、お客様が所有するMac 1台での利用を想定しています。</li>
                  <li>リバースエンジニアリング、再配布、改変しての販売は禁止します。</li>
                </ul>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">4. データの責任</h3>
                <p>
                  本アプリのデータはお客様のMacにローカル保存されます。
                  データの紛失・破損に備え、定期的なバックアップを強く推奨します。
                  データの紛失について、開発者は責任を負いません。
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">5. アップデート</h3>
                <p>
                  税制改正等に対応するアップデート版は、別途有料で提供する場合があります。
                  アップデートの提供を保証するものではありません。
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">6. 知的財産権</h3>
                <p>
                  本アプリの著作権その他の知的財産権は開発者に帰属します。
                </p>
              </section>

              <section>
                <h3 className="font-semibold text-base mt-4">7. 準拠法</h3>
                <p>
                  本規約は日本法に準拠し、日本国の裁判所を専属的合意管轄とします。
                </p>
              </section>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
