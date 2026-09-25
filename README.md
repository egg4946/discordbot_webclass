# WebClass Discord Notifier

課題の回答案作成と承認後提出は [TASK_WORKFLOW.md](TASK_WORKFLOW.md) を参照してください。ローカルの操作画面は `npm run task:ui`（または `task-ui.bat`）で開きます。

南山大学WebClass専用のDiscord通知Botです。KAGOYA CLOUD VPS（Ubuntu 22.04）上で常時運用しています。

## 構成

| 実行方法 | 役割 |
| --- | --- |
| PM2 の `webclass-bot`（`npm run bot`） | Discordへ常時接続し、スラッシュコマンドに応答する |
| cron の `npm run check`（3時間ごと） | WebClassへログインして課題を確認し、通知する |

同じVPS上の `mybot` は別のロール管理Botで、WebClass Botとは無関係です。WebClass Botを再起動するときは必ず `pm2 restart webclass-bot` を使います。

## 自動通知

`npm run check` は次の条件でDiscordへ通知します。

- 新しい課題を検出した
- 提出期限が変更された
- 提出期限まで24時間以内になった
- 未提出のまま提出期限当日になった（Bot所有者のDMのみ）

- 新規課題を検出した時点で既に24時間以内または締切当日だった場合、その課題の24時間通知・当日通知は送りません。
- 締切当日の未提出通知（所有者DM）と24時間通知（共有チャンネル）が同時に成立した場合は、両方を送ります。
- 24時間前の通知には提出済み・未提出の状態を表示しません。

課題として扱うのは「課題」「レポート」「テスト」「小テスト」「試験」です。自習資料・教材・資料・リンク・単なる練習問題、WebClassの「New」バッジは除外します。同じ教材を複数回検出しても、WebClassの教材IDで1件にまとめます。

初回実行時は現在の課題を `data/state.json` に記録するだけで、以降の実行から差分を通知します。**`data/state.json` を削除すると、既存課題が新規課題として再通知される可能性があるため、通常は削除しません。**

### 失敗時の動作

- WebClassの取得に失敗した場合は最大3回まで再試行します。
- 一部の授業ページだけ読めなかった場合は、その授業の前回の課題データを保持し、次回に新規課題として再通知しないようにします。開けなかったページのほか、ログイン画面に戻されたページ、授業名を読み取れないページ、エラー・メンテナンス画面も「読めなかった」として扱います。授業一覧を読めなかった場合も同様です。
- 全ページ読めなかった場合やログインに失敗した場合は、状態を上書きせずエラーにします。
- 通知は1件送るごとに状態を保存するため、途中で失敗しても送信済みの通知は再送しません。DiscordのAPI制限（429）の場合は待ってから再送します。
- 巡回が3回連続で失敗するとDiscordへ障害通知を送り、その後に成功すると復旧通知を送ります。
- 巡回が `CHECK_TIMEOUT_MINUTES`（標準60分）を超えても終わらない場合は、失敗として強制終了します。
- 同じ巡回が重複起動した場合は、後から始まった処理をスキップします。

## スラッシュコマンド

- `/webclass-all`: 直近の巡回で検出した課題を表示
- `/webclass-unsubmitted`: 未提出または未受験と判定できる課題だけ表示（所有者専用）
- `/webclass-next`: 提出期限が最も近い未提出課題を表示（所有者専用）
- `/webclass-closest`: 提出状況を問わず、提出期限が最も近い課題を表示
- `/webclass-status`: 自動巡回の最終成功時刻や連続失敗数を表示
- `/webclass-mute`: 指定した授業の自動通知をミュート（所有者専用）
- `/webclass-unmute`: 授業のミュートを解除（所有者専用）
- `/webclass-mutes`: ミュート中の授業を表示（所有者専用）

`/webclass-all` の `include-submitted` オプションを `False` にすると、提出済み課題を除外できます。このオプションは所有者専用です。課題一覧は提出期限が近い順に表示されます。

コマンドはWebClassへ直接アクセスせず、定期巡回が保存した `data/state.json` の内容を表示します。そのため、提出状況などは最大で巡回間隔（3時間）ぶん古い場合があります。返信には最終巡回の時刻が表示され、巡回が連続で失敗している場合は警告も表示されます。

### 授業ごとのミュート

`/webclass-mute` で授業名を入力すると、直近の巡回で見つかった授業名が候補に表示されます。ミュートした授業は、新規課題・締切変更・24時間前・当日DMのすべての自動通知が送られなくなります。課題一覧を表示するコマンドには引き続き表示されます。

ミュートは `data/mutes.json` に保存され、次回の自動巡回から適用されます。ミュート中に発生した通知は送信済みとして記録するため、ミュートを解除しても過去の通知がまとめて届くことはありません。

コマンドは起動時に `DISCORD_CHANNEL_ID` のチャンネルがあるサーバーへ登録されます。明示的にサーバーを指定したい場合は `.env` に `DISCORD_GUILD_ID` を追加してください。

## ファイル構成

