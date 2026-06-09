# WebClass Discord Notifier

南山大学WebClass専用のDiscord通知チェッカーです。

3時間ごとに自動実行し、ID/パスワードでWebClassへログインして、次の条件だけDiscordへ通知します。

- 新しい課題を検出した
- 提出期限が変更された
- 提出期限まで24時間以内になった
- 未提出のまま提出期限当日になった

Discord上の通常メッセージには反応しません。

スラッシュコマンド用にBotを常時起動すると、次のコマンドも使えます。

- `/webclass-all`: 現在検出できる課題を表示
- `/webclass-unsubmitted`: 未提出または未受験と判定できる課題だけ表示
- `/webclass-next`: 提出期限が最も近い未提出課題を表示
- `/webclass-status`: 自動巡回の最終成功時刻や連続失敗数を表示

`/webclass-all` の `include-submitted` オプションを `False` にすると、提出済み課題を除外できます。課題一覧は提出期限が近い順に表示されます。

## セットアップ

```bash
npm install
npx playwright install chromium
```

`.env.example` を参考に `.env` を作成します。`.env` はGitに含めません。

```env
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
WEBCLASS_LOGIN_URL=https://webclass.nanzan-u.ac.jp/webclass/login.php
WEBCLASS_USER_ID=
WEBCLASS_PASSWORD=
```

必要に応じて、WebClassの課題一覧ページURLを指定できます。

```env
WEBCLASS_TARGET_URLS=https://webclass.nanzan-u.ac.jp/webclass/...
```

## Discord接続テスト

```bash
npm run test:discord
```

指定チャンネルにテストメッセージが出ればOKです。

## WebClass取得テスト

```bash
npm run inspect:webclass
```

取得できた課題候補をコンソールに出し、ログイン後ページのHTMLを `debug/webclass.html` に保存します。課題が検出されない場合は、WebClassで課題一覧ページを開き、そのURLを `.env` の `WEBCLASS_TARGET_URLS` に設定してください。

## 通知実行

```bash
npm run check
```

初回実行時は現在見つかった課題候補を `data/state.json` に記録します。以降の実行で差分と締切を通知します。

自動通知の条件は次の4種類です。

- 新しい課題が追加された
- 提出期限が変更された
- 提出期限まで24時間以内になった
- 未提出のまま提出期限当日になった

新規課題を検出した時点で既に24時間以内または締切当日だった場合、その課題について後続の24時間通知・当日通知は送りません。また、締切当日の未提出通知と24時間通知が同時に成立する場合は、当日通知だけを送ります。

WebClass取得に失敗した場合は最大3回まで再試行します。定期巡回が3回連続で失敗するとDiscordへ障害通知を送り、成功時に連続失敗数をリセットします。同じ定期巡回が重複起動した場合は、後から始まった処理をスキップします。

## スラッシュコマンドBot

Botを起動します。

```bash
npm run bot
```

起動時に、`DISCORD_CHANNEL_ID` のチャンネルがあるサーバーへスラッシュコマンドを登録します。明示的にサーバーを指定したい場合は `.env` に `DISCORD_GUILD_ID` を追加してください。

Windowsログオン時にBotを常時起動したい場合は、別のタスクとして登録します。

```powershell
npm run bot:schedule:windows
```

ログは `logs/bot-YYYY-MM-DD.log` に日別で出力されます。

## 3時間ごとの自動実行

Windowsタスクスケジューラに登録します。

```powershell
npm run schedule:windows
```

登録後は、Windowsの「タスク スケジューラ」で `WebClass Discord Notifier` を確認できます。ログは `logs/check-YYYY-MM-DD.log` に日別で出力されます。

ログは標準で30日間保存します。`.env` の `LOG_RETENTION_DAYS` で変更できます。巡回状態は `data/runtime-status.json` に保存されます。
