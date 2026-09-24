import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { generateAnswers, isReportQuestion, PROVIDERS } from './task-answer.js';
import { describeValues, sameValues } from './task-questions.js';
import { readJson, readTask, readText, saveJson, taskDir, taskPath, updateTask } from './task-store.js';

// Files of one submission. Screenshots and the receipt are moved so the next submission's
// files are not mistaken for them; the answers are copied because the retry starts from them.
const MOVED = /^(submission-receipt\.txt|after-submit\.png|before-submit(-p\d+)?\.png|dry-run(-p\d+)?\.png|review\.md)$/;
const COPIED = /^(answer(-[a-z]+)?\.json|report-q\d+\.(md|pdf))$/;

// Reads WebClass's grade table (reslt_menu.php) from submission-receipt.txt:
//   問	解答	結果	得点/配点	解説	出題分野	コメント
//   4	7, 9	×	0/2
export function parseGradeResults(receipt) {
  const lines = String(receipt ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^問\t解答\t結果\t得点\/配点/.test(line));
  if (start < 0) return [];
  const results = [];
  for (const line of lines.slice(start + 1)) {
    if (/成績を閉じる/.test(line) || line.startsWith('[http')) break;
    const [number, answer, mark, score] = line.split('\t');
    const points = score?.match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/);
    if (!/^\d+$/.test(number ?? '') || !points) continue;
    results.push({
      question: Number(number),
      answer: (answer ?? '').trim(),
      mark: (mark ?? '').trim(),
      score: Number(points[1]),
      max: Number(points[2]),
    });
  }
  return results;
}

export function wrongQuestions(results) {
  return results.filter((result) => result.score < result.max).map((result) => result.question);
}

// Starts another attempt of a submitted task: the questions WebClass marked wrong (or the ones
// given) are answered again, and the ones marked right keep the submitted answer. The previous
// submission is archived under attempts/<n>/ and the task goes back to `answered`, so it goes
// through review → approve → submit like any other draft.
export async function retryTask(id, { providers = PROVIDERS, questions = [], prefer } = {}) {
  const task = await readTask(id);
  // A retry whose solvers failed (or that the user wants solved again) is still a draft: the
  // solvers run again on the same questions, and nothing is archived twice.
  if (task.retry && ['answered', 'approved', 'fetched'].includes(task.status)) {
    return { ...await solveRetry(id, task, { providers, prefer, questions }), resumed: true };
  }
  if (!['submitted', 'unverified'].includes(task.status)) {
    throw new Error(`解き直せるのは提出済みの課題だけです (status: ${task.status})。`
      + (task.status === 'submitting' ? ' 提出中のまま止まっています。WebClassで結果を確認してください。' : ''));
  }
  if (task.item?.deadlineAt && Date.now() > new Date(task.item.deadlineAt).getTime()) {
    throw new Error('提出期限を過ぎているため、再提出できません。');
  }
  const receipt = await readText(id, 'submission-receipt.txt').catch(() => '');
  const results = parseGradeResults(receipt);
  const numbers = task.questions.map((question) => question.number);
  const requested = questions.map(Number);
  const unknown = requested.filter((number) => !numbers.includes(number));
  if (unknown.length) throw new Error(`存在しない設問です: ${unknown.join(', ')}`);
  if (!results.length && !requested.length) {
    throw new Error('提出結果（submission-receipt.txt）に採点表がないため、間違えた設問が分かりません。'
      + 'WebClassで結果を確認し、解き直す設問番号を指定してください（例: retry <task-id> both 2 4）。');
  }
  const targets = requested.length ? requested : wrongQuestions(results);
  if (targets.length === 0) throw new Error('採点結果はすべて満点です。解き直す設問はありません。');

  const draft = await readJson(id, 'answer.json');
  const previous = targets.map((number) => {
    const question = task.questions.find((item) => item.number === number);
    const values = draft.answers.find((answer) => Number(answer.question) === number)?.values ?? [];
    const grade = results.find((result) => result.question === number) ?? null;
    return { question: number, values, describe: describeValues(question, values), grade };
  });

  const attempt = (task.attempts?.length ?? 0) + 1;
  await archiveAttempt(id, attempt);
  await updateTask(id, {
    status: 'answered',
    approval: null,
    submittedAt: null,
    submissionAttemptedAt: null,
    attempts: [...(task.attempts ?? []), {
      number: attempt,
      status: task.status,
      submittedAt: task.submittedAt ?? null,
      submissionAttemptedAt: task.submissionAttemptedAt ?? null,
      approval: task.approval ?? null,
      results,
      folder: `attempts/${attempt}`,
    }],
    retry: { attempt: attempt + 1, questions: previous.map(({ question, values, describe, grade }) => ({ question, values, describe, grade })) },
  });

  // The solvers' answers to the retried questions were just marked wrong (copies stay in the
  // archive); leaving them would show a failed solver's old answer as if it were a new one.
  for (const provider of PROVIDERS) {
    const solved = await readJson(id, `answer-${provider}.json`).catch(() => null);
    if (!solved) continue;
    const keep = (item) => !targets.includes(Number(item.question));
    await saveJson(id, `answer-${provider}.json`, {
      ...solved, answers: (solved.answers ?? []).filter(keep), reports: (solved.reports ?? []).filter(keep),
    });
  }

  // Until a solver answers, the retried questions are flagged, so a failed run can never be
  // approved with the answer that was just marked wrong without the review saying so.
  await saveJson(id, 'answer.json', {
    ...draft,
    answers: draft.answers.map((answer) => {
      if (targets.includes(Number(answer.question))) return { ...answer, source: 'wrong', conflict: true };
      const full = results.some((result) => result.question === Number(answer.question) && result.score >= result.max);
      return { ...answer, source: full ? 'correct' : answer.source };
    }),
  });

  return { ...await solveRetry(id, await readTask(id), { providers, prefer }), resumed: false };
}

