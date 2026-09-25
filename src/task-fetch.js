import { basename, extname, join } from 'node:path';
import * as cheerio from 'cheerio';
import { assertWebclassTaskUrl } from './config.js';
import { gotoWebclassPage, isWebclassLoginPage, openWebclassSession } from './webclass.js';
import { extractAttachmentText } from './task-extract.js';
import { parseQuestionForm, questionFingerprint, renderQuestions } from './task-questions.js';
import { collectPagedQuestions, findAnswerFrame } from './task-paged.js';
import { pageName, renderPdfPages } from './task-render.js';
import { readSubmittedTask, saveJson, saveTask, saveText, taskDir, taskId } from './task-store.js';

const ORIGIN = 'https://webclass.nanzan-u.ac.jp';
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MATERIAL_CATEGORIES = ['資料', '教材'];
// Opening these may start a timed or attempt-limited test.
export const ATTEMPT_CATEGORIES = ['試験', 'テスト', '小テスト'];

export function contentUrl(contentsId) {
  return `${ORIGIN}/webclass/do_contents.php?reset_status=1&set_contents_id=${contentsId}`;
}

export function courseEntryUrl(courseId) {
  return `${ORIGIN}/webclass/course.php/${courseId}/login`;
}

export async function listContents(config) {
  const { browser, page } = await openWebclassSession(config);
  try {
    return await collectContents(page);
  } finally {
    await browser.close();
  }
}

async function collectContents(page) {
  await gotoWebclassPage(page, `${ORIGIN}/webclass/`);
  const courses = await page.$$eval('a[href*="/webclass/course.php/"]', (links) => links.map((link) => ({
    href: link.href,
    name: link.textContent.replace(/\s+/g, ' ').trim(),
  })));
  const byId = new Map();
  for (const course of courses) {
    const courseId = course.href.match(/\/course\.php\/([a-f0-9]{32})/)?.[1];
    if (courseId && course.name && !byId.has(courseId)) byId.set(courseId, cleanCourseName(course.name));
  }
  if (byId.size === 0) throw new Error('No WebClass courses were found.');

  const contents = [];
  for (const [courseId, courseName] of byId) {
    await gotoWebclassPage(page, courseEntryUrl(courseId));
    if (await isWebclassLoginPage(page)) throw new Error('The WebClass session was lost while listing courses.');
    contents.push(...extractCourseContents(await page.content(), courseId, courseName));
  }
  return contents;
}

export function extractCourseContents(html, courseId, courseName) {
  const $ = cheerio.load(html);
  return $('.cl-contentsList_listGroupItem').toArray().map((element) => {
    const item = $(element);
    const href = item.find('.cm-contentsList_contentName a[href], a[href]').first().attr('href') ?? '';
    const contentsId = href.match(/set_contents_id=([a-f0-9]{32})/)?.[1] ?? href.match(/\/contents\/([a-f0-9]{32})/)?.[1];
    const endDate = Number(item.attr('data-end-date'));
    return {
      contentsId,
      courseId,
      courseName,
      category: normalize(item.find('.cl-contentsList_categoryLabel').first().text()),
      title: normalize(item.find('.cm-contentsList_contentName').first().text()).replace(/^(?:New(?![A-Za-z0-9])|新着)\s*/i, ''),
      deadlineAt: Number.isFinite(endDate) && endDate > 0 ? new Date(endDate * 1000).toISOString() : null,
      executionCount: Number(item.attr('data-exec-count') ?? NaN),
    };
  }).filter((item) => item.contentsId && item.title);
}

export function isMaterial(item) {
  return MATERIAL_CATEGORIES.includes(item.category) || item.category === 'リンク';
}

