import { parseQuestionForm, parseQuestionText } from './task-questions.js';

// Paged WebClass tests (qstn_frame.php) show one page at a time in three frames:
//   button   dqstn_button.php    次のページ / 終了 and the Q.1, Q.2 ... page list
//   question dqstn_question.php  the question text of the current page
//   answer   dqstn_answer.php    form[name="answer_form"] with the inputs of that page
// Moving to another page posts the answer form, so WebClass saves (but does not grade)
// whatever that page's inputs hold at that moment. Grading happens only on 終了 (#GradeBtn).
const ANSWER_FRAME = '/dqstn_answer.php';
const QUESTION_FRAME = '/dqstn_question.php';

export function findAnswerFrame(page) {
  return page.frames().find((frame) => frame.url().includes(ANSWER_FRAME)) ?? null;
}

export async function pagePosition(frame) {
  return frame.evaluate(() => {
    const form = document.forms.answer_form;
    if (!form) return null;
    const buttonUrl = new URL(form.button_url?.value ?? '', location.href);
    return {
      current: Number(form.page?.value),
      end: Number(buttonUrl.searchParams.get('end_page')),
      questionUrl: form.question_url?.value ? new URL(form.question_url.value, location.href).toString() : null,
    };
  });
}

// Uses WebClass's own setPage(), the function behind the Q.n buttons, and waits until
// both the answer form and the question text show the requested page.
export async function gotoTestPage(page, number, timeoutMs = 30_000) {
  let frame = findAnswerFrame(page);
  const before = frame && await pagePosition(frame).catch(() => null);
  if (before?.current === number) return waitForPageReady(page, number, timeoutMs);
  if (!frame || !before) throw new Error('テストの解答画面が見つかりませんでした。');
  if (number < 1 || number > before.end) throw new Error(`ページ${number}は存在しません（全${before.end}ページ）。`);
  // Deferred so the evaluation returns before the form submission tears down the frame.
  await frame.evaluate((target) => { setTimeout(() => window.setPage(target), 0); }, number);
  return waitForPageReady(page, number, timeoutMs);
}

async function waitForPageReady(page, number, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await page.waitForTimeout(500);
    const frame = findAnswerFrame(page);
    const position = frame && await pagePosition(frame).catch(() => null);
    if (!position || position.current !== number) continue;
    const ready = await frame.evaluate(() => document.readyState === 'complete').catch(() => false);
    const questionFrame = page.frames().find((candidate) => candidate.url().includes(QUESTION_FRAME));
    if (ready && questionFrame && sameQuestionPage(questionFrame.url(), position.questionUrl)) {
      await questionFrame.waitForLoadState('domcontentloaded').catch(() => undefined);
      return { frame, questionFrame, position };
    }
  }
  throw new Error(`テストのページ${number}を表示できませんでした。`);
}

function sameQuestionPage(actual, expected) {
  if (!expected) return true;
  const textId = new URL(expected).searchParams.get('text_id');
  return textId ? new URL(actual).searchParams.get('text_id') === textId : actual === expected;
}

// Visits every page in order. Moving on saves each page unchanged, since nothing is filled in.
// Questions are numbered 1..N across the pages; `field` is the number WebClass uses in the form.
export async function collectPagedQuestions(page) {
  const first = findAnswerFrame(page);
  const position = first && await pagePosition(first).catch(() => null);
  if (!position?.end) throw new Error('テストのページ数を読み取れませんでした。');

  const questions = [];
  const pages = [];
  for (let number = 1; number <= position.end; number++) {
    const { frame, questionFrame } = await gotoTestPage(page, number);
    const answerHtml = await frame.content();
    const questionHtml = await questionFrame.content();
    const onPage = parseQuestionForm(answerHtml, { fallbackText: parseQuestionText(questionHtml) });
    for (const question of onPage) {
      questions.push({
        ...question,
        number: questions.length + 1,
        page: number,
        field: question.number,
      });
    }
    pages.push({ number, answerHtml, questionHtml });
  }
  return { questions, pages };
}

// Values of every input on the current page, so a dry run can put them back before moving on.
export async function readPageInputs(frame) {
  return frame.evaluate(() => [...document.querySelectorAll('form[name="answer_form"] fieldset[id^="QF_"] :is(input, select, textarea)')]
    .map((input) => ({ type: input.type, checked: Boolean(input.checked), value: input.type === 'file' ? '' : input.value })));
}

export async function restorePageInputs(frame, saved) {
  const restored = await frame.evaluate((values) => {
    const inputs = [...document.querySelectorAll('form[name="answer_form"] fieldset[id^="QF_"] :is(input, select, textarea)')];
    if (inputs.length !== values.length) return false;
    inputs.forEach((input, index) => {
      if (input.type === 'radio' || input.type === 'checkbox') input.checked = values[index].checked;
      else if (input.type !== 'file' && input.type !== 'hidden') input.value = values[index].value;
    });
    return true;
  }, saved);
  const now = await readPageInputs(frame);
  if (!restored || JSON.stringify(now) !== JSON.stringify(saved)) {
    throw new Error('dry-run で入力した内容を元に戻せませんでした。ページを移動せずに中止します（WebClassには保存されません）。');
  }
}
