# WebClass Discord Notifier

南山大学WebClass専用のDiscord通知チェッカーです。

3時間ごとに自動実行し、ID/パスワードでWebClassへログインして、次の条件だけDiscordへ通知します。

- 新しい課題を検出した
- 提出期限まで24時間以内になった

Discord上の通常メッセージには反応しません。

スラッシュコマンド用にBotを常時起動すると、次のコマンドも使えます。

- `/webclass-all`: 現在検出できる課題を表示
- `/webclass-unsubmitted`: 未提出または未受験と判定できる課題だけ表示

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

初回実行時は現在見つかった課題候補を `data/state.json` に記録します。以降の実行で、新規課題と24時間以内の締切を通知します。

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

ログは `logs/bot.log` に出力されます。

## 3時間ごとの自動実行

Windowsタスクスケジューラに登録します。

```powershell
npm run schedule:windows
```

登録後は、Windowsの「タスク スケジューラ」で `WebClass Discord Notifier` を確認できます。ログは `logs/scheduled-task.log` に出力されます。
