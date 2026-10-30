# HAC 会計記録アプリ

自主法政祭2026(2026-10-31・11-01)の HAC 屋台「バタフライピーソーダ」の会計を記録する Web アプリです。来年の仕入れ数・値付け・シフトを決める材料にするため、会計ごとに杯数・価格・客の属性・整理券の受け渡し時刻を残します。

- 公開 URL: https://hac-register-2026.web.app
- 仕様: [spec_v01.md](spec_v01.md)(最初のメモは [start.md](start.md))

## できること

- 会計の記録(杯数・年代・性別・子連れ)とお釣りの計算
- 整理券 1〜20 の自動割り当てと受け渡し管理。番号は手動でも変えられる
- 会計の修正・取り消し、価格の変更
- 集計(今日と累計の杯数・売上・利益、時間帯別、年代別、平均待ち時間)
- CSV の書き出し(Excel・スプレッドシートで文字化けしない UTF-8 BOM 付き)
- 電波がなくても記録でき、つながったらクラウドに送る

## 構成

- 画面: `public/` の HTML・CSS・JavaScript のみ(ビルド不要)
- データ: Cloud Firestore(プロジェクト `hac-register-2026`)
- ログイン: Firebase Authentication の Google ログイン
- 公開: Firebase Hosting

ログインできるアカウントは [public/firebase-config.js](public/firebase-config.js) の `allowedEmails` と [firestore.rules](firestore.rules) の2か所で決めています。増やすときは両方を同じように直してください。

## 手元で動かす

Firebase CLI と Java(エミュレーター用)が必要です。

```sh
firebase emulators:start --only auth,firestore,hosting
```

http://127.0.0.1:5055 を開くと、本番ではなくエミュレーターにつながります。

## デプロイ

HAC の Google アカウントで `firebase login` してから実行します。

```sh
firebase deploy --only hosting,firestore:rules
```

`public/` を変えたら [public/sw.js](public/sw.js) の `CACHE` の番号も1つ上げてください。上げないと、iPhone に保存された古いファイルが残ることがあります。
