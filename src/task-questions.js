import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

// Questions in WebClass `dqstn_answer_all.php` are classified by the inputs they
// actually contain, so a style name we have not seen still works. Every answer is
// stored as `values: string[]`, shared by the solvers, the review and form filling:
//   text     -> one string per text box (WebClass style "wordinput")
//   textarea -> one string per free-text box (記述式)
//   checkbox -> the option values that should be checked (may be empty)
//   radio    -> exactly one option value
//   select   -> one option value per select box (dropdown / matching)
//   file     -> one file path per upload box, relative to the task folder
export const ANSWERABLE_KINDS = ['text', 'textarea', 'checkbox', 'radio', 'select', 'file'];
// The AI never invents a file to submit; the user puts one in the task folder.
export const AI_KINDS = ['text', 'textarea', 'checkbox', 'radio', 'select'];
const UNANSWERED = '未解答';

// On paged tests the question text is in a separate frame, so it is passed as `fallbackText`.
export function parseQuestionForm(html, { fallbackText = '' } = {}) {
  const $ = cheerio.load(html);
  const form = $('form[name="answer_form"]');
  if (form.length !== 1) {
    throw new Error('The WebClass answer form was not found.');
  }

  const questions = [];
  form.find('input[type="hidden"][name$="[style]"]').each((_, styleInput) => {
    const number = Number($(styleInput).attr('name').match(/^QuestionAnswer\[(\d+)\]\[style\]$/)?.[1]);
    if (!Number.isInteger(number)) return;
    const style = $(styleInput).attr('value') ?? '';
    const heading = $(`#id_question_${number}`);
    const fieldset = $(`#QF_${number}`);
    const valueName = `QuestionAnswer[${number}][value]`;

    const question = {
      number,
      style,
      kind: detectKind($, fieldset, valueName),
      text: heading.length ? blockText($, heading.find('dd')) : fallbackText,
      points: normalizeText(fieldset.closest('table.qstnoptions').find('td.point').first().text())
        .replace(/[()\s]/g, '') || null,
      supported: true,
      parts: [],
      options: [],
      currentValues: [],
    };
    const { kind } = question;

    if (kind === 'file') {
      fieldset.find('input[type="file"]').each((__, input) => {
        question.parts.push({
          label: normalizeText($(input).closest('tr').children('th, td.prefix').first().text()) || `(${question.parts.length + 1})`,
          accept: $(input).attr('accept') ?? '',
        });
        question.currentValues.push('');
      });
      question.submitted = normalizeText(fieldset.text()).includes('提出済');
    } else if (kind === 'textarea') {
      fieldset.find('textarea').each((__, input) => {
        question.parts.push({
          label: normalizeText($(input).closest('tr').children('th, td.prefix').first().text()) || `(${question.parts.length + 1})`,
          minLength: Number($(input).attr('data-min-length')) || null,
          maxLength: Number($(input).attr('data-max-length')) || Number($(input).attr('maxlength')) || null,
          multiline: true,
        });
        question.currentValues.push($(input).text());
      });
    } else if (kind === 'checkbox' || kind === 'radio') {
      fieldset.find(`input[name^="${valueName}"]`).each((__, input) => {
        const value = $(input).attr('value');
        const id = $(input).attr('id');
        question.options.push({
          value,
          label: normalizeText(fieldset.find(`td[class^="option-label"] label[for="${id}"]`).text()),
        });
        if ($(input).is('[checked]')) question.currentValues.push(value);
      });
    } else if (kind === 'select') {
      fieldset.find(`select[name="${valueName}[]"]`).each((__, select) => {
        const row = $(select).closest('tr');
        const cells = row.children('td').toArray().map((cell) => normalizeText($(cell).text()));
        question.parts.push({
          label: [normalizeText(row.children('th').first().text()), cells[0] && cells.length > 1 ? cells[0] : '']
            .filter(Boolean).join(' '),
          options: $(select).find('option').toArray()
            .map((option) => ({ value: $(option).attr('value'), label: normalizeText($(option).text()) }))
            .filter((option) => option.value !== UNANSWERED),
        });
        question.currentValues.push($(select).find('option[selected]').attr('value') ?? UNANSWERED);
      });
    } else if (kind === 'text') {
      fieldset.find(`input[type="text"][name="${valueName}[]"]`).each((__, input) => {
        const row = $(input).closest('tr');
        question.parts.push({
          label: normalizeText(row.children('th, td.prefix').first().text()) || `(${question.parts.length + 1})`,
          maxLength: Number($(input).attr('maxlength')) || null,
          multiline: false,
        });
        question.currentValues.push($(input).attr('value') ?? '');
      });
    }

    if (!ANSWERABLE_KINDS.includes(kind) || (question.parts.length === 0 && question.options.length === 0)) {
      question.supported = false;
    }
    questions.push(question);
  });

  if (questions.length === 0) {
    throw new Error('No questions were found in the WebClass answer form.');
  }
  return questions;
}