// Every whitespace-separated word must appear in "course title", so
// "ソフトウェア工学基礎 第1回 復習課題(1)" selects one item.
export function selectContent(contents, query) {
  const trimmed = String(query ?? '').trim();
  if (!trimmed) throw new Error('課題を指定してください。');
  const exactId = trimmed.match(/[a-f0-9]{32}/)?.[0];
  const candidates = contents.filter((item) => !isMaterial(item));
  const matches = exactId
    ? candidates.filter((item) => item.contentsId === exactId)
    : candidates.filter((item) => {
      const haystack = searchable(`${item.courseName} ${item.title}`);
      return searchable(trimmed).split(' ').every((word) => haystack.includes(word));
    });
  if (matches.length !== 1) {
    const listing = matches.slice(0, 10).map((item) => `  ${item.contentsId}  ${item.courseName} / ${item.title}`).join('\n');
    throw new Error(`"${trimmed}" に一致する課題が${matches.length}件あります。${matches.length ? `\n${listing}\nIDで指定してください。` : ''}`);
  }
  return matches[0];
}

export async function fetchTask(config, query, options = {}) {
  const { browser, page } = await openWebclassSession(config);
  acceptPageLeave(page);
  try {
    const contents = await collectContents(page);
    const item = selectContent(contents, query);
    const id = taskId(item.contentsId);
    // Re-fetching replaces task.json, which would drop the record of a submission and make the
    // task answerable (and submittable) again, so it has to be asked for explicitly. What is
    // known about the earlier submission is kept.
    const submitted = await readSubmittedTask(id);
    if (submitted && !options.force) {
      throw new Error(`この課題は既に提出処理に入っています (status: ${submitted.status})。`
        + '結果を確認してください。取り直す場合は --force を付けてください（提出済みの記録は残ります）。');
    }
    const base = {
      id,
      item,
      fetchedAt: new Date().toISOString(),
      ...(submitted && { previousSubmission: {
        status: submitted.status,
        submittedAt: submitted.submittedAt ?? null,
        submissionAttemptedAt: submitted.submissionAttemptedAt ?? null,
        approval: submitted.approval ?? null,
      } }),
    };

    try {
      const materials = options.materials === false
        ? []
        : await fetchMaterials(page, id, pickMaterials(contents, item, options.materialQueries ?? []));
      const { questions, html, pages } = await openQuestionForm(page, item, { allowAttempt: options.allowAttempt });
      if (pages) {
        for (const current of pages) {
          await saveText(id, `question-p${current.number}.html`, current.answerHtml);
          await saveText(id, `question-p${current.number}-text.html`, current.questionHtml);
        }
      } else {
        await saveText(id, 'question.html', html);
      }

      const materialList = materials.map((material) => [
        `- ${material.textFile}（${material.title}${material.readable ? '' : '、文字を読み取れませんでした'}）`,
        ...material.images.map((directory) => `  - ページ画像: ${directory}（図・グラフ・表はこちらで確認）`),
      ].join('\n'));
      await saveText(id, 'questions.md', [
        `# ${item.courseName} / ${item.title}`,
        `期限: ${formatDeadline(item.deadlineAt)}`,
        ...(pages ? [`形式: 1ページずつ表示されるテスト（全${pages.length}ページ）`] : []),
        '',
        renderQuestions(questions),
        '',
        '# 資料',
        materialList.length ? materialList.join('\n') : '（取得した資料はありません）',
        '',
      ].join('\n'));

      const task = {
        ...base,
        status: 'fetched',
        questions,
        fingerprint: questionFingerprint(questions),
        layout: pages ? 'paged' : 'single',
        materials,
        unsupported: questions.filter((question) => !question.supported).map((question) => question.number),
      };
      await saveTask(id, task);
      return task;
    } catch (error) {
      const pages = await savePageFrames(page, id);
      await saveTask(id, { ...base, status: 'fetch-error', error: error.message, pages });
      throw error;
    }
  } finally {
    await browser.close();
  }
}

