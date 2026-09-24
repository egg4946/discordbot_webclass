import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, isReportQuestion } from './task-answer.js';
import { ATTEMPT_CATEGORIES } from './task-fetch.js';
import { describeValues, validateAnswers } from './task-questions.js';
import { reportFiles } from './task-report.js';
import { FINISHED_STATUSES, TASK_ROOT, readJson, readTask, readText, saveJson, saveText, taskDir, taskPath, updateTask } from './task-store.js';
import { approveTask, reviewTask } from './task-submit.js';

// Local web UI for the assignment workflow: the same steps as `npm run task`, but with the
// questions, the materials and both AIs' answers on one screen so answers can be checked and
// edited by hand. Everything that opens WebClass or runs a solver is executed by spawning
// src/task-cli.js, so the UI cannot bypass the review → approve → submit guard rails.
const UI_FILE = fileURLToPath(new URL('./ui/task-ui.html', import.meta.url));
const CLI_FILE = fileURLToPath(new URL('./task-cli.js', import.meta.url));
const CONTENTS_CACHE = join(TASK_ROOT, 'contents.json');
const TASK_ID = /^[a-f0-9]{16}$/;
// Files inside the task folder the browser may load (page images, screenshots, report PDF,
// material text). The saved WebClass HTML is deliberately not servable as HTML.
const SERVABLE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
};
// Long jobs run one at a time; cancelling a submission is refused because pressing 採点 may
// already have reached WebClass.
const UNCANCELLABLE = ['submit'];

// Builds the argv for src/task-cli.js. Every value is checked here, so nothing the browser
// sends can turn into an extra command line flag.
export function commandArgs(action, params = {}) {
  const id = () => {
    if (!TASK_ID.test(String(params.id ?? ''))) throw new Error('task-id が正しくありません。');
    return params.id;
  };
  const contentsId = () => {
    if (!/^[a-f0-9]{32}$/.test(String(params.contentsId ?? ''))) throw new Error('課題のIDが正しくありません。');
    return params.contentsId;
  };
  const numbers = () => (params.questions ?? []).map((value) => {
    if (!Number.isInteger(Number(value)) || Number(value) <= 0) throw new Error('設問番号が正しくありません。');
    return String(Number(value));
  });
  const attempt = () => (params.allowAttempt ? ['--allow-attempt'] : []);
  switch (action) {
    case 'list':
      return ['list', '--json'];
    case 'fetch': {
      // The UI normally sends the WebClass contents id, which selects exactly one item.
      // Free text is matched word by word against "授業名 課題名"; a lone separator that the
      // screen shows between the two ("授業名 / 課題名") is dropped because it can never match.
      const words = params.contentsId
        ? [contentsId()]
        : String(params.query ?? '').split(/\s+/).filter((word) => word && !['/', '／'].includes(word));
      if (words.length === 0) throw new Error('課題を指定してください。');
      if (words.some((word) => word.startsWith('-'))) throw new Error('課題名に - から始まる語は使えません。');
      const materials = (params.materialQueries ?? []).filter(Boolean).map(String);
      if (materials.some((value) => value.startsWith('-'))) throw new Error('資料名に - から始まる語は使えません。');
      return ['fetch', ...words, ...attempt(), ...(params.force ? ['--force'] : []),
        ...(params.materials === false ? ['--no-materials'] : []),
        ...materials.flatMap((value) => ['--material', value])];
    }
    case 'answer': {
      const which = params.provider ?? 'both';
      if (!['both', ...PROVIDERS].includes(which)) throw new Error('AIは claude / codex / both から選んでください。');
      const prefer = params.prefer && PROVIDERS.includes(params.prefer) ? ['--prefer', params.prefer] : [];
      return ['answer', id(), which, ...prefer];
    }
    case 'select':
      if (!PROVIDERS.includes(params.provider)) throw new Error('AIは claude / codex から選んでください。');
      return ['select', id(), params.provider, ...numbers()];
    case 'render':
      return ['render', id(), ...numbers()];
    case 'dry-run':
      return ['dry-run', id(), ...attempt()];
    case 'submit':
      return ['submit', id(), ...attempt()];
    default:
      throw new Error(`不明な操作です: ${action}`);
  }
}

// `list --json` prints the contents array as one line. stderr is captured into the same
// output, and warnings such as "(node:1) [DEP0040] ..." contain brackets too, so only a
// whole line that is an array counts.
export function parseListJson(output) {
  const line = String(output).split(/\r?\n/).map((item) => item.trim()).reverse()
    .find((item) => item.startsWith('[') && item.endsWith(']'));
  if (!line) throw new Error('一覧を読み取れませんでした。');
  return JSON.parse(line);
}