```text
discordbot_webclass/
├── src/
│   ├── bot.js                  # Discord常駐Bot、スラッシュコマンド
│   ├── index.js                # WebClass確認と自動通知（npm run check）
│   ├── webclass.js             # WebClassログイン・課題抽出
│   ├── state.js                # 前回との差分、通知済み状態
│   ├── mutes.js                # 授業ごとのミュート
│   ├── discord.js              # Discord API送信
│   ├── notification-payload.js # 通知メッセージの内容
│   └── config.js               # 環境変数読み込み
├── test/                       # npm test のテスト
├── deploy/
│   └── logrotate-webclass-cron # logs/cron.log のローテーション設定
├── data/                       # 実行時に作成（Git管理外）
│   ├── state.json              # 課題と通知済み情報
│   ├── runtime-status.json     # 最終巡回成功時刻、連続失敗数
│   ├── mutes.json              # ミュート中の授業
│   └── check.lock              # 二重実行防止
├── logs/                       # 実行時に作成（Git管理外）
└── .env                        # トークン・ID・パスワード（Git管理外）
```

## 環境変数

`.env.example` を参考に `.env` を作成します。`.env` にはトークンとパスワードが入るため、Git・他のAI・不要な共有先に渡さないでください。VPS上では `chmod 600 .env` で所有者以外が読めないようにします。

```env
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
# 通常はDiscordアプリの所有者を自動取得します。自動取得できない場合のみ設定します。
# DISCORD_OWNER_USER_ID=
WEBCLASS_LOGIN_URL=https://webclass.nanzan-u.ac.jp/webclass/login.php
WEBCLASS_USER_ID=
WEBCLASS_PASSWORD=
```

任意の設定です。

| 変数 | 標準値 | 内容 |
| --- | --- | --- |
| `WEBCLASS_TARGET_URLS` | なし | 巡回するページをカンマ区切りで指定（通常は自動検出） |
| `WEBCLASS_HEADLESS` | `true` | `false` でブラウザを表示（ローカルでのデバッグ用） |
| `WEBCLASS_RETRY_ATTEMPTS` | `3` | 取得の再試行回数 |
| `WEBCLASS_RETRY_DELAY_MS` | `30000` | 再試行までの待ち時間 |
| `LOG_RETENTION_DAYS` | `30` | `logs/check-*.log` などの保存日数 |
| `CHECK_TIMEOUT_MINUTES` | `60` | 巡回を強制終了するまでの時間（最大100） |

## VPSでの運用

### 初回セットアップ

```bash
npm install
npx playwright install --with-deps chromium
chmod 600 .env
```

VPSのタイムゾーンは `Asia/Tokyo` にしておきます。`date` と `timedatectl` で確認できます。変更した場合は、`systemctl restart cron` と `pm2 restart webclass-bot` で再起動してください（起動時のタイムゾーンを使い続けるため）。

### 常駐Bot（PM2）

```bash
pm2 list                            # webclass-bot が online であること
pm2 logs webclass-bot --lines 50    # ログ確認
pm2 restart webclass-bot            # 再起動
pm2 restart webclass-bot --update-env  # 環境変数を変更した場合
```

正常に起動すると、ログに `Logged in as ...` と `Commands: /webclass-all, ...` が出ます。VPSの再起動後も自動で起動するよう、初回に `pm2 startup`（表示されたコマンドを実行）と `pm2 save` を済ませておきます。

### 3時間ごとの自動確認（cron）

`crontab -e` に次の1行を登録します。Ubuntu標準のcronは `CRON_TZ` に対応していないため、VPS自体のタイムゾーンで時刻が決まります。

```cron
0 */3 * * * cd /root/discordbot/discordbot_webclass && /usr/bin/npm run check >> /root/discordbot/discordbot_webclass/logs/cron.log 2>&1
```

```bash
crontab -l                    # 登録内容の確認
systemctl status cron         # cronサービスの確認
tail -n 50 logs/cron.log      # 実行ログの確認
npm run check                 # 手動で1回実行
```

成功時は `Done. assignments=2 notifications=0` のように出力されます。`notifications=0` は、通知条件に該当する課題がなかったという意味で、エラーではありません。

### ログの整理

アプリは `logs/check-YYYY-MM-DD.log` と `logs/bot-YYYY-MM-DD.log` を日別に出力し、`LOG_RETENTION_DAYS` を過ぎたものを削除します。cronのリダイレクト先の `logs/cron.log` は削除対象にならないため、logrotateで整理します。

```bash
cp deploy/logrotate-webclass-cron /etc/logrotate.d/webclass-cron
logrotate -d /etc/logrotate.d/webclass-cron   # 設定の確認（実際には何も変更しない）
```

PM2自身のログ（`~/.pm2/logs`）も増え続けるため、必要に応じて `pm2 install pm2-logrotate` を実行します。

### 更新手順

PCでコードを変更したら、WinSCPで `src/`・`test/`・`deploy/`・`package.json`・`package-lock.json`・`README.md` をVPSへ転送します。`.env`・`data/`・`node_modules/` は上書きしません。

```bash
cd /root/discordbot/discordbot_webclass
npm install                   # package.json を変更したときだけでも可
npm test
pm2 restart webclass-bot
npm run check
pm2 logs webclass-bot --lines 50
```

## 動作確認用のコマンド

```bash
npm run test:discord       # 指定チャンネルにテストメッセージを送信
npm run inspect:webclass   # 取得できた課題候補を表示し、HTMLを debug/webclass.html に保存
```

課題が検出されない場合は、WebClassで課題一覧ページを開き、そのURLを `.env` の `WEBCLASS_TARGET_URLS` に設定してください。

## Windowsで動かす場合

ローカルのWindowsで動かす場合は、次のコマンドでタスクスケジューラに登録できます。VPSでは使いません。

```powershell
npm run schedule:windows      # 3時間ごとの npm run check
npm run bot:schedule:windows  # ログオン時に npm run bot
```