// Text of the question frame (`dqstn_question.php`) of a paged test.
export function parseQuestionText(html) {
  const $ = cheerio.load(html);
  const blocks = $('.question').toArray().map((element) => blockText($, $(element)));
  return blocks.filter(Boolean).join('\n\n');
}

// Detects a change in the questions between fetching and submitting.
// `page` and `field` exist only on paged tests, so single-page fingerprints are unchanged.
export function questionFingerprint(questions) {
  const shape = questions.map(({ number, page, field, style, kind, text, parts, options }) => ({
    number, page, field, style, kind, text,
    parts: parts.map(({ label, options: partOptions }) => ({ label, options: partOptions })),
    options,
  }));
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

export function validateAnswers(questions, answers) {
  if (!Array.isArray(answers)) throw new Error('answers must be an array.');
  const byNumber = new Map(answers.map((answer) => [Number(answer.question), answer]));
  const problems = [];
  const normalized = [];

  for (const question of questions) {
    const answer = byNumber.get(question.number);
    if (!answer) {
      problems.push(`設問${question.number}: 解答がありません`);
      continue;
    }
    const values = Array.isArray(answer.values) ? answer.values.map((value) => String(value).trim()) : null;
    if (!values) {
      problems.push(`設問${question.number}: values は配列にしてください`);
      continue;
    }
    const error = valueProblem(question, values);
    if (error) problems.push(`設問${question.number}: ${error}`);
    normalized.push({ ...answer, question: question.number, values });
  }

  const extra = answers.filter((answer) => !questions.some((question) => question.number === Number(answer.question)));
  for (const answer of extra) problems.push(`設問${answer.question}: 存在しない設問です`);

  if (problems.length) throw new Error(`解答の形式が正しくありません。\n${problems.join('\n')}`);
  return normalized;
}

// A question is classified by the inputs WebClass rendered for it.
function detectKind($, fieldset, valueName) {
  if (fieldset.find('input[type="file"]').length) return 'file';
  if (fieldset.find('textarea').length) return 'textarea';
  if (fieldset.find(`input[type="checkbox"][name^="${valueName}"]`).length) return 'checkbox';
  if (fieldset.find(`input[type="radio"][name^="${valueName}"]`).length) return 'radio';
  if (fieldset.find(`select[name="${valueName}[]"]`).length) return 'select';
  if (fieldset.find(`input[type="text"][name="${valueName}[]"]`).length) return 'text';
  return 'unknown';
}

function valueProblem(question, values) {
  if (!question.supported) {
    return `未対応の形式 (${question.style || question.kind}) です`;
  }
  const optionValues = question.options.map((option) => option.value);
  switch (question.kind) {
    case 'file':
      if (values.length !== question.parts.length) return `${question.parts.length}個のファイルパスが必要です`;
      if (values.some((value) => !value)) return '提出するファイルのパスが空です';
      // Resolved against the task folder at submission time; absolute paths are refused there.
      if (values.some((value) => /^[a-zA-Z]:[\\/]|^[\\/]|\.\./.test(value))) {
        return 'ファイルは課題フォルダ内の相対パスで指定してください';
      }
      return null;
    case 'textarea':
    case 'text':
      if (values.length !== question.parts.length) return `${question.parts.length}個の文字列が必要です`;
      if (values.some((value) => !value)) return '空欄があります';
      if (question.parts.some((part, index) => part.maxLength && values[index].length > part.maxLength)) {
        return '文字数の上限を超えています';
      }
      if (question.parts.some((part, index) => part.minLength && values[index].length < part.minLength)) {
        return '文字数が下限に足りません';
      }
      return null;
    case 'checkbox':
      if (values.some((value) => !optionValues.includes(value))) return `選択肢は ${optionValues.join(',')} から選んでください`;
      if (new Set(values).size !== values.length) return '同じ選択肢が重複しています';
      return null;
    case 'radio':
      if (values.length !== 1 || !optionValues.includes(values[0])) return `選択肢を1つ (${optionValues.join(',')}) 選んでください`;
      return null;
    default:
      if (values.length !== question.parts.length) return `${question.parts.length}個の選択が必要です`;
      if (question.parts.some((part, index) => !part.options.some((option) => option.value === values[index]))) {
        return '選択肢にない値があります';
      }
      return null;
  }
}

// Canonical form used to decide whether two solvers agree.
export function sameValues(question, left, right) {
  const normalize = (values) => {
    const list = values.map((value) => String(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase());
    return question.kind === 'checkbox' ? [...list].sort() : list;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function describeValues(question, values) {
  if (question.kind === 'file') {
    return values.map((value, index) => `${question.parts[index]?.label ?? `(${index + 1})`} ファイル: ${value}`).join('\n');
  }
  if (question.kind === 'checkbox' || question.kind === 'radio') {
    if (values.length === 0) return '（どれも選ばない）';
    return values.map((value) => {
      const option = question.options.find((item) => item.value === value);
      return `${value}. ${option?.label ?? '?'}`;
    }).join(' / ');
  }
  return values.map((value, index) => {
    const part = question.parts[index];
    const label = part?.options
      ? `${value}. ${part.options.find((option) => option.value === value)?.label ?? '?'}`
      : value;
    return `${part?.label ?? `(${index + 1})`} ${label}`;
  }).join('\n');
}

// Plain-text rendering of the questions for solver prompts and review.
export function renderQuestions(questions) {
  return questions.map((question) => {
    const lines = [`## 設問${question.number} [形式: ${question.kind}${question.points ? ` / 配点: ${question.points}` : ''}]`, question.text];
    if (question.options.length) {
      lines.push('選択肢:', ...question.options.map((option) => `  ${option.value}. ${option.label}`));
    }
    for (const part of question.parts) {
      if (part.options) {
        lines.push(`${part.label}:`, ...part.options.map((option) => `  ${option.value}. ${option.label}`));
      } else if (question.kind === 'file') {
        lines.push(`${part.label}: （ファイル提出${part.accept ? ` ${part.accept}` : ''}${question.submitted ? '、提出済みのファイルあり' : ''}）`);
      } else {
        const limits = [part.minLength && `最小${part.minLength}文字`, part.maxLength && `最大${part.maxLength}文字`].filter(Boolean).join(' ');
        lines.push(`${part.label}: （${question.kind === 'textarea' ? '記述式' : '記述欄'}${limits ? ` ${limits}` : ''}）`);
      }
    }
    if (!question.supported) lines.push('※この形式は自動入力に未対応です');
    else if (question.kind === 'file') {
      lines.push(question.parts.length === 1
        ? '※この設問は提出するレポート本文を reports に Markdown で書いてください（PDFに変換して提出します）。'
        : '※アップロード欄が複数あるため、提出ファイルは本人が用意します。解答しないでください。');
    }
    return lines.join('\n');
  }).join('\n\n');
}

function blockText($, element) {
  const clone = element.clone();
  clone.find('style, script').remove();
  clone.find('img').each((_, image) => {
    $(image).replaceWith(`[画像: ${$(image).attr('alt') || $(image).attr('src') || ''}]`);
  });
  clone.find('br').replaceWith('\n');
  clone.find('li').each((_, item) => { $(item).prepend('\n- '); });
  clone.find('p, div, ol, ul, tr').each((_, block) => { $(block).append('\n'); });
  return clone.text().split('\n').map(normalizeText).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
