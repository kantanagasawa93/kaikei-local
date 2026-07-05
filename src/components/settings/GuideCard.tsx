"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HelpCircle } from "lucide-react";

/** 設定画面「使い方ガイド」(静的コンテンツ)。 */
export function GuideCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HelpCircle className="h-4 w-4" />
          使い方ガイド
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <Section title="① まず発行者情報を登録">
          <p>
            「請求書 &gt; 発行者情報」から屋号・住所・インボイス登録番号などを登録してください。
            これが請求書PDFやレポートに表示されます。
          </p>
        </Section>
        <Section title="② 日々の領収書をためる">
          <p>
            ダッシュボードや「領収書」ページの上部にあるドロップゾーンに、
            FinderやmacOS写真アプリから写真をドラッグ＆ドロップで追加できます。
            スマホで撮った写真は「スマホ取込」ページのQRコードから送れます（同じWi-Fi内のみ）。
          </p>
        </Section>
        <Section title="③ 銀行・クレカ明細をCSVで取り込む">
          <p>
            「口座・クレカ」で口座を登録し、「明細取込」で銀行からダウンロードしたCSVを取り込みます。
            取り込んだ明細は「仕訳」ボタンで自動仕訳化できます。
          </p>
        </Section>
        <Section title="④ 自動登録ルールで繰り返しを効率化">
          <p>
            同じお店からの引き落としが何度も出る場合、「自動登録ルール」で
            「この文字列を含む明細は消耗品費の課対仕入10%にする」と登録すると次から自動推測されます。
            推測が採用されるたび正答率が更新されます。
          </p>
        </Section>
        <Section title="⑤ 月次推移で状況を確認">
          <p>
            「月次推移」ページで損益計算書・貸借対照表をそれぞれ月次マトリクスで確認できます。
          </p>
        </Section>
        <Section title="⑥ 家事按分は期末にまとめて">
          <p>
            「家事按分」ページで事業利用比率を設定し、年末に「再計算」ボタンを押すと、
            12/31付で按分仕訳（事業主貸への振替）が自動生成されます。
          </p>
        </Section>
        <Section title="⑦ 固定資産の減価償却">
          <p>
            「固定資産」ページで購入した備品（PC・車など）を登録すると、
            耐用年数・事業利用率から減価償却費が自動計算されます。
            年末に「N年分を仕訳化」ボタンを押すと 12/31 付の減価償却仕訳が作成され、
            確定申告の減価償却明細にも反映されます。
          </p>
        </Section>
        <Section title="⑧ 確定申告">
          <p>
            年末に「確定申告」ページで各種控除を入力すると所得税額が計算されます。
            「PDF出力」で内容を確認し、実際の提出は国税庁e-Taxサイトでマイナンバーカード + スマホで行います。
          </p>
        </Section>
        <Section title="⑨ 請求書発行">
          <p>
            「請求書」から新規請求書を作成。取引先を選び、明細を入力すると
            適格請求書（インボイス）形式のPDFが出力できます。
            「送付済」「入金済」でステータス管理も可能です。
          </p>
        </Section>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-medium mb-1">{title}</p>
      <div className="text-muted-foreground pl-4 border-l-2">{children}</div>
    </div>
  );
}
