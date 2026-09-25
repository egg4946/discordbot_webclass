import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { parseQuestionForm } from '../src/task-questions.js';
import { saveJson, saveTask, saveText, taskDir } from '../src/task-store.js';
import { applyAnswerEdits, assertNoRunningJob, commandArgs, createTaskServer, parseListJson, resolveTaskAsset, taskSummary } from '../src/task-server.js';

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
  await saveTask(id, { id, status: 'answered', questions: [question], fingerprint: 'x', materials: [],
    item: { courseName: '授業', title: '課題', deadlineAt: null } });
  await saveText(id, 'report-q1.md', '古い本文');
  const ui = createTaskServer({ token: 'test-token', port: 0 });
  await ui.listen();
  try {
    const response = await fetch(`http://127.0.0.1:${ui.server.address().port}/api/task/${id}/report/1?t=test-token`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown: '新しい本文' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).questions[0].report.markdown, '新しい本文');
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
