import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { parseQuestionForm } from '../src/task-questions.js';
import { readJson, readTask, saveJson, saveTask, saveText, taskDir, taskPath } from '../src/task-store.js';
import { applyAnswerEdits, assertNoRunningJob, commandArgs, createTaskServer, parseListJson, resolveTaskAsset, taskSummary } from '../src/task-server.js';
import { holdLockInChild } from './lock-holder.js';

const ID = 'abcdef0123456700';
const FORM = `
<form name="answer_form" method="POST">
  <dl class="question" id="id_question_1"><dt>設問 1</dt><dd><span>語を入れよ。</span></dd></dl>
  <table class="qstnoptions"><tr><td><fieldset id="QF_1">
    <input type="hidden" name="QuestionAnswer[1][style]" value="wordinput">
    <table class="wordinput"><tr><td class="prefix">(1)</td><td><input type="text" name="QuestionAnswer[1][value][]" value="" maxlength="10"></td></tr></table>
  </fieldset></td></tr></table>
  <dl class="question" id="id_question_2"><dt>設問 2</dt><dd><span>1つ選べ。</span></dd></dl>
  <table class="qstnoptions"><tr><td><fieldset id="QF_2">
    <input type="hidden" name="QuestionAnswer[2][style]" value="radio">
    <table class="seloptions">
      <tr><th class="prefix"><label for="2_1">1.</label></th><td><input id="2_1" type="radio" name="QuestionAnswer[2][value]" value="1"></td><td class="option-label"><label for="2_1">甲</label></td></tr>
      <tr><th class="prefix"><label for="2_2">2.</label></th><td><input id="2_2" type="radio" name="QuestionAnswer[2][value]" value="2"></td><td class="option-label"><label for="2_2">乙</label></td></tr>
    </table>
  </fieldset></td></tr></table>
</form>`;

test('the UI can only build the assignment commands, never extra flags', () => {
  assert.deepEqual(commandArgs('list'), ['list', '--json']);
  assert.deepEqual(commandArgs('fetch', { query: ' ソフトウェア工学基礎  第1回 ', allowAttempt: true }),
    ['fetch', 'ソフトウェア工学基礎', '第1回', '--allow-attempt']);
  assert.deepEqual(commandArgs('fetch', { query: '通信理論', materials: false, materialQueries: ['第2回'] }),
    ['fetch', '通信理論', '--no-materials', '--material', '第2回']);
  // The screen knows which item was clicked, so it sends the WebClass contents id, not the
  // internal task-id, and the separator it shows between course and title never becomes a word.
  assert.deepEqual(commandArgs('fetch', { contentsId: '322ca2348d297f2009c484bb217aea38', allowAttempt: true }),
    ['fetch', '322ca2348d297f2009c484bb217aea38', '--allow-attempt']);
  assert.deepEqual(commandArgs('fetch', { query: 'ネットワークプログラミング [副] / 第2回 理解度確認-1' }),
    ['fetch', 'ネットワークプログラミング', '[副]', '第2回', '理解度確認-1']);
  assert.throws(() => commandArgs('fetch', { contentsId: ID }), /課題のID/);
  assert.deepEqual(commandArgs('fetch', { contentsId: '322ca2348d297f2009c484bb217aea38', force: true }),
    ['fetch', '322ca2348d297f2009c484bb217aea38', '--force']);
  assert.deepEqual(commandArgs('answer', { id: ID, provider: 'claude', prefer: 'codex' }),
    ['answer', ID, 'claude', '--prefer', 'codex']);
  assert.deepEqual(commandArgs('select', { id: ID, provider: 'codex', questions: ['3', 7] }), ['select', ID, 'codex', '3', '7']);
  assert.deepEqual(commandArgs('submit', { id: ID }), ['submit', ID]);
  assert.deepEqual(commandArgs('retry', { id: ID, questions: [4] }), ['retry', ID, 'both', '4']);
  assert.throws(() => commandArgs('retry', { id: ID, questions: ['--force'] }), /設問番号/);

  // A value from the browser must never become an option of its own.
  assert.throws(() => commandArgs('fetch', { query: '課題 --allow-attempt' }), /- から始まる/);
  assert.throws(() => commandArgs('fetch', { query: '課題', materialQueries: ['--no-materials'] }), /- から始まる/);
  assert.throws(() => commandArgs('submit', { id: '../../etc' }), /task-id/);
  assert.throws(() => commandArgs('answer', { id: ID, provider: 'gpt' }), /claude/);
  assert.throws(() => commandArgs('select', { id: ID, provider: 'codex', questions: ['1; rm'] }), /設問番号/);
  assert.throws(() => commandArgs('approve', { id: ID }), /不明な操作/);
  // Only the checked string is passed on; an array id would slip past the per-task job lock.
  assert.deepEqual(commandArgs('render', { id: [ID] }), ['render', ID]);
});

