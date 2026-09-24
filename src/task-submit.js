import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { describeValues, questionFingerprint, validateAnswers } from './task-questions.js';
import { acceptPageLeave, formatDeadline, openQuestionForm } from './task-fetch.js';
import { answerDigest, FINISHED_STATUSES, readJson, readTask, readText, saveText, taskDir, taskPath, updateTask } from './task-store.js';
import { isReportQuestion, PROVIDERS } from './task-answer.js';
import { reportFiles } from './task-report.js';
import { openWebclassSession } from './webclass.js';
import { gotoTestPage, readPageInputs, restorePageInputs } from './task-paged.js';

// Builds review.md: every question with the draft answer, both AIs' answers and
// their evidence, plus the hash that approval must quote.
export async function reviewTask(id) {
  const task = await readTask(id);
  const draft = await readJson(id, 'answer.json');
  const answers = validateAnswers(task.questions, draft.answers);
  const digest = answerDigest(answers, await fileDigests(id, task, answers));
  const solverResults = {};
  for (const provider of PROVIDERS) {
    solverResults[provider] = await readJson(id, `answer-${provider}.json`).catch(() => null);
  }

  const conflicts = draft.answers.filter((answer) => answer.conflict).map((answer) => answer.question);
  const lines = [
    `# ${task.item.courseName} / ${task.item.title}`,
    '',
    `- 期限: ${formatDeadline(task.item.deadlineAt)}`,
    `- 使用したAI: ${draft.providers?.join(', ') || '手動'}`,
    `- AIの案が一致しなかった設問（レポートは本文を読み比べてください）: ${conflicts.length ? conflicts.map((number) => `設問${number}`).join(', ') : 'なし'}`,
    `- 承認用ハッシュ: \`${digest.slice(0, 16)}\``,
    '',
    '一致していても正解とは限りません。資料と照らして確認してください。',
    '',
  ];
  for (const question of task.questions) {
    const answer = answers.find((item) => item.question === question.number);
    const meta = draft.answers.find((item) => item.question === question.number);
    lines.push(`## 設問${question.number}${meta?.conflict ? ' ⚠ AIの案が一致していません' : ''}`, '', question.text, '');
    lines.push('**提出する解答**', '', indent(describeValues(question, answer.values)), '');
    if (isReportQuestion(question)) {
      const body = await readText(id, reportFiles(question.number).markdown).catch(() => '');
      if (body.trim()) {
        lines.push(`**提出するレポート本文**（${reportFiles(question.number).markdown} を直すと render でPDFを作り直せます）`,
          '', '⚠ 本人の経験・意見にあたる部分は、AIが一般的な場合を仮定して書いています。自分に当てはまるか確認してください。',
          '', indent(body.trim()), '');
      }
    }
    for (const provider of PROVIDERS) {
      const result = solverResults[provider];
      const own = result?.answers.find((item) => item.question === question.number);
      const report = result?.reports?.find((item) => item.question === question.number);
      if (!own && !report) continue;
      const { model, effort } = result;
      const modelLabel = model ? ` ${model}${effort ? `/${effort}` : ''}` : '';
      const body = report ? report.markdown.trim() : describeValues(question, own.values);
      lines.push(`<details><summary>${provider}${modelLabel}（確信度: ${(report ?? own).confidence ?? '-'}）</summary>`, '',
        indent(body), '', `根拠: ${(report ?? own).evidence ?? ''}`, '', '</details>', '');
    }
  }
  if (draft.notes) lines.push('## AIのメモ', '', draft.notes, '');
  const markdown = lines.join('\n');
  await saveText(id, 'review.md', markdown);
  return { task, draft, answers, digest, conflicts, markdown, path: taskPath(id, 'review.md') };
}

export async function approveTask(id, digestPrefix) {
  const { task, digest } = await reviewTask(id);
  if (!digestPrefix || digestPrefix.length < 12 || !digest.startsWith(digestPrefix)) {
    throw new Error('承認用ハッシュが一致しません。review で最新のハッシュを確認してください。');
  }
  if (FINISHED_STATUSES.includes(task.status)) {
    throw new Error(`この課題は既に提出処理に入っています (status: ${task.status})。`);
  }
  await updateTask(id, { status: 'approved', approval: { digest, at: new Date().toISOString() } });
  return { digest };
}

