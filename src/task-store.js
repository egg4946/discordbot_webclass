import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeJsonFile } from './json-file.js';
import { acquireRunLock } from './run-lock.js';

// Task data contains assignment text and answers, so it lives under the Git-ignored data/.
export const TASK_ROOT = resolve('data/tasks');

export function taskId(contentsId) {
  return createHash('sha256').update(String(contentsId)).digest('hex').slice(0, 16);
}

export function taskDir(id) {
  if (!/^[a-f0-9]{16}$/.test(id ?? '')) throw new Error(`Invalid task ID: ${id}`);
  return join(TASK_ROOT, id);
}

export function taskPath(id, name) {
  return join(taskDir(id), name);
}

// Once a submission has been attempted, the task must not silently go back to a state that
// allows another one: `submit` refuses these statuses, so anything that rewrites task.json
// has to refuse them too (or, for `fetch`, be asked for explicitly).
export const FINISHED_STATUSES = ['submitting', 'submitted', 'unverified'];

export async function readTask(id) {
  return readJson(id, 'task.json');
}

export async function readSubmittedTask(id) {
  const task = await readTask(id).catch(() => null);
  return task && FINISHED_STATUSES.includes(task.status) ? task : null;
}

// Guards every command that would reset a task to an answerable state.
export async function assertNotSubmitted(id, what) {
  const task = await readSubmittedTask(id);
  if (task) {
    throw new Error(`この課題は既に提出処理に入っています (status: ${task.status})。${what}`);
  }
}

// One lock per task, across processes (the UI's jobs and the CLI). submit and fetch hold it for
// their whole run: both open the task on WebClass and both write task.json from what they read
// at the start. Commands that turn the task back into a draft hold it while they write.
export async function withTaskLock(id, run) {
  const release = await acquireRunLock(taskPath(id, 'task.lock'));
  if (!release) {
    throw new Error('この課題では提出・取得などの処理が既に実行中です。終わってからやり直してください。');
  }
  try {
    return await run();
  } finally {
    await release();
  }
}

// The writes of a command that makes the task a draft again. The submission check is repeated
// under the lock, so a submission that finished while the command ran (an AI run takes minutes)
// is never undone.
export async function writeUnsubmitted(id, what, write) {
  return withTaskLock(id, async () => {
    await assertNotSubmitted(id, what);
    return write();
  });
}

export async function saveTask(id, value) {
  await writeJsonFile(taskPath(id, 'task.json'), value);
}

export async function updateTask(id, changes) {
  const task = await readTask(id);
  const next = { ...task, ...changes, updatedAt: new Date().toISOString() };
  await saveTask(id, next);
  return next;
}

export async function readJson(id, name) {
  return JSON.parse(await readFile(taskPath(id, name), 'utf8'));
}

export async function saveJson(id, name, value) {
  await writeJsonFile(taskPath(id, name), value);
}

export async function saveText(id, name, value) {
  const path = taskPath(id, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
  return path;
}

export async function readText(id, name) {
  return readFile(taskPath(id, name), 'utf8');
}

// The approval hash covers what will be typed into WebClass, plus the contents of every
// file that will be uploaded (`files`: "<設問番号>:<相対パス>" -> ファイルのハッシュ).
export function answerDigest(answers, files = {}) {
  const canonical = answers
    .map(({ question, values }) => ({ question: Number(question), values: values.map(String) }))
    .sort((left, right) => left.question - right.question);
  const fileEntries = Object.keys(files).sort().map((key) => [key, files[key]]);
  return createHash('sha256').update(JSON.stringify({ answers: canonical, files: fileEntries })).digest('hex');
}