// A file the browser asked for must stay inside the task folder and have a servable extension.
export function resolveTaskAsset(id, relativePath) {
  const root = taskDir(id);
  const value = String(relativePath ?? '');
  if (!value || /^[a-zA-Z]:[\\/]|^[\\/]/.test(value)) throw new Error('課題フォルダ内のファイルを指定してください。');
  const path = resolve(root, value);
  if (!path.startsWith(root + sep)) throw new Error('課題フォルダ内のファイルを指定してください。');
  const type = SERVABLE[extname(path).toLowerCase()];
  if (!type) throw new Error(`この形式のファイルは開けません: ${extname(path) || value}`);
  return { path, type };
}

// Applies the edits made in the UI to answer.json. Only the edited questions are validated, so
// one unsupported question cannot block editing the rest, and an edited answer stops counting
// as an AI answer.
export function applyAnswerEdits(questions, draft, edits) {
  const answers = (draft.answers ?? []).map((answer) => ({ ...answer, question: Number(answer.question) }));
  const edited = [];
  for (const edit of edits ?? []) {
    const number = Number(edit.question);
    const question = questions.find((item) => item.number === number);
    if (!question) throw new Error(`設問${edit.question} は存在しません。`);
    if (!Array.isArray(edit.values)) throw new Error(`設問${number}: values は配列にしてください。`);
    const values = edit.values.map((value) => String(value));
    const existing = answers.find((answer) => answer.question === number);
    if (existing) Object.assign(existing, { values, source: 'user', conflict: false });
    else answers.push({ question: number, values, source: 'user', conflict: false });
    edited.push(number);
  }
  validateAnswers(
    questions.filter((question) => edited.includes(question.number)),
    answers.filter((answer) => edited.includes(answer.question)),
  );
  return { ...draft, answers };
}

// A running answer / select / render job rewrites answer.json or the report when it ends,
// so a change saved meanwhile would be overwritten without notice.
export function assertNoRunningJob(job, id) {
  if (job?.status === 'running' && job.taskId === id) {
    throw new Error(`この課題で「${job.label}」を実行中です。終わってから保存してください（編集内容は画面に残っています）。`);
  }
}

export function taskSummary(task) {
  return {
    id: task.id,
    status: task.status,
    error: task.error ?? null,
    layout: task.layout ?? null,
    approved: Boolean(task.approval),
    submittedAt: task.submittedAt ?? null,
    questionCount: task.questions?.length ?? 0,
    unsupported: task.unsupported ?? [],
    item: task.item ?? null,
  };
}

async function readTasks() {
  const entries = await readdir(TASK_ROOT, { withFileTypes: true }).catch(() => []);
  const tasks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TASK_ID.test(entry.name)) continue;
    const task = await readTask(entry.name).catch(() => null);
    if (task) tasks.push(taskSummary({ ...task, id: entry.name }));
  }
  return tasks.sort((left, right) => deadlineKey(left).localeCompare(deadlineKey(right)));
}

function deadlineKey(summary) {
  return summary.item?.deadlineAt ?? '9999';
}

// Everything one task screen needs: the questions, the answer that would be submitted, both
// AIs' answers with their evidence, and the hash `approve` expects.
async function buildDetail(id) {
  const task = await readTask(id);
  const draft = await readJson(id, 'answer.json').catch(() => ({ providers: [], answers: [], notes: '' }));
  const solvers = {};
  for (const provider of PROVIDERS) {
    solvers[provider] = await readJson(id, `answer-${provider}.json`).catch(() => null);
  }

  let digest = null;
  let reviewError = null;
  try {
    ({ digest } = await reviewTask(id));
  } catch (error) {
    reviewError = error.message;
  }

  const questions = [];
  for (const question of task.questions ?? []) {
    const answer = draft.answers?.find((item) => Number(item.question) === question.number);
    const entry = {
      ...question,
      draft: answer ? { values: answer.values, source: answer.source ?? null, conflict: Boolean(answer.conflict) } : null,
      describe: answer ? safeDescribe(question, answer.values) : null,
      solvers: {},
      report: null,
    };
    for (const provider of PROVIDERS) {
      const own = solvers[provider]?.answers?.find((item) => Number(item.question) === question.number);
      const report = solvers[provider]?.reports?.find((item) => Number(item.question) === question.number);
      if (!own && !report) continue;
      entry.solvers[provider] = {
        model: solvers[provider].model ?? null,
        effort: solvers[provider].effort ?? null,
        values: own?.values ?? null,
        describe: own ? safeDescribe(question, own.values) : null,
        markdown: report?.markdown ?? null,
        confidence: (report ?? own).confidence ?? null,
        evidence: (report ?? own).evidence ?? '',
      };
    }
    if (isReportQuestion(question)) {
      const { markdown, pdf } = reportFiles(question.number);
      entry.report = {
        markdownFile: markdown,
        pdfFile: pdf,
        markdown: await readText(id, markdown).catch(() => ''),
        pdfExists: await stat(taskPath(id, pdf)).then(() => true).catch(() => false),
      };
    }
    questions.push(entry);
  }

  const files = await readdir(taskDir(id)).catch(() => []);
  return {
    task: { ...task, questions: undefined },
    questions,
    notes: draft.notes ?? '',
    providers: draft.providers ?? [],
    digest,
    reviewError,
    screenshots: files.filter((name) => /\.png$/.test(name)).sort(),
    receipt: files.includes('submission-receipt.txt')
      ? (await readText(id, 'submission-receipt.txt').catch(() => '')).slice(0, 20000)
      : null,
    solverErrors: Object.fromEntries(PROVIDERS.map((provider) => [provider, solvers[provider] ? null : 'まだ実行していません'])),
  };
}

