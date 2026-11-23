# Chrome Web Store 審査フォーム記入案（読み取り専用版）

開発者ダッシュボードの各欄にそのまま転記できる形の案です。挙動と食い違う記入はしないこと（審査は提出コードと照合されます）。

## 単一目的（Single Purpose）の説明

> 本拡張の目的は1つだけです：コミュニティポータル「ivRooom ポータル」の利用者が、ポータルに連携した自分のゲームステータス（原神の樹脂、崩壊：スターレイルの開拓力の回復状況）を、ブラウザのポップアップで確認できるようにすること。ゲームへの操作や、ポータル以外のサービスへの通信は行いません。

## 権限の正当化（Permission justifications）

| 権限 | 記入案 |
|---|---|
| `storage` | 利用者が貼り付けたポータル連携トークン（読み取り専用）を端末内に保存し、次回表示時に再入力を不要にするため。保存するのはこのトークンのみです。 |
| ホスト権限 `https://api.ivrm.jp/*` | 利用者自身のポータル API から、連携済みゲームステータス（樹脂・開拓力など）を取得して表示するため。通信先はこのドメインのみです。 |

要求しない権限（＝記入不要であること自体が要点）:

- `cookies` は要求しません。ゲームサービスのログイン情報には一切アクセスしません。
- `alarms` は要求しません。定期実行は行いません（表示はポップアップを開いた時点の取得のみ）。
- ゲームサービス（HoYoverse / HoYoLAB）のドメインへのホスト権限は要求しません。

## リモートコード

> リモートコードは使用しません。拡張の全機能は提出パッケージ内のコードで完結します。ポータル API から取得するのは表示用データ（JSON）のみで、コードを取得・実行することはありません。

## データ使用の開示（Privacy practices タブ）

収集するデータの種類として申告するのは次の1区分のみです。

| 区分 | 該当 | 内容 |
|---|---|---|
| Authentication information（認証情報） | ✅ | ポータル連携トークン（読み取り専用）。利用者本人がポータルで発行し、貼り付けたもの。端末内に保存し、本人のポータル API 認証にのみ使用 |
| Personally identifiable information | ❌ | 氏名・メールアドレス等は扱わない |
| Health / Financial / Location / Web history / User activity / Website content | ❌ | いずれも扱わない |

Limited Use への準拠（3項目とも認証する）:

- 取得したデータを第三者へ販売・譲渡しません。
- 単一目的の提供・改善以外の目的に使用・譲渡しません。
- 信用力・貸付適格性の判断に使用しません。

補足説明欄の記入案:

> The only user data this extension handles is a read-only "link token" for the user's own ivRooom portal account, which the user generates on the portal and pastes into the extension. The token is stored locally in the browser and sent only to the portal's own API (api.ivrm.jp) to fetch and display the user's game status (in-game stamina values the portal already retrieved). The extension does not access any game-service credentials or cookies, does not collect analytics, and does not share data with third parties.

## 審査員向けテスト手順（差し戻し防止のため提出時に用意）

ポータル連携の先にある機能は、審査員が再現できる手順がないと「機能が確認できない」で差し戻される典型パターンです。提出時は次を用意します（チェックリスト参照）。

- 審査用テストアカウント（ポータル）一式：ログイン情報＋連携トークンの発行手順
- 手順書：ポータルでトークンを発行 → 拡張に貼り付け → ステータスが表示される、までの画面付き説明