test('served task files stay inside the task folder and keep a known type', () => {
  assert.equal(resolveTaskAsset(ID, 'after-submit.png').path, join(taskDir(ID), 'after-submit.png'));
  assert.equal(resolveTaskAsset(ID, 'materials/images/a/p001.png').type, 'image/png');
  assert.throws(() => resolveTaskAsset(ID, '../../.env'), /課題フォルダ内/);
  assert.throws(() => resolveTaskAsset(ID, '/etc/passwd'), /課題フォルダ内/);
  assert.throws(() => resolveTaskAsset(ID, 'question.html'), /開けません/);
  assert.throws(() => resolveTaskAsset(ID, ''), /課題フォルダ内/);
});

test('parseListJson reads the array printed by `list --json`', () => {
  assert.deepEqual(parseListJson('よけいな行\n[{"contentsId":"a"}]\n'), [{ contentsId: 'a' }]);
  assert.throws(() => parseListJson('エラーだけ'), /読み取れません/);
  // stderr is captured too, and Node's warnings carry brackets of their own.
  assert.deepEqual(parseListJson('(node:1) [DEP0040] DeprecationWarning: punycode\r\n[{"contentsId":"b"}]\r\n'),
    [{ contentsId: 'b' }]);
  assert.throws(() => parseListJson('(node:1) [DEP0040] DeprecationWarning'), /読み取れません/);
});

test('editing an answer in the UI validates it and drops the AI attribution', () => {
  const questions = parseQuestionForm(FORM);
  const draft = { providers: ['claude'], answers: [
    { question: 1, values: ['前回'], source: 'agreed', conflict: false },
    { question: 2, values: ['1'], source: 'claude', conflict: true },
  ] };
  const next = applyAnswerEdits(questions, draft, [{ question: 2, values: ['2'] }]);
  assert.deepEqual(next.answers[1], { question: 2, values: ['2'], source: 'user', conflict: false });
  assert.deepEqual(next.answers[0], draft.answers[0]);
  assert.equal(next.providers, draft.providers);

  assert.throws(() => applyAnswerEdits(questions, draft, [{ question: 2, values: ['9'] }]), /設問2/);
  assert.throws(() => applyAnswerEdits(questions, draft, [{ question: 1, values: ['0123456789A'] }]), /上限/);
  assert.throws(() => applyAnswerEdits(questions, draft, [{ question: 9, values: ['x'] }]), /存在しません/);
  assert.throws(() => applyAnswerEdits(questions, draft, [{ question: 1, values: 'text' }]), /配列/);
  // An unanswered or unsupported question elsewhere must not block editing this one.
  assert.deepEqual(applyAnswerEdits(questions, { answers: [] }, [{ question: 1, values: ['語'] }]).answers,
    [{ question: 1, values: ['語'], source: 'user', conflict: false }]);
});

