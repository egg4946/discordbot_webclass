import { loadConfig } from './config.js';
import { sendDiscordMessage } from './discord.js';

async function main() {
  const config = loadConfig();
  await sendDiscordMessage(config, {
    content: 'WebClass通知BotのDiscord接続テストです。',
  });
  console.log('Discord test message sent.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
