import { spawn } from 'node:child_process';
import { createTaskServer } from './task-server.js';

// Starts the local assignment UI. It listens on 127.0.0.1 only and every request must carry
// the token printed below, so nothing else on the network can drive WebClass through it.
const args = process.argv.slice(2);
const portArgument = args.find((arg) => /^--port=\d+$/.test(arg))?.split('=')[1];
const port = Number(portArgument ?? process.env.TASK_UI_PORT ?? 5173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error(`ポート番号が正しくありません: ${port}`);
  process.exit(1);
}

const ui = createTaskServer({ port });
ui.server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `ポート ${port} は使用中です。npm run task:ui -- --port=5174 のように変えてください。`
    : error.message);
  process.exit(1);
});
await ui.listen();

console.log('WebClass課題UIを起動しました。次のURLを開いてください（トークン付きURLは他人に渡さないでください）:');
console.log(`  ${ui.url}`);
console.log('終了するには Ctrl+C を押してください。');

if (!args.includes('--no-open')) {
  openBrowser(ui.url);
}

function openBrowser(url) {
  const [command, commandArgs] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log('ブラウザを自動で開けませんでした。上のURLを貼り付けて開いてください。'));
  child.unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    ui.server.close();
    process.exit(0);
  });
}
