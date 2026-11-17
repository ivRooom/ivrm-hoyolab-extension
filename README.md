# ivRooom HoYoLAB Link

ログイン中の HoYoLAB セッションを [ivRooom ポータル](https://member.ivrm.jp) へワンクリックで連携するブラウザ拡張です。連携すると、原神の樹脂やスターレイルの開拓力といったリアルタイム情報がポータルのゲームタブに表示されます。

HoYoLAB には公式の OAuth / API キーがないため、ポータルへの登録は通常「開発者ツールで Cookie を取り出して貼る」手順が必要です。この拡張はその手順をなくすためのものです。

## 使い方

1. ブラウザで [HoYoLAB](https://www.hoyolab.com) にログインしておく
2. ポータルのプロフィール（HoYoLAB連携）で「ペアリングコードを表示」を押す
3. この拡張のポップアップにコードを貼って「連携する」を押す

ペアリングコードはポータルが発行する10分だけ有効な署名つきトークンで、連携できるのは発行した本人のアカウントだけです。

## セキュリティ

- 読む Cookie は `ltuid_v2` / `ltoken_v2` / `ltmid_v2` の3つだけです（HoYoLAB のセッションに必要な値）
- 送信先は `https://api.ivrm.jp/hoyolab-pairing/exchange` のみです
- 拡張は情報を一切保存しません（ストレージ権限も持っていません）
- ポータル側では Cookie は暗号化して保存され、連携解除で即時削除されます
- 権限は `cookies` と、hoyolab.com / api.ivrm.jp へのホスト許可だけです

## 対応ブラウザ

Chrome / Edge（Manifest V3）。Firefox は後続対応予定です。

## 開発

依存パッケージはありません。テストは Node 標準の test runner で動きます。

```sh
npm test
```

### 手元で読み込む（開発版）

1. Chrome で `chrome://extensions` を開き、デベロッパーモードを ON
2. 「パッケージ化されていない拡張機能を読み込む」でこの repo のルートを選ぶ

### 構成

- `manifest.json` — MV3 マニフェスト
- `src/popup.html` / `src/popup.css` / `src/popup.js` — ポップアップ UI
- `src/lib/hoyolab-cookie.mjs` — Cookie の選択・整形と応答解釈（純粋関数、テスト対象）
- `test/` — `node --test` のユニットテスト

## 関連

- 連携の仕組み（方式A）: ivRooom/ivrm-web #1245
- ペアリング受け口の設計: ivRooom/ivrm-web #1279