async function solveRetry(id, task, { providers, prefer, questions = [] }) {
  const results = task.attempts?.at(-1)?.results ?? [];
  const requested = questions.map(Number);
  const extra = requested.filter((number) => !task.retry.questions.some((item) => item.question === number));
  if (extra.length) {
    throw new Error(`設問${extra.join(', ')} は今回の解き直しの対象ではありません（対象: ${task.retry.questions.map((item) => item.question).join(', ')}）。`);
  }
  const previous = task.retry.questions.filter((item) => !requested.length || requested.includes(item.question));
  const targets = previous.map((item) => item.question);
  const { results: solverResults, draft: next } = await generateAnswers(id, providers, {
    prefer,
    only: targets,
    guidance: retryGuidance(previous, results, targets),
  });

  // An answer identical to the one WebClass just marked wrong cannot score full marks.
  const repeated = [];
  for (const answer of next.answers) {
    const before = previous.find((item) => item.question === Number(answer.question));
    const question = task.questions.find((item) => item.number === Number(answer.question));
    if (before && !isReportQuestion(question) && sameValues(question, answer.values, before.values)) {
      Object.assign(answer, { conflict: true, repeated: true });
      repeated.push(before.question);
    }
  }
  if (repeated.length) {
    await saveJson(id, 'answer.json', next);
    await updateTask(id, { status: 'answered', approval: null });
  }
  return { attempt: task.retry.attempt, targets, previous, results: solverResults, draft: next, repeated };
}

export function retryGuidance(previous, results, targets) {
  const correct = results.filter((result) => result.score >= result.max).map((result) => `設問${result.question}`);
  const lines = [
    '## 前回の提出結果（WebClassで採点済み）',
    'この課題は一度提出し、次の設問が不正解または部分点でした。前回の解答は誤りを含むので、そのまま繰り返さず、',
    '資料と設問文を読み直して、どこが誤っていたかを考えてから解き直してください。',
    '複数選択・プルダウンで部分点の場合は、選択の一部だけが誤っている（多すぎる・足りない）可能性があります。',
    '',
    ...previous.map(({ question, describe, grade }) => [
      `### 設問${question}${grade ? `（${grade.mark || '採点'} ${grade.score}/${grade.max}点）` : '（本人が誤りと判断）'}`,
      '前回の解答:',
      describe.split('\n').map((line) => `  ${line}`).join('\n'),
    ].join('\n')),
    '',
    correct.length ? `正解だった設問（解き直し不要）: ${correct.join(', ')}` : '',
    `今回は ${targets.map((number) => `設問${number}`).join(', ')} だけに答えてください。answers と reports にはそれ以外の設問を含めないでください。`,
    'evidence には、前回の解答のどこが誤りだったと考えたかも書いてください。',
  ];
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n');
}

async function archiveAttempt(id, attempt) {
  const folder = taskPath(id, join('attempts', String(attempt)));
  if (existsSync(folder)) throw new Error(`attempts/${attempt} が既にあります。手で確認してください。`);
  await mkdir(folder, { recursive: true });
  for (const name of await readdir(taskDir(id))) {
    if (MOVED.test(name)) await rename(taskPath(id, name), join(folder, name));
    else if (COPIED.test(name)) await copyFile(taskPath(id, name), join(folder, name));
  }
}