// Opens the content, presses 開始 when needed and returns the parsed answer form.
// Single-page forms: leaving the page afterwards without grading does not save anything.
// Paged tests (layout 'paged'): every page is visited once, which saves each page as it
// was (nothing is filled in here); nothing is graded until 終了 is pressed.
export async function openQuestionForm(page, item, { allowAttempt = false } = {}) {
  if (ATTEMPT_CATEGORIES.includes(item.category) && !allowAttempt) {
    throw new Error(`「${item.category}」は開始すると受験回数や制限時間を消費する可能性があります。確認のうえ --allow-attempt を付けて実行してください。`);
  }
  await gotoWebclassPage(page, courseEntryUrl(item.courseId));
  await gotoWebclassPage(page, contentUrl(item.contentsId));
  await page.waitForTimeout(1500);

  let frame = findFrame(page, 'dqstn_answer_all.php') ?? findAnswerFrame(page);
  if (!frame) {
    const info = findFrame(page, 'show_info.php');
    if (!info) {
      await failWithPageText(page, 'WebClassの開始画面が見つかりませんでした');
    }
    const infoText = await info.locator('body').innerText().catch(() => '');
    if (/制限時間|受験回数|回数制限|残り回数/.test(infoText) && !allowAttempt) {
      throw new Error(`この教材には制限時間または回数制限があります。確認のうえ --allow-attempt を付けて実行してください。\n${infoText.slice(0, 300)}`);
    }
    const start = info.locator('input[value="開始"], button:has-text("開始")').first();
    if (!await start.isVisible().catch(() => false)) {
      await failWithPageText(page, '［開始］ボタンが押せない状態です（利用期間外の可能性があります）');
    }
    await start.click();
    frame = await waitForAnyFrame(page, ['dqstn_answer_all.php', '/dqstn_answer.php']);
  }
  if (frame && findAnswerFrame(page) === frame) {
    const { questions, pages } = await collectPagedQuestions(page);
    return { layout: 'paged', frame: findAnswerFrame(page), questions, pages };
  }
  if (!frame) {
    await failWithPageText(page, 'この形式の課題（複数ページに分かれたテストなど）にはまだ対応していません');
  }
  // A multi-page form inside dqstn_answer_all.php is a layout we have not seen; stopping
  // here keeps the workflow from seeing only part of the questions.
  const buttonFrame = findFrame(page, 'dqstn_button.php');
  const singlePage = buttonFrame ? new URL(buttonFrame.url()).searchParams.get('single_page') : '1';
  if (singlePage !== '1') {
    throw new Error('この課題は設問が複数ページに分かれていますが、見たことのない画面構成のため中止しました。WebClassで直接解答してください。');
  }
  await frame.waitForLoadState('domcontentloaded').catch(() => undefined);
  const html = await frame.content();
  return { layout: 'single', frame, html, questions: parseQuestionForm(html) };
}

export function acceptPageLeave(page) {
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'beforeunload') dialog.accept().catch(() => undefined);
  });
}

function pickMaterials(contents, item, queries) {
  const sameCourse = contents.filter((content) => content.courseId === item.courseId && isMaterial(content));
  const rounds = roundNumbers(item.title);
  const picked = new Map();
  for (const material of sameCourse) {
    const materialRounds = roundNumbers(material.title);
    if (material.title === '講義資料') {
      picked.set(material.contentsId, { ...material, rounds });
    } else if (rounds.length && materialRounds.some((round) => rounds.includes(round))) {
      picked.set(material.contentsId, { ...material, rounds: [] });
    }
    for (const query of queries) {
      if (searchable(material.title).includes(searchable(query))) picked.set(material.contentsId, { ...material, rounds: [] });
    }
  }
  return [...picked.values()];
}

// Chapter lists name several rounds at once, e.g. "第2, 3回 要求定義".
export function roundNumbers(text) {
  const match = searchable(text).match(/第\s*([0-9,、・~〜\-\s]+)\s*回/);
  if (!match) return [];
  const numbers = match[1].match(/\d+/g)?.map(Number) ?? [];
  if (/[~〜-]/.test(match[1]) && numbers.length === 2) {
    return Array.from({ length: numbers[1] - numbers[0] + 1 }, (_, index) => numbers[0] + index);
  }
  return numbers;
}