test('the local server refuses requests without the token and serves the task screen', async () => {
  const questions = parseQuestionForm(FORM);
  await saveTask(ID, { id: ID, status: 'answered', questions, fingerprint: 'x', materials: [],
    item: { courseName: '授業', title: '課題', deadlineAt: null, category: '課題' } });
  await saveJson(ID, 'answer.json', { providers: ['claude'], answers: [
    { question: 1, values: ['前回'], source: 'claude', conflict: false },
    { question: 2, values: ['2'], source: 'claude', conflict: true },
  ] });
  const ui = createTaskServer({ token: 'test-token', port: 0 });
  await ui.listen();
  const port = ui.server.address().port;
  const call = (path, options = {}) => fetch(`http://127.0.0.1:${port}${path}`, options);
  try {
    assert.equal((await call('/api/state')).status, 401);
    assert.equal((await call('/api/state?t=wrong-token')).status, 401);
    assert.equal((await call('/api/state', { headers: { 'x-task-token': 'test-token' } })).status, 200);
    // A page in another site must not be able to drive the UI even if the token leaks.
    assert.equal((await call('/api/state?t=test-token', { headers: { origin: 'https://example.com' } })).status, 403);
    // fetch() refuses to set Host, so the DNS-rebinding guard is checked with a raw request.
    assert.equal(await statusWithHost(port, `/api/state?t=test-token`, 'example.com:' + port), 403);

    const detail = await call(`/api/task/${ID}?t=test-token`).then((response) => response.json());
    assert.equal(detail.questions.length, 2);
    assert.equal(detail.questions[1].describe, '2. 乙');
    assert.equal(detail.questions[1].draft.conflict, true);
    assert.equal(detail.digest.length, 64);

    const edited = await call(`/api/task/${ID}/answer?t=test-token`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ question: 2, values: ['1'] }] }),
    }).then((response) => response.json());
    assert.equal(edited.questions[1].draft.source, 'user');
    // The hash approval quotes must change with the answer.
    assert.notEqual(edited.digest, detail.digest);

    const traversal = await call(`/api/task/${ID}/file?path=..%2F..%2F..%2F.env&t=test-token`);
    assert.equal(traversal.status, 400);
    assert.equal((await call('/api/task/zzzz/file?t=test-token')).status, 404);
  } finally {
    ui.server.close();
    await rm(taskDir(ID), { recursive: true, force: true });
  }
});

test('edits are refused while a job for the same task is running', () => {
  const running = { status: 'running', taskId: ID, label: 'AIが解答を作成' };
  assert.throws(() => assertNoRunningJob(running, ID), /AIが解答を作成/);
  assert.doesNotThrow(() => assertNoRunningJob(running, 'abcdef0123456701'));
  assert.doesNotThrow(() => assertNoRunningJob({ ...running, status: 'done' }, ID));
  assert.doesNotThrow(() => assertNoRunningJob(null, ID));
});

test('saving a report returns the task with the saved text', async () => {
  const id = 'abcdef0123456701';
  const [question] = parseQuestionForm(`<form name="answer_form">
    <dl class="question" id="id_question_1"><dt>設問 1</dt><dd><span>レポートを提出せよ。</span></dd></dl>
    <table class="qstnoptions"><tr><td><fieldset id="QF_1">
      <input type="hidden" name="QuestionAnswer[1][style]" value="report">
      <span id="file1"><input type="file" name="report1" accept=".pdf"></span>
    </fieldset></td></tr></table></form>`);
  await saveTask(id, { id, status: 'approved', approval: { digest: 'old' }, questions: [question], fingerprint: 'x', materials: [],
    item: { courseName: '授業', title: '課題', deadlineAt: null } });
  await saveText(id, 'report-q1.md', '古い本文');
  const ui = createTaskServer({ token: 'test-token', port: 0 });
  await ui.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${ui.server.address().port}/api/task/${id}/report/1?t=test-token`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown: '新しい本文' }),
    });
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.questions[0].report.markdown, '新しい本文');
    // The approval no longer matches, so the task is back to a draft like every other edit.
    assert.equal(detail.task.status, 'answered');
    assert.equal(detail.task.approval, null);
  } finally {
    ui.server.close();
    await rm(taskDir(id), { recursive: true, force: true });
  }
});

test('grades past the displayed part of a long receipt are still read', async () => {
  const id = 'abcdef0123456702';
  await saveTask(id, { id, status: 'submitted', questions: [], fingerprint: 'x', materials: [],
    item: { courseName: '授業', title: '課題', deadlineAt: null } });
  const rows = Array.from({ length: 1500 }, (_, index) => `${index + 1}\t甲\t○\t1 / 1`);
  rows.push('1501\t乙\t×\t0 / 1');
  await saveText(id, 'submission-receipt.txt', `問\t解答\t結果\t得点/配点\n${rows.join('\n')}\n`);
  const ui = createTaskServer({ token: 'test-token', port: 0 });
  await ui.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${ui.server.address().port}/api/task/${id}?t=test-token`);
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.receipt.length, 20000);
    assert.deepEqual(detail.grades.at(-1), { question: 1501, answer: '乙', mark: '×', score: 0, max: 1 });
  } finally {
    ui.server.close();
    await rm(taskDir(id), { recursive: true, force: true });
  }
});