// dryRun fills the form and takes a screenshot but never presses 採点, and leaving
// the page without grading does not save the entered values.
export async function submitTask(config, id, { dryRun = false, allowAttempt = false } = {}) {
  const task = await readTask(id);
  const draft = await readJson(id, 'answer.json');
  const answers = validateAnswers(task.questions, draft.answers);
  const digest = answerDigest(answers, await fileDigests(id, task, answers));
  if (!dryRun) {
    if (task.status !== 'approved' || task.approval?.digest !== digest) {
      throw new Error('現在の answer.json は承認されていません（提出するファイルの中身も含めて確認します）。review → approve を先に行ってください。');
    }
  }
  if (FINISHED_STATUSES.includes(task.status)) {
    throw new Error(`この課題は既に提出処理に入っています (status: ${task.status})。結果を確認してください。`);
  }
  if (task.item.deadlineAt && Date.now() > new Date(task.item.deadlineAt).getTime()) {
    throw new Error('提出期限を過ぎています。');
  }

  const { browser, page } = await openWebclassSession(config);
  acceptPageLeave(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  try {
    const { layout, frame, questions } = await openQuestionForm(page, task.item, { allowAttempt });
    if (questionFingerprint(questions) !== task.fingerprint) {
      throw new Error('取得時から設問が変わっています。fetch からやり直してください。');
    }

    let gradeFrame;
    if (layout === 'paged') {
      const result = await fillPagedTest(page, id, task, answers, dryRun);
      if (dryRun) return { dryRun: true, screenshot: result.screenshots.join('\n') };
      gradeFrame = result.frame;
    } else {
      // Uploading a file submits the form, so files go first and the page is re-read afterwards.
      const afterUpload = await uploadFiles(page, id, task, answers, dryRun, {
        frame,
        questions: task.questions.filter((question) => question.kind === 'file'),
        reload: async () => {
          const reloaded = page.frames().find((candidate) => candidate.url().includes('dqstn_answer_all.php'));
          await reloaded?.waitForLoadState('domcontentloaded').catch(() => undefined);
          return reloaded;
        },
      });
      await fillAnswers(afterUpload, task.questions, answers);
      const mismatches = await verifyFilled(afterUpload, task.questions, answers);
      if (mismatches.length) {
        throw new Error(`入力内容を確認できませんでした: ${mismatches.join(', ')}`);
      }
      const form = afterUpload.locator('form[name="answer_form"]');
      const beforePath = taskPath(id, dryRun ? 'dry-run.png' : 'before-submit.png');
      await captureForm(page, frame, form, beforePath);
      if (dryRun) {
        return { dryRun: true, screenshot: beforePath };
      }
      gradeFrame = afterUpload;
    }

    // From here the submission may reach WebClass, so a failure must not be retried blindly.
    await updateTask(id, { status: 'submitting', submissionAttemptedAt: new Date().toISOString() });
    const dialogs = [];
    page.on('dialog', (dialog) => {
      if (dialog.type() === 'beforeunload') return;
      dialogs.push(`${dialog.type()}: ${dialog.message()}`);
      dialog.accept().catch(() => undefined);
    });
    await gradeFrame.locator('#GradeBtn').click();
    await page.waitForTimeout(6000);

    const texts = [];
    for (const current of page.frames()) {
      const text = await current.locator('body').innerText().catch(() => '');
      if (text.trim()) texts.push(`[${current.url().split('?')[0]}]\n${text.trim()}`);
    }
    const receipt = [...dialogs.map((line) => `[dialog] ${line}`), ...texts].join('\n\n');
    await saveText(id, 'submission-receipt.txt', receipt);
    const afterPath = taskPath(id, 'after-submit.png');
    await page.screenshot({ path: afterPath, fullPage: true }).catch(() => undefined);
    const stillOnForm = page.frames().some((current) => current.url().includes('dqstn_answer_all.php'))
      || (layout === 'paged' && await anyFrameHas(page, '#GradeBtn'));
    const verified = !stillOnForm && /(得点|点数|採点結果|成績|解答結果|正解|結果)/.test(receipt);
    await updateTask(id, {
      status: verified ? 'submitted' : 'unverified',
      submittedAt: verified ? new Date().toISOString() : null,
    });
    return { dryRun: false, verified, receipt: taskPath(id, 'submission-receipt.txt'), screenshot: afterPath };
  } finally {
    await browser.close();
  }
}

// Paged tests: WebClass saves a page whenever another page is opened, but grades only on 終了.
// Each page is filled, read back and captured. A dry run puts the page's previous values back
// before moving on, so it leaves WebClass as it was. A real submission then visits every page
// again and compares what WebClass saved with the approved answers before 終了 is pressed.
async function fillPagedTest(page, id, task, answers, dryRun) {
  const pageNumbers = [...new Set(task.questions.map((question) => question.page))].sort((a, b) => a - b);
  const onPage = (number) => task.questions.filter((question) => question.page === number);
  const screenshots = [];
  for (const number of pageNumbers) {
    let { frame } = await gotoTestPage(page, number);
    const fileQuestions = onPage(number).filter((question) => question.kind === 'file');
    // Files are uploaded first: WebClass stores them as soon as レポートを提出 is pressed,
    // which reloads this page, so the remaining inputs are filled into the fresh frame.
    const previous = dryRun ? await readPageInputs(frame) : null;
    frame = await uploadFiles(page, id, task, answers, dryRun, {
      frame,
      questions: fileQuestions,
      reload: async () => (await gotoTestPage(page, number)).frame,
    });
    await fillAnswers(frame, onPage(number), answers);
    const mismatches = await verifyFilled(frame, onPage(number), answers);
    if (mismatches.length) {
      throw new Error(`ページ${number}の入力内容を確認できませんでした: ${mismatches.join(', ')}。採点はしていません。`);
    }
    const path = taskPath(id, `${dryRun ? 'dry-run' : 'before-submit'}-p${number}.png`);
    await page.screenshot({ path }).catch(() => undefined);
    screenshots.push(path);
    if (dryRun) await restorePageInputs(frame, previous);
  }
  if (dryRun) return { screenshots };

  let frame;
  for (const number of pageNumbers) {
    ({ frame } = await gotoTestPage(page, number));
    const mismatches = await verifyFilled(frame, onPage(number), answers);
    if (mismatches.length) {
      throw new Error(`WebClassに保存された解答が承認した内容と違います: ${mismatches.join(', ')}。採点はしていません。`);
    }
    for (const question of onPage(number).filter((item) => item.kind === 'file')) {
      const paths = answers.find((answer) => answer.question === question.number).values.map((value) => resolveTaskFile(id, value));
      await verifyUploaded(frame, question, paths);
    }
  }
  return { frame, screenshots };
}

async function anyFrameHas(page, selector) {
  for (const frame of page.frames()) {
    if (await frame.locator(selector).count().catch(() => 0)) return true;
  }
  return false;
}

// Selecting a file in WebClass uploads it immediately, so dry runs only check that the
// files exist, and a real submission marks the task as submitting before touching them.
// `reload` returns the answer frame again after WebClass reloaded it, which differs between
// the one-page form (dqstn_answer_all.php) and a page of a paged test (dqstn_answer.php).
async function uploadFiles(page, id, task, answers, dryRun, { frame, questions, reload }) {
  if (questions.length === 0) return frame;

  const plans = questions.map((question) => ({
    question,
    paths: answers.find((answer) => answer.question === question.number).values.map((value) => resolveTaskFile(id, value)),
  }));
  for (const { question, paths } of plans) {
    for (const path of paths) {
      if (!existsSync(path)) throw new Error(`設問${question.number}のファイルが見つかりません: ${path}`);
    }
  }
  if (dryRun) return frame;

  await updateTask(id, { status: 'submitting', submissionAttemptedAt: new Date().toISOString() });
  let current = frame;
  for (const { question, paths } of plans) {
    const before = await uploadedText(current, question);
    const fieldset = current.locator(`#QF_${question.field ?? question.number}`);
    const inputs = fieldset.locator('input[type="file"]');
    for (const [index, path] of paths.entries()) {
      await inputs.nth(index).setInputFiles(path);
      await waitForUploads(current);
    }
    const sendButton = fieldset.locator('[onclick*="sendReport"], input[type="submit"][value*="提出"], button:has-text("提出")').first();
    if (await sendButton.isVisible().catch(() => false)) {
      page.once('dialog', (dialog) => dialog.accept().catch(() => undefined));
      await sendButton.click();
      await page.waitForTimeout(3000);
      current = await reload();
      if (!current) throw new Error(`設問${question.number}のファイル送信後に問題画面へ戻れませんでした。WebClassで状態を確認してください。`);
    }
    await verifyUploaded(current, question, paths, before);
  }
  return current;
}

export async function uploadedText(frame, question) {
  return normalizeText(await frame.locator(`#QF_${question.field ?? question.number}`).innerText().catch(() => ''));
}

// WebClass shows 提出済 and the stored file name once a report has been received. The name may
// differ from ours, so 提出済 alone is accepted, but only if this upload changed the question:
// `before` is its text before the upload, and a 提出済 left from an earlier submission (or an
// upload that never happened) leaves it unchanged. Without `before` (re-checking a page after
// this run's uploads) the stored state is only checked.
export async function verifyUploaded(frame, question, paths, before = null) {
  const uploaded = await uploadedText(frame, question);
  const names = paths.map((path) => basename(path));
  if (!/提出済/.test(uploaded) && !names.every((name) => uploaded.includes(name))) {
    throw new Error(`設問${question.number}のファイルがアップロードされたことを確認できませんでした。WebClassで状態を確認してください。`);
  }
  if (before !== null && uploaded === before) {
    throw new Error(`設問${question.number}の表示がアップロード前と変わっていないため、今回のファイルが受け付けられたか確認できませんでした。`
      + '採点はしていません。WebClassで状態を確認してください。');
  }
}

async function waitForUploads(frame, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  await frame.page().waitForTimeout(500);
  while (Date.now() < until) {
    const uploading = await frame.evaluate(() => Boolean(window.QuestionClient?.isFileUploading?.())).catch(() => false);
    if (!uploading) return;
    await frame.page().waitForTimeout(1000);
  }
  throw new Error('ファイルのアップロードが終わりませんでした。');
}

// The approval must cover the file that will be uploaded, not just its path, so the
// bytes of every submitted file go into the hash as well.
async function fileDigests(id, task, answers) {
  const digests = {};
  for (const question of task.questions.filter((item) => item.kind === 'file')) {
    const answer = answers.find((item) => item.question === question.number);
    for (const value of answer?.values ?? []) {
      const path = resolveTaskFile(id, value);
      digests[`${question.number}:${value}`] = existsSync(path)
        ? createHash('sha256').update(await readFile(path)).digest('hex')
        : 'missing';
    }
  }
  return digests;
}

function resolveTaskFile(id, value) {
  const root = taskDir(id);
  const path = resolve(root, value);
  if (!path.startsWith(root + sep)) throw new Error(`ファイルは課題フォルダ内を指定してください: ${value}`);
  return path;
}

async function fillAnswers(frame, questions, answers) {
  for (const question of questions) {
    const { values } = answers.find((answer) => answer.question === question.number);
    const fieldset = frame.locator(`#QF_${question.field ?? question.number}`);
    if (question.kind === 'checkbox') {
      for (const option of question.options) {
        await fieldset.locator(`input[type="checkbox"][value="${option.value}"]`).setChecked(values.includes(option.value));
      }
    } else if (question.kind === 'radio') {
      await fieldset.locator(`input[type="radio"][value="${values[0]}"]`).check();
    } else if (question.kind === 'select') {
      const selects = fieldset.locator('select');
      for (const [index, value] of values.entries()) await selects.nth(index).selectOption(value);
    } else if (question.kind === 'textarea') {
      const inputs = fieldset.locator('textarea');
      for (const [index, value] of values.entries()) await inputs.nth(index).fill(value);
    } else if (question.kind === 'text') {
      const inputs = fieldset.locator('input[type="text"]');
      for (const [index, value] of values.entries()) await inputs.nth(index).fill(value);
    }
  }
}

// Reads every question's inputs back so a wrong selector can never submit an unintended answer.
async function verifyFilled(frame, questions, answers) {
  const mismatches = [];
  for (const question of questions) {
    if (question.kind === 'file') continue;
    const expected = answers.find((answer) => answer.question === question.number).values;
    const actual = await frame.locator(`#QF_${question.field ?? question.number}`).evaluate((fieldset, kind) => {
      if (kind === 'checkbox' || kind === 'radio') {
        return [...fieldset.querySelectorAll(`input[type="${kind}"]`)].filter((input) => input.checked).map((input) => input.value);
      }
      const selector = { select: 'select', textarea: 'textarea', text: 'input[type="text"]' }[kind];
      return [...fieldset.querySelectorAll(selector)].map((input) => input.value);
    }, question.kind);
    const normalize = (list) => (question.kind === 'checkbox' ? [...list].sort() : list)
      .map((value) => String(value).replace(/\r\n/g, '\n'));
    if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
      mismatches.push(`設問${question.number}`);
    }
  }
  return mismatches;
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

async function captureForm(page, frame, form, path) {
  const height = await form.evaluate((element) => element.scrollHeight).catch(() => 900);
  await page.setViewportSize({ width: 1280, height: Math.min(Math.max(height + 300, 900), 16000) });
  await page.waitForTimeout(500);
  await form.screenshot({ path }).catch(() => page.screenshot({ path, fullPage: true }));
}

function indent(text) {
  return text.split('\n').map((line) => `> ${line}`).join('\n');
}