async function fetchMaterials(page, id, materials) {
  const saved = [];
  for (const material of materials) {
    await gotoWebclassPage(page, courseEntryUrl(material.courseId));
    await gotoWebclassPage(page, contentUrl(material.contentsId));
    await page.waitForTimeout(1500);

    const chapter = findFrame(page, 'txtbk_show_chapter.php');
    let files = [];
    let pageTexts = [];
    if (chapter) {
      const entries = decodeChapterList(await chapter.locator('input[name="s"]').getAttribute('value').catch(() => null));
      const wanted = material.rounds.length
        ? entries.filter((entry) => roundNumbers(entry.heading).some((round) => material.rounds.includes(round)))
        : entries;
      for (const entry of wanted) {
        if (entry.fileUrl) files.push({ url: entry.fileUrl, heading: entry.heading });
        else if (entry.pageUrl) {
          const response = await page.context().request.get(new URL(entry.pageUrl, ORIGIN).toString());
          const html = await response.text();
          const $ = cheerio.load(html);
          $('script, style').remove();
          pageTexts.push(`[${entry.heading}]\n${$('body').text().replace(/\s+\n/g, '\n').trim()}`);
          files.push(...fileLinks($, entry.heading));
        }
      }
    } else {
      for (const frame of page.frames()) {
        const html = await frame.content().catch(() => '');
        const $ = cheerio.load(html);
        $('script, style').remove();
        const text = $('body').text().replace(/\s+\n/g, '\n').trim();
        if (text) pageTexts.push(text);
        files.push(...fileLinks($, material.title, frame.url()));
      }
    }
    files = [...new Map(files.map((file) => [file.url, file])).values()].slice(0, 15);

    const texts = [...pageTexts];
    const rawFiles = [];
    const images = [];
    let readable = pageTexts.some((text) => text.length > 40);
    for (const [index, file] of files.entries()) {
      try {
        assertWebclassTaskUrl(file.url);
        const response = await page.context().request.get(file.url, { timeout: 60_000 });
        if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
        const bytes = await response.body();
        if (bytes.length > MAX_FILE_BYTES) throw new Error('25MBを超えるため読み飛ばしました');
        const name = safeName(`${material.contentsId.slice(0, 6)}-${index + 1}-${basename(new URL(file.url).pathname)}`, response.headers()['content-type']);
        const rawPath = await saveText(id, `materials/raw/${name}`, bytes);
        rawFiles.push(rawPath);
        const extracted = await extractAttachmentText(name, bytes);
        if (extracted.supported && extracted.text.trim().length > 40) readable = true;
        // Charts, figures and tables never reach the extracted text, so each PDF page
        // is also saved as an image the solvers can open.
        const imageNote = name.toLowerCase().endsWith('.pdf')
          ? await renderPdfImages(id, name, rawPath)
          : '';
        texts.push(`[${file.heading} / ${name}]${imageNote}\n${extracted.supported ? extracted.text : '（この形式の文字は読み取れません）'}`);
        if (imageNote) images.push(`materials/images/${imageDirName(name)}/`);
      } catch (error) {
        texts.push(`[${file.heading}] 取得できませんでした: ${error.message}`);
      }
    }

    const textFile = `materials/${safeName(`${saved.length + 1}-${material.title}`)}.txt`;
    await saveText(id, textFile, `# ${material.title}\n\n${texts.join('\n\n')}\n`);
    saved.push({ contentsId: material.contentsId, title: material.title, textFile, rawFiles, images, readable });
  }
  await saveJson(id, 'materials.json', saved);
  return saved;
}