test('taskSummary keeps the list light and hides nothing needed to choose a task', () => {
  const summary = taskSummary({ id: ID, status: 'approved', approval: { digest: 'a' }, questions: [{}, {}],
    unsupported: [3], item: { courseName: '授業', title: '課題', deadlineAt: null } });
  assert.deepEqual(summary, { id: ID, status: 'approved', error: null, layout: null, approved: true, submittedAt: null,
    questionCount: 2, unsupported: [3], item: { courseName: '授業', title: '課題', deadlineAt: null } });
});

test('an edit from the UI is refused while a submit holds the task lock', async () => {
  const id = 'abcdef0123456703';
  const questions = parseQuestionForm(FORM);
  const approved = { id, status: 'approved', approval: { digest: 'd' }, questions, fingerprint: 'x', materials: [],
    item: { courseName: '授業', title: '課題', deadlineAt: null } };
  await saveTask(id, approved);
  await saveJson(id, 'answer.json', { providers: [], answers: [] });
  // What a submit started from the CLI holds while it is on WebClass.
  const submit = await holdLockInChild('task', id);
  const ui = createTaskServer({ token: 'test-token', port: 0 });
  await ui.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${ui.server.address().port}/api/task/${id}/answer?t=test-token`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers: [{ question: 1, values: ['語'] }] }),
    });
    assert.notEqual(response.status, 200);
    assert.match((await response.json()).error, /既に実行中/);
    assert.deepEqual(await readTask(id), approved);
  } finally {
    ui.server.close();
    await submit.release();
    await rm(taskDir(id), { recursive: true, force: true });
  }
});

// A PUT whose headers (and half of the body) go out at once and whose body is completed by
// `finish()`, like a browser on a slow connection: the server has started on it meanwhile.
async function slowPut(port, path, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const put = request({ host: '127.0.0.1', port, path, method: 'PUT', headers: {
    'content-type': 'application/json', 'content-length': payload.length } });
  const response = new Promise((resolve, reject) => {
    put.on('response', (answer) => {
      let text = '';
      answer.setEncoding('utf8');
      answer.on('data', (chunk) => { text += chunk; });
      answer.on('end', () => resolve({ status: answer.statusCode, body: JSON.parse(text) }));
    });
    put.on('error', reject);
  });
  put.write(payload.subarray(0, 5));
  await new Promise((done) => setTimeout(done, 300));
  return { finish: () => { put.end(payload.subarray(5)); return response; } };
}

async function withSaveServer(id, answerJson, run) {
  const questions = parseQuestionForm(FORM);
  await saveTask(id, { id, status: 'approved', approval: { digest: 'd' }, questions, fingerprint: 'x', materials: [],
    item: { courseName: '授業', title: '課題', deadlineAt: null } });
  await saveJson(id, 'answer.json', answerJson);
  const ui = createTaskServer({ token: 'test-token', port: 0 });
  await ui.listen();
  const port = ui.server.address().port;
  const path = `/api/task/${id}/answer?t=test-token`;
  const put = async (answers) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }) });
    return { status: response.status, body: await response.json() };
  };
  try {
    await run({ put, slowPut: (answers) => slowPut(port, path, { answers }) });
  } finally {
    ui.server.close();
    await rm(taskDir(id), { recursive: true, force: true });
  }
}

const AI_DRAFT = { providers: ['claude', 'codex'], notes: 'AIのメモ', answers: [
  { question: 1, values: ['前回'], source: 'agreed', conflict: false, evidence: '資料p.3' },
  { question: 2, values: ['1'], source: 'claude', conflict: true, evidence: '資料p.5' },
] };

test('UI saves of different questions that overlap keep both changes', { timeout: 30000 }, async () => {
  const id = 'abcdef0123456705';
  await withSaveServer(id, AI_DRAFT, async ({ put, slowPut }) => {
    const first = await slowPut([{ question: 1, values: ['語'] }]);
    assert.equal((await put([{ question: 2, values: ['2'] }])).status, 200);
    assert.equal((await first.finish()).status, 200);

    const { answers } = await readJson(id, 'answer.json');
    assert.deepEqual(answers.map(({ question, values, source }) => ({ question, values, source })), [
      { question: 1, values: ['語'], source: 'user' },
      { question: 2, values: ['2'], source: 'user' },
    ]);
  });
});

test('UI saves of the same question end with the save that took the task lock last', { timeout: 30000 }, async () => {
  const id = 'abcdef0123456706';
  await withSaveServer(id, AI_DRAFT, async ({ put, slowPut }) => {
    // The slow save's body arrives last, so it is applied last.
    const slow = await slowPut([{ question: 1, values: ['遅い方'] }]);
    assert.equal((await put([{ question: 1, values: ['速い方'] }])).status, 200);
    assert.equal((await slow.finish()).status, 200);
    assert.deepEqual((await readJson(id, 'answer.json')).answers[0].values, ['遅い方']);

    assert.equal((await put([{ question: 1, values: ['一つ目'] }])).status, 200);
    const last = await put([{ question: 1, values: ['二つ目'] }]);
    assert.equal(last.status, 200);
    assert.deepEqual((await readJson(id, 'answer.json')).answers[0].values, ['二つ目']);
    assert.deepEqual(last.body.questions[0].draft.values, ['二つ目']);
  });
});

test('a UI save still waiting for its body is refused once a submit has finished', { timeout: 30000 }, async () => {
  const id = 'abcdef0123456707';
  await withSaveServer(id, AI_DRAFT, async ({ slowPut }) => {
    const pending = await slowPut([{ question: 1, values: ['語'] }]);
    // A submit from another process: it holds the task lock while it writes its result.
    const submit = await holdLockInChild('task', id);
    const submitted = { ...(await readTask(id)), status: 'submitted', submittedAt: '2026-10-06T00:00:00.000Z' };
    await saveTask(id, submitted);
    await submit.release();

    const response = await pending.finish();
    assert.notEqual(response.status, 200);
    assert.match(response.body.error, /提出処理に入っています \(status: submitted\)/);
    assert.deepEqual(await readTask(id), submitted);
    assert.deepEqual(await readJson(id, 'answer.json'), AI_DRAFT);
  });
});

test('a UI save keeps the other questions, the AI attribution data and the AI answer files', async () => {
  const id = 'abcdef0123456708';
  await withSaveServer(id, AI_DRAFT, async ({ put }) => {
    const claude = JSON.stringify({ provider: 'claude', answers: [{ question: 1, values: ['クロード'] }] });
    await saveText(id, 'answer-claude.json', claude);
    assert.equal((await put([{ question: 1, values: ['語'] }])).status, 200);

    const saved = await readJson(id, 'answer.json');
    assert.deepEqual(saved.providers, AI_DRAFT.providers);
    assert.equal(saved.notes, AI_DRAFT.notes);
    assert.deepEqual(saved.answers[0], { ...AI_DRAFT.answers[0], values: ['語'], source: 'user', conflict: false });
    assert.deepEqual(saved.answers[1], AI_DRAFT.answers[1]);
    assert.equal(await readFile(taskPath(id, 'answer-claude.json'), 'utf8'), claude);
    assert.equal((await readTask(id)).approval, null);
  });
});

test('a UI save that fails leaves answer.json and task.json as they were', async () => {
  const id = 'abcdef0123456709';
  await withSaveServer(id, AI_DRAFT, async ({ put }) => {
    const answerBefore = await readFile(taskPath(id, 'answer.json'), 'utf8');
    const taskBefore = await readFile(taskPath(id, 'task.json'), 'utf8');

    // Refused by validation: question 2 has no option 9.
    const invalid = await put([{ question: 1, values: ['語'] }, { question: 2, values: ['9'] }]);
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /設問2/);
    assert.equal(await readFile(taskPath(id, 'answer.json'), 'utf8'), answerBefore);
    assert.equal(await readFile(taskPath(id, 'task.json'), 'utf8'), taskBefore);

    // Writing fails: the temporary file answer.json is written through cannot be created.
    const blocker = `${taskPath(id, 'answer.json')}.${process.pid}.tmp`;
    await mkdir(blocker);
    const failed = await put([{ question: 1, values: ['語'] }]);
    assert.notEqual(failed.status, 200);
    assert.equal(await readFile(taskPath(id, 'answer.json'), 'utf8'), answerBefore);
    assert.equal(await readFile(taskPath(id, 'task.json'), 'utf8'), taskBefore);
    await rm(blocker, { recursive: true });

    // The failed saves released the task lock.
    assert.equal((await put([{ question: 1, values: ['語'] }])).status, 200);
    assert.deepEqual((await readJson(id, 'answer.json')).answers[0].values, ['語']);
  });
});

const TASK = 'abcdef0123456704';
const job = (startedAt, label, status, taskId = null) => ({
  action: taskId ? 'answer' : 'list', label, taskId, command: 'npm run task -- list --json', startedAt,
  finishedAt: status === 'running' ? null : startedAt, status, exitCode: status === 'running' ? null : 0,
  cancellable: true, lines: [],
});
const summary = (status) => taskSummary({ id: TASK, status, questions: [], item: { courseName: '授業', title: '第1回課題', deadlineAt: null } });
const stateBody = ({ tasks = [], job: current = null }) => ({ tasks, contents: null, job: current, attemptCategories: [], providers: ['claude', 'codex'], taskRoot: '' });

// The detail the real server sends for TASK, so the screen can draw it.
async function realDetail() {
  await saveTask(TASK, { id: TASK, status: 'answered', questions: parseQuestionForm(FORM), fingerprint: 'x', materials: [],
    item: { courseName: '授業', title: '第1回課題', deadlineAt: null } });
  const ui = createTaskServer({ token: 'test-token', port: 0 });
  await ui.listen();
  try {
    return await (await fetch(`http://127.0.0.1:${ui.server.address().port}/api/task/${TASK}?t=test-token`)).json();
  } finally {
    ui.server.close();
    await rm(taskDir(TASK), { recursive: true, force: true });
  }
}