function safeDescribe(question, values) {
  try {
    return describeValues(question, values);
  } catch {
    return values.join(' / ');
  }
}

export function createTaskServer({ token = randomBytes(24).toString('hex'), port = 5173 } = {}) {
  const clients = new Set();
  let job = null;
  let child = null;

  const broadcast = (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(payload);
  };
  const jobView = () => (job ? { ...job, lines: job.lines.slice(-400) } : null);
  const pushLine = (line) => {
    job.lines.push(line);
    if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
    broadcast({ type: 'log', line });
  };

  function startJob(action, params) {
    if (job?.status === 'running') throw new Error(`「${job.label}」を実行中です。終わるまで待ってください。`);
    const args = commandArgs(action, params);
    job = {
      action,
      label: JOB_LABELS[action] ?? action,
      taskId: TASK_ID.test(String(params?.id ?? '')) ? params.id : null,
      command: `npm run task -- ${args.join(' ')}`,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      cancellable: !UNCANCELLABLE.includes(action),
      lines: [],
      output: '',
    };
    broadcast({ type: 'job', job: jobView() });

    child = spawn(process.execPath, [CLI_FILE, ...args], { cwd: process.cwd(), env: process.env, windowsHide: true });
    // Decoded by the streams, so a Japanese character split between two chunks stays intact.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let pending = '';
    const onData = (data) => {
      job.output += data;
      pending += data;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) pushLine(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => pushLine(`起動に失敗しました: ${error.message}`));
    child.on('close', async (code) => {
      if (pending) pushLine(pending);
      if (code === 0 && action === 'list') {
        try {
          await mkdir(TASK_ROOT, { recursive: true });
          await writeFile(CONTENTS_CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), items: parseListJson(job.output) }, null, 2));
        } catch (error) {
          pushLine(`一覧の保存に失敗しました: ${error.message}`);
        }
      }
      child = null;
      Object.assign(job, { status: code === 0 ? 'done' : 'failed', exitCode: code, finishedAt: new Date().toISOString() });
      job.output = '';
      broadcast({ type: 'job', job: jobView() });
    });
    return jobView();
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`);
      if (!isLocalHost(request.headers.host, server.address()?.port ?? port)) {
        return send(response, 403, { error: 'localhost からのみ使えます。' });
      }
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        return send(response, 403, { error: 'このページ以外からは使えません。' });
      }
      if (!authorized(request, url, token)) {
        return send(response, 401, { error: '起動時に表示されたURL（?t=... 付き）で開いてください。' });
      }
      await route(request, response, url);
    } catch (error) {
      send(response, error.status ?? 400, { error: error.message });
    }
  });

  async function route(request, response, url) {
    const path = url.pathname;
    const method = request.method;

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await readFile(UI_FILE, 'utf8');
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'self'",
      });
      return response.end(html);
    }

    if (method === 'GET' && path === '/api/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      response.write(`data: ${JSON.stringify({ type: 'job', job: jobView() })}\n\n`);
      clients.add(response);
      const keepAlive = setInterval(() => response.write(': ping\n\n'), 25000);
      request.on('close', () => {
        clearInterval(keepAlive);
        clients.delete(response);
      });
      return undefined;
    }

    if (method === 'GET' && path === '/api/state') {
      const contents = await readFile(CONTENTS_CACHE, 'utf8').then(JSON.parse).catch(() => null);
      return send(response, 200, {
        tasks: await readTasks(),
        contents,
        job: jobView(),
        attemptCategories: ATTEMPT_CATEGORIES,
        providers: PROVIDERS,
        taskRoot: TASK_ROOT,
      });
    }

    if (method === 'POST' && path === '/api/job') {
      const body = await readBody(request);
      return send(response, 200, { job: startJob(body.action, body) });
    }

    if (method === 'POST' && path === '/api/job/cancel') {
      if (!job || job.status !== 'running') throw new Error('実行中の操作はありません。');
      if (!job.cancellable) throw new Error('提出は途中で止められません。ログと結果を確認してください。');
      child?.kill();
      pushLine('中止しました。');
      return send(response, 200, { job: jobView() });
    }

    const taskMatch = path.match(/^\/api\/task\/([a-f0-9]{16})(\/[a-z-]+)?(?:\/(\d+))?$/);
    if (taskMatch) {
      const [, id, section, number] = taskMatch;
      if (method === 'GET' && !section) return send(response, 200, await buildDetail(id));

      if (method === 'GET' && section === '/file') {
        const { path: filePath, type } = resolveTaskAsset(id, url.searchParams.get('path'));
        const info = await stat(filePath).catch(() => null);
        if (!info?.isFile()) return send(response, 404, { error: 'ファイルがありません。' });
        response.writeHead(200, {
          'content-type': type,
          'content-length': info.size,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        // The file can disappear or be locked (a PDF being rebuilt) after stat(); the headers
        // are already sent, so the response is cut off instead of crashing the server.
        const stream = createReadStream(filePath);
        stream.on('error', () => response.destroy());
        return stream.pipe(response);
      }

      if (method === 'GET' && section === '/dir') {
        // Page images live in a per-material folder, so the UI asks for its file names.
        const root = taskDir(id);
        const dir = resolve(root, String(url.searchParams.get('path') ?? ''));
        if (!dir.startsWith(root + sep)) throw new Error('課題フォルダ内のフォルダを指定してください。');
        const names = await readdir(dir).catch(() => []);
        return send(response, 200, { names: names.filter((name) => SERVABLE[extname(name).toLowerCase()]).sort() });
      }

      if (method === 'PUT' && section === '/answer') {
        const task = await requireEditable(id);
        const draft = await readJson(id, 'answer.json').catch(() => ({ providers: [], answers: [], notes: '' }));
        const next = applyAnswerEdits(task.questions ?? [], draft, (await readBody(request)).answers);
        await saveJson(id, 'answer.json', next);
        await updateTask(id, { status: 'answered', approval: null });
        return send(response, 200, await buildDetail(id));
      }

      if (method === 'PUT' && section === '/report') {
        const task = await requireEditable(id);
        const question = (task.questions ?? []).find((item) => item.number === Number(number));
        if (!question || !isReportQuestion(question)) throw new Error(`設問${number} はレポート提出の設問ではありません。`);
        const markdown = String((await readBody(request)).markdown ?? '');
        if (!markdown.trim()) throw new Error('レポート本文が空です。');
        await saveText(id, reportFiles(question.number).markdown, markdown);
        // The PDF is now older than the Markdown, so the approval no longer matches what
        // would be uploaded. `render` rebuilds it.
        await updateTask(id, { approval: null });
        return send(response, 200, await buildDetail(id));
      }

      if (method === 'POST' && section === '/approve') {
        assertNoJob(id);
        const { digest } = await readBody(request);
        await approveTask(id, String(digest ?? '').slice(0, 64));
        return send(response, 200, await buildDetail(id));
      }
    }

    return send(response, 404, { error: 'そのURLはありません。' });
  }

  const assertNoJob = (id) => assertNoRunningJob(job, id);

  async function requireEditable(id) {
    assertNoJob(id);
    const task = await readTask(id);
    if (FINISHED_STATUSES.includes(task.status)) {
      throw new Error(`この課題は既に提出処理に入っています (status: ${task.status})。解答は変更できません。`);
    }
    return task;
  }

  return {
    server,
    token,
    port,
    url: `http://127.0.0.1:${port}/?t=${token}`,
    listen: () => new Promise((done) => server.listen(port, '127.0.0.1', done)),
  };
}

const JOB_LABELS = {
  list: '課題一覧を取得',
  fetch: '課題を取得',
  answer: 'AIが解答を作成',
  select: '解答を差し替え',
  render: 'レポートPDFを作成',
  'dry-run': '入力だけ試す（提出しない）',
  submit: '提出',
};

function isLocalHost(host, port) {
  return ['127.0.0.1', 'localhost', '[::1]'].map((name) => `${name}:${port}`).includes(String(host));
}

function authorized(request, url, token) {
  const given = request.headers['x-task-token'] ?? url.searchParams.get('t') ?? '';
  const left = Buffer.from(String(given));
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

function send(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

async function readBody(request, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('送信されたデータが大きすぎます。');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