function imageDirName(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

async function renderPdfImages(id, name, rawPath) {
  const directory = `materials/images/${imageDirName(name)}`;
  try {
    const { rendered, failed, totalPages } = await renderPdfPages(rawPath, join(taskDir(id), directory));
    if (rendered.length === 0) return '';
    const failedNote = failed.length ? `、画像にできなかったページ: ${failed.join(', ')}` : '';
    return `\n（このPDFの各ページの画像: ${directory}/${pageName(1)} 〜 ${pageName(totalPages)}${failedNote}。`
      + '図・グラフ・表は下のテキストに含まれないため、必ず画像を開いて確認してください）';
  } catch (error) {
    console.warn(`PDFを画像にできませんでした (${name}): ${error.message}`);
    return '';
  }
}

// The chapter frame keeps the page list as a base64 PHP-serialized array.
export function decodeChapterList(encoded) {
  if (!encoded) return [];
  const serialized = Buffer.from(encoded, 'base64').toString('utf8');
  const entries = [];
  const pattern = /s:2:"H2";s:\d+:"([^"]*)";s:4:"TEXT";s:\d+:"[^"]*";s:4:"FILE";s:\d+:"([^"]*)";s:3:"url";s:\d+:"([^"]*)"/g;
  for (const [, heading, file, pageUrl] of serialized.matchAll(pattern)) {
    const contentsUrl = new URL(pageUrl, ORIGIN).searchParams.get('contents_url');
    entries.push({
      heading,
      pageUrl,
      fileUrl: file && contentsUrl ? new URL(`${contentsUrl}${file}`, ORIGIN).toString() : null,
    });
  }
  return entries;
}

function fileLinks($, heading, baseUrl = ORIGIN) {
  return $('a[href]').toArray()
    .map((link) => $(link).attr('href'))
    .map((href) => {
      const url = new URL(href, baseUrl);
      const direct = url.searchParams.get('file');
      return direct && url.pathname.endsWith('loadit.php') ? new URL(direct, ORIGIN) : url;
    })
    .filter((url) => url.hostname === new URL(ORIGIN).hostname && /\/webclass\/data\/course\/.+\.[a-z0-9]{2,5}$/i.test(url.pathname))
    .map((url) => ({ url: url.toString(), heading }));
}

function findFrame(page, fileName) {
  return page.frames().find((frame) => frame.url().includes(fileName)) ?? null;
}

async function waitForAnyFrame(page, fileNames, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const fileName of fileNames) {
      const frame = findFrame(page, fileName);
      if (frame) return frame;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

// Keeps the HTML of every frame when a page cannot be handled, so a new layout can be
// supported without opening the test again.
async function savePageFrames(page, id) {
  const saved = [];
  for (const [index, frame] of page.frames().entries()) {
    const html = await frame.content().catch(() => null);
    if (html === null) continue;
    const name = `pages/frame${index}-${basename(new URL(frame.url(), ORIGIN).pathname) || 'blank'}.html`;
    await saveText(id, name, html).catch(() => undefined);
    saved.push(name);
  }
  return saved;
}

async function failWithPageText(page, message) {
  const texts = [];
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText().catch(() => '');
    if (text.trim()) texts.push(text.trim());
  }
  throw new Error(`${message}\n${texts.join('\n').replace(/\s*\n\s*/g, '\n').slice(0, 400)}`);
}

function cleanCourseName(value) {
  return normalize(value)
    .replace(/^»\s*/, '')
    .replace(/^20\d{2}\s+[A-Z0-9]+-[0-9]+\s+/, '')
    .replace(/締切が近い課題があります。?$/, '')
    .trim();
}

function searchable(value) {
  return String(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function formatDeadline(iso) {
  if (!iso) return '不明';
  return new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' });
}

function safeName(name, contentType = '') {
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f\s]/g, '_').slice(0, 80);
  if (extname(cleaned) || !contentType) return cleaned;
  const extension = { 'application/pdf': '.pdf', 'text/html': '.html', 'text/plain': '.txt' }[contentType.split(';')[0].trim()];
  return extension ? `${cleaned}${extension}` : cleaned;
}