// An answer whose headers go out at once and whose body follows when `body` settles, like a
// slow server's. (Chromium holds a second request for the same URL until the first one's
// headers have arrived, so a held answer without headers would serialize the requests.)
const later = (status, body) => ({ later: true, status, body });

// Serves the real task screen from a scripted server and drives it in Chromium.
//   events[i]  messages of the i-th /api/events connection (a job, or { type: 'log' }); with
//              `end` the connection closes and the browser reconnects after 20 ms.
//   state(n) / detail(n)  the n-th /api/state / /api/task/<id> answer: an object, an Error
//              (sent as HTTP 500 with its message) or later(...).
//   run(page, { counts, push, close })  push() sends messages on the newest open connection,
//              close() ends it.
async function runScriptedUi({ events = [], state, detail = () => new Error('no detail'), launch = () => chromium.launch({ headless: true }), onListen = () => {}, run }) {
  const html = await readFile(new URL('../src/ui/task-ui.html', import.meta.url), 'utf8');
  const open = [];
  const counts = { state: 0, detail: 0, events: 0 };
  const write = (response, messages) => {
    for (const message of messages) {
      const event = message?.type === 'log' ? message : { type: 'job', job: message };
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  const json = (value) => JSON.stringify(value instanceof Error ? { error: value.message } : value);
  const answer = async (response, reply) => {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    if (reply?.later) {
      response.writeHead(reply.status, headers);
      response.flushHeaders();
      response.end(json(await reply.body));
      return;
    }
    response.writeHead(reply instanceof Error ? 500 : 200, headers);
    response.end(json(reply));
  };
  const server = createServer((req, response) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(html);
    }
    if (path === '/api/state') return answer(response, state(counts.state++));
    if (path.startsWith('/api/task/')) return answer(response, detail(counts.detail++));
    if (path === '/api/events') {
      const script = events[counts.events++] ?? { jobs: [] };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.write('retry: 20\n\n');
      write(response, script.jobs);
      if (script.end) response.end();
      else open.push(response);
      return undefined;
    }
    return response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // Everything after listen() is undone in `finally`, a failed Chromium start included;
  // otherwise the listening server keeps the test process from ever exiting.
  let browser = null;
  try {
    onListen(server);
    browser = await launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/?t=x`);
    return await run(page, {
      counts,
      push: (...messages) => write(open.at(-1), messages),
      close: () => open.pop().end(),
    });
  } finally {
    await browser?.close().catch(() => undefined);
    for (const response of open) response.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const toastShows = (page, text) => page.waitForFunction((wanted) => document.getElementById('toast').textContent.includes(wanted), text, { timeout: 10000 });
const listShows = (page, text) => page.waitForFunction((wanted) => document.getElementById('list').textContent.includes(wanted), text, { timeout: 10000 });

test('a job that ends while the event stream reconnects is applied once, an old one never', { timeout: 30000 }, async () => {
  const old = job('2026-10-06T00:00:00.000Z', '古い操作', 'done');
  const missed = '2026-10-06T00:01:00.000Z';
  const live = '2026-10-06T00:02:00.000Z';
  await runScriptedUi({
    events: [
      // Page load and the first reconnect both repeat a job that ended before the page opened.
      { jobs: [old], end: true },
      { jobs: [old], end: true },
      // Seen running, then the connection drops and the job ends before the reconnect.
      { jobs: [job(missed, '切断中の操作', 'running')], end: true },
      { jobs: [job(missed, '切断中の操作', 'done')], end: true },
      // Running and done on one connection, as before.
      { jobs: [job(live, '最後の操作', 'running'), job(live, '最後の操作', 'done')] },
    ],
    // The server reads the job before the tasks, so the old job's end is in the first state.
    state: () => stateBody({ job: old }),
    run: async (page, { counts }) => {
      await toastShows(page, '「最後の操作」が終わりました');
      assert.equal(counts.events, 5);
      // The initial load, then one refresh each for the missed and the live job; none for the old one.
      assert.equal(counts.state, 3);
    },
  });
});

test('a job end announced before the first state answer still reaches the screen', { timeout: 30000 }, async () => {
  const done = job('2026-10-06T00:00:00.000Z', '解答を作成', 'done');
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  await runScriptedUi({
    // The job ends after the first /api/state was read but before its answer arrives.
    events: [{ jobs: [done] }],
    state: (n) => (n === 0
      ? later(200, firstHeld.then(() => stateBody({ tasks: [summary('fetched')], job: { ...done, status: 'running', finishedAt: null } })))
      : stateBody({ tasks: [summary('answered')], job: done })),
    run: async (page, { counts }) => {
      await page.waitForFunction(() => document.getElementById('logIcon').textContent === '✅', null, { timeout: 10000 });
      releaseFirst();
      await listShows(page, '解答済');
      assert.equal(counts.state, 2);
    },
  });
});

test('a job end after the first state answer is applied from the latest state', { timeout: 30000 }, async () => {
  const startedAt = '2026-10-06T00:00:00.000Z';
  await runScriptedUi({
    events: [{ jobs: [job(startedAt, '解答を作成', 'running')] }],
    state: (n) => (n === 0
      ? stateBody({ tasks: [summary('fetched')], job: job(startedAt, '解答を作成', 'running') })
      : stateBody({ tasks: [summary('answered')], job: job(startedAt, '解答を作成', 'done') })),
    run: async (page, { counts, push }) => {
      await listShows(page, '取得済');
      push(job(startedAt, '解答を作成', 'done'));
      await listShows(page, '解答済');
      await toastShows(page, '「解答を作成」が終わりました');
      assert.equal(counts.state, 2);
    },
  });
});

test('an older state answer never replaces a newer one on screen', { timeout: 30000 }, async () => {
  const first = '2026-10-06T00:00:00.000Z';
  const second = '2026-10-06T00:01:00.000Z';
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  await runScriptedUi({
    events: [{ jobs: [job(first, '一つ目', 'running')] }],
    state: (n) => [
      stateBody({ tasks: [summary('fetched')], job: job(first, '一つ目', 'running') }),
      // The refresh for the first job's end answers last, with what was true back then.
      later(200, slow.then(() => stateBody({ tasks: [summary('fetched')], job: job(first, '一つ目', 'done') }))),
    ][n] ?? stateBody({ tasks: [summary('answered')], job: job(second, '二つ目', 'done') }),
    run: async (page, { push }) => {
      await listShows(page, '取得済');
      push(job(first, '一つ目', 'done'), job(second, '二つ目', 'running'), job(second, '二つ目', 'done'));
      await listShows(page, '解答済');
      releaseSlow();
      await toastShows(page, '「一つ目」が終わりました');
      assert.match(await page.locator('#list').textContent(), /解答済/);
    },
  });
});

test('a job end whose results could not be loaded is loaded again on reconnect, then never again', { timeout: 30000 }, async () => {
  const startedAt = '2026-10-06T00:00:00.000Z';
  const running = job(startedAt, '解答を作成', 'running', TASK);
  const done = job(startedAt, '解答を作成', 'done', TASK);
  const next = '2026-10-06T00:05:00.000Z';
  const shown = await realDetail();
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  await runScriptedUi({
    events: [
      { jobs: [running] },
      { jobs: [done] },
      { jobs: [done] },
    ],
    state: (n) => [
      stateBody({ tasks: [summary('fetched')], job: running }),
      later(500, firstHeld.then(() => new Error('state-down'))),
    ][n] ?? stateBody({ tasks: [summary('answered')], job: done }),
    detail: (n) => (n === 0 ? new Error('detail-down') : shown),
    run: async (page, { counts, push, close }) => {
      // Repeats of a job end that is being loaded load nothing more.
      await listShows(page, '取得済');
      push(done, done, done, { type: 'log', line: 'three-dones-sent' });
      await page.waitForFunction(() => document.getElementById('logBody').textContent.includes('three-dones-sent'), null, { timeout: 10000 });
      releaseFirst();
      await toastShows(page, 'state-down');
      assert.deepEqual([counts.state, counts.detail], [2, 0]);
      // Not applied, so the repeat sent on reconnecting loads it again: the state now, not the task.
      close();
      await toastShows(page, '課題の詳細を読み込めませんでした');
      assert.deepEqual([counts.state, counts.detail], [3, 1]);
      close();
      await toastShows(page, '「解答を作成」が終わりました');
      assert.deepEqual([counts.state, counts.detail], [4, 2]);
      assert.match(await page.locator('#list').textContent(), /解答済/);
      // Applied: the same end again loads nothing; the next job is applied as usual.
      push(done, job(next, '最後の操作', 'running'), job(next, '最後の操作', 'done'));
      await toastShows(page, '「最後の操作」が終わりました');
      assert.deepEqual([counts.state, counts.detail], [5, 3]);
    },
  });
});

test('the scripted UI closes its server even when Chromium cannot start', async () => {
  let server = null;
  await assert.rejects(runScriptedUi({
    state: () => stateBody({}),
    launch: async () => { throw new Error("browserType.launch: Executable doesn't exist"); },
    onListen: (listening) => { server = listening; },
    run: async () => assert.fail('the page is never opened'),
  }), /Executable doesn't exist/);
  assert.equal(server.listening, false);
});

function statusWithHost(port, path, host) {
  return new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, path, headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    call.on('error', reject);
    call.end();
  });
}
