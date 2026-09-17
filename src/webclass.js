import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import { hashText } from './hash.js';

const USERNAME_SELECTORS = [
  'input[name="username"]',
  'input[name="user_id"]',
  'input[name="userid"]',
  'input[name="login_id"]',
  'input[type="text"]',
];

const PASSWORD_SELECTORS = [
  'input[name="val"]',
  'input[name="password"]',
  'input[name="passwd"]',
  'input[type="password"]',
];

const SUBMIT_SELECTORS = [
  'input[type="submit"]',
  'button[type="submit"]',
  'input[value*="ログイン"]',
  'button:has-text("ログイン")',
  'button:has-text("Login")',
];

export async function fetchAssignments(config, options = {}) {
  const { assignments } = await fetchAssignmentSnapshot(config, options);
  return assignments;
}

// Returns the assignments together with the course pages that could not be read,
// so callers can avoid treating a partial result as the complete list.
export async function fetchAssignmentSnapshot(config, options = {}) {
  const browser = await chromium.launch({ headless: config.headless });
  const page = await browser.newPage({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });

  try {
    await gotoWebclassPage(page, config.webclassLoginUrl);
    if (await hasFirstVisible(page, PASSWORD_SELECTORS)) {
      await fillFirstVisible(page, USERNAME_SELECTORS, config.webclassUserId);
      await fillFirstVisible(page, PASSWORD_SELECTORS, config.webclassPassword);
      await clickFirstVisible(page, SUBMIT_SELECTORS);
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }

    const targetUrls = config.webclassTargetUrls.length
      ? config.webclassTargetUrls
      : await discoverCourseUrls(page);

    if (targetUrls.length === 0) {
      throw new Error('No WebClass course pages were found. The login may have failed.');
    }

    const assignments = [];
    const failedUrls = [];
    for (const targetUrl of targetUrls) {
      try {
        await gotoWebclassPage(page, targetUrl);
      } catch (error) {
        console.warn(`Skipped WebClass page after navigation failure: ${targetUrl}`);
        console.warn(error.message);
        failedUrls.push(targetUrl);
        continue;
      }
      if (await hasFirstVisible(page, PASSWORD_SELECTORS)) {
        console.warn(`Skipped WebClass page because the session was lost: ${targetUrl}`);
        failedUrls.push(targetUrl);
        continue;
      }
      const html = await page.content();
      const pageAssignments = extractAssignments(html, page.url());
      assignments.push(...pageAssignments);

      if (options.onPage) {
        await options.onPage({
          url: page.url(),
          title: await page.title(),
          assignmentCount: pageAssignments.length,
        });
      }

      if (options.saveDebugHtml) {
        await options.saveDebugHtml(html, page.url());
      }
    }

    if (failedUrls.length === targetUrls.length) {
      throw new Error(`Could not read any of the ${targetUrls.length} WebClass course pages.`);
    }

    return { assignments: dedupeAssignments(assignments), failedUrls };
  } finally {
    await browser.close();
  }
}

async function gotoWebclassPage(page, url) {
  await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
}

async function fillFirstVisible(page, selectors, value) {
  const locator = await findFirstVisible(page, selectors);
  if (locator) {
    await locator.fill(value);
    return;
  }
  throw new Error(`Could not find input field. Tried: ${selectors.join(', ')}`);
}

async function hasFirstVisible(page, selectors) {
  return Boolean(await findFirstVisible(page, selectors));
}

async function findFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }
  return null;
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => undefined),
        locator.click(),
      ]);
      return;
    }
  }
  throw new Error(`Could not find submit button. Tried: ${selectors.join(', ')}`);
}

async function discoverTargetUrls(page) {
  const currentUrl = page.url();
  const urls = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map((link) => ({
        href: link.href,
        text: link.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      }))
      .filter(({ href, text }) => {
        try {
          const url = new URL(href);
          const path = url.pathname;
          const isCourseTop = /^\/webclass\/course\.php\/[^/]+\/(?:login)?$/.test(path);
          const isCourseContents =
            /^\/webclass\/course\.php\/[^/]+\/?$/.test(path) && url.hash === '#contents';
          return (isCourseTop || isCourseContents) && !/ログアウト|logout/i.test(text + href);
        } catch {
          return false;
        }
      })
      .map(({ href }) => href);
  });

  const currentCourseUrl = isCourseTopUrl(currentUrl) ? [currentUrl] : [];
  return dedupeCourseUrls([...currentCourseUrl, ...urls]).slice(0, 80);
}

async function discoverCourseUrls(page) {
  const urls = new Set(await discoverTargetUrls(page));
  const courseListUrl = new URL('/webclass/', page.url()).toString();

  await gotoWebclassPage(page, courseListUrl).catch((error) => {
    console.warn(`Could not open course list: ${error.message}`);
  });
  for (const url of await discoverTargetUrls(page)) {
    urls.add(url);
  }

  return dedupeCourseUrls(Array.from(urls));
}

function isCourseTopUrl(value) {
  const url = new URL(value);
  return /^\/webclass\/course\.php\/[^/]+\/(?:login)?$/.test(url.pathname);
}

function dedupeCourseUrls(values) {
  const selected = new Map();

  for (const value of values) {
    const url = new URL(value);
    const courseId = url.pathname.match(/^\/webclass\/course\.php\/([^/]+)/)?.[1];
    const key = courseId ? `${url.origin}|${courseId}` : value;
    const existing = selected.get(key);
    const isLoginEntry = /\/login\/?$/.test(url.pathname);

    if (!existing || isLoginEntry) {
      url.hash = '';
      selected.set(key, url.toString());
    }
  }

  return Array.from(selected.values());
}

export function extractAssignments(html, pageUrl, now = new Date()) {
  const $ = cheerio.load(html);
  const courseName = cleanCourseName(normalizeText(
    $('.course-name, h1, h2, .course-title, #course-title, .coursename').first().text(),
  ));
  $('script, style, nav, header, footer, noscript, .modal, .dropdown-menu').remove();
  const candidates = [];
  const candidateElements = collectCandidateElements($);

  for (const element of candidateElements) {
    const text = normalizeText($(element).text());
    if (!isProbableAssignmentElement($, element, text)) {
      continue;
    }

    const href = $(element).find('a[href]').first().attr('href');
    const url = href ? new URL(href, pageUrl).toString() : pageUrl;
    const title = pickTitle($, element);
    const deadlineText = pickDeadline($, element, text);
    const deadlineAt = pickDeadlineAt($, element, deadlineText, now);
    const status = pickStatus($, element, text);
    if (!courseName || !deadlineText || isBadAssignmentTitle(title) || isExpired(deadlineAt, now)) {
      continue;
    }

    const stableKey = hashText(`${normalizeCourseName(courseName)}|${normalizeTitle(title)}`);
    const id = hashText(`${stableKey}|${deadlineText ?? ''}`);

    candidates.push({
      id,
      stableKey,
      sourceId: pickSourceId(url),
      courseName,
      title,
      deadlineText,
      deadlineAt,
      status,
      url,
      sourceText: text.slice(0, 300),
    });
  }

  return dedupeAssignments(candidates);
}

function collectCandidateElements($) {
  const elements = new Set();
  const selectors = [
    '.cl-contentsList_listGroupItem',
    '.cl-contentsList_content',
    '.cm-contentsList_content',
    '.cl-contentsList .list-group-item',
    '.cm-contentsList .list-group-item',
    '.cl-contentsList tr',
    '.cm-contentsList tr',
    '.cl-contentsList li',
    '.cm-contentsList li',
    '[class*="contentsList_content"]',
    '[class*="content-kind-report"]',
    '[class*="content-kind-examine"]',
    '[class*="content-kind-selfstudy"]',
    '[class*="content-kind-Scenario"]',
  ];

  for (const selector of selectors) {
    $(selector).each((_, element) => elements.add(canonicalCandidateElement($, element)));
  }

  if (elements.size === 0) {
    $('.cm-contentsList a[href], a[href*="contents"], a[href*="report"], a[href*="test"]').each(
      (_, link) => {
        const element = canonicalCandidateElement($, link);
        if (element) {
          elements.add(element);
        }
      },
    );
  }

  return Array.from(elements);
}

function canonicalCandidateElement($, element) {
  return (
    $(element).closest(
      '.cl-contentsList_listGroupItem, .cm-contentsList_content, .cl-contentsList_content, .list-group-item, tr, li',
    )[0] ?? element
  );
}

function dedupeAssignments(assignments) {
  const unique = new Map();

  for (const assignment of assignments) {
    // Different contents can share a title, so prefer the WebClass content ID.
    const key = assignment.sourceId
      ? `source:${assignment.sourceId}`
      : `key:${assignment.stableKey}|${assignment.deadlineText ?? ''}`;
    const existing = unique.get(key);
    if (!existing || deadlineTime(assignment) < deadlineTime(existing)) {
      unique.set(key, assignment);
    }
  }

  return Array.from(unique.values());
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function isProbableAssignmentElement($, element, text) {
  if (text.length < 4 || text.length > 1500) {
    return false;
  }
  if (isNavigationOrUiText(text)) {
    return false;
  }

  const className = normalizeText($(element).attr('class') ?? '');
  const title = pickTitle($, element);
  if (isBadAssignmentTitle(title)) {
    return false;
  }

  const evidenceText = `${className} ${title} ${text}`;
  const category = normalizeText($(element).find('.cl-contentsList_categoryLabel').first().text());
  if (/^(資料|教材|リンク)$/.test(category)) {
    return false;
  }

  const knownTaskKind =
    /^(レポート|試験|テスト|小テスト)$/.test(category) ||
    /content-kind-(report|examine)/i.test(className);
  const selfStudyKind =
    category === '自習' || /content-kind-selfstudy/i.test(className);
  const taskGroup = /(課題|テスト)/.test(findGroupContext($, element));
  const hasDeadline = Boolean(pickDeadline($, element, text));
  const hasUsefulTitle = title.length >= 2 && !isNavigationOrUiText(title);
  const hasExplicitTaskTitle = /(課題|レポート|小テスト|テスト|試験)/.test(title);

  const fallbackTaskEvidence =
    !category && taskGroup && /(レポート|自習|課題|小テスト|テスト|試験)/.test(evidenceText);
  const requiredSelfStudy = selfStudyKind && hasExplicitTaskTitle;
  return hasUsefulTitle && hasDeadline && (knownTaskKind || requiredSelfStudy || fallbackTaskEvidence);
}

function isBadAssignmentTitle(title) {
  const normalized = normalizeText(title);
  return (
    !normalized ||
    /^(New|新着|詳細|表示|開始|回答|実行|教材|資料|閲覧|開く|Top|もっと見る|さらに過去の記録を取得)$/i.test(
      normalized,
    ) ||
    /^(詳細|表示|開始|回答|実行)$/.test(normalized) ||
    // Date-only cells (e.g. a deadline column) are never titles.
    /^[\d\s\/\-.:：年月日～〜]+$/.test(normalized)
  );
}

function isNavigationOrUiText(text) {
  return /(?:ログアウト|コースリスト|アカウント|マニュアル|FAQ|タイムライン|ラベル一覧|教材がありません|さらに過去|もっと見る|送信|成績|出席|ノート|開講情報|アクセスログ|作成|削除された教材|既存の教材を公開|SCORMの成績一覧|テスト結果|マイレポート)$/.test(
    text,
  );
}

function findGroupContext($, element) {
  const previousHeadings = $(element)
    .prevAll('h1, h2, h3, h4, .label, .panel-heading, .list-group-item-heading')
    .slice(0, 3)
    .text();
  const parentText = $(element)
    .closest('.panel, section, .cl-contentsList_folder, .cm-contentsList')
    .find('h1, h2, h3, h4, .panel-title')
    .first()
    .text();
  return normalizeText(`${previousHeadings} ${parentText}`);
}

function pickTitle($, element) {
  const dataContentsName = cleanTitleCandidate($(element).attr('data-contents-name') ?? '');
  if (dataContentsName && !isBadAssignmentTitle(dataContentsName)) {
    return dataContentsName.slice(0, 120);
  }

  const titleSelectors = [
    '.cl-contentsList_contentInfo .cm-contentsList_contentName a',
    '.cl-contentsList_contentInfo .cm-contentsList_contentName div',
    '.cl-contentsList_contentInfo .cm-contentsList_contentName',
    '.cm-contentsList_contentName a',
    '.cm-contentsList_contentName',
    '[class*="contentName"] a',
    '[class*="contentName"]',
    '.list-group-item-heading a',
    '.list-group-item-heading',
    'a[href*="do_contents"]',
    'a[href]',
    'th',
    'td',
    'strong',
  ];

  for (const selector of titleSelectors) {
    for (const candidate of $(element).find(selector).toArray()) {
      const title = cleanTitleCandidate($(candidate).text());
      if (title && !isBadAssignmentTitle(title)) {
        return title.slice(0, 120);
      }
    }
  }

  return '';
}

function cleanTitleCandidate(value) {
  return stripNewBadge(normalizeText(value))
    .replace(/\s+(?:レポート|自習|試験|テスト|小テスト)利用(?:可能)?期間.*$/, '')
    .trim();
}

// Strip only a standalone badge so titles such as "Newton法" stay intact.
function stripNewBadge(value) {
  return value.replace(/^(?:New(?![A-Za-z0-9])|新着)\s*/i, '');
}

function pickDeadline($, element, text) {
  const endDate = Number($(element).attr('data-end-date'));
  if (Number.isFinite(endDate) && endDate > 0) {
    return formatLocalDeadline(new Date(endDate * 1000));
  }

  const patterns = [
    /(?:利用期間|利用可能期間|公開期間|受付期間|提出期間|実施期間|回答期間)[:：]?\s*(?:\d{4}[\/\-.年]\s*\d{1,2}[\/\-.月]\s*\d{1,2}日?(?:\s+\d{1,2}[:：]\d{2})?\s*(?:-|～|〜|から|より)\s*)?(\d{4}[\/\-.年]\s*\d{1,2}[\/\-.月]\s*\d{1,2}日?(?:\s+\d{1,2}[:：]\d{2})?)/,
    /(?:利用期間|利用可能期間|公開期間|受付期間|提出期間|実施期間|回答期間)[:：]?\s*(?:\d{1,2}[\/月]\s*\d{1,2}日?(?:\s+\d{1,2}[:：]\d{2})?\s*(?:-|～|〜|から|より)\s*)?(\d{1,2}[\/月]\s*\d{1,2}日?(?:\s+\d{1,2}[:：]\d{2})?)/,
    /(?:締切|期限|提出期限|終了日時|終了日|受付終了)[:：]?\s*(\d{4}[\/\-.年]\s*\d{1,2}[\/\-.月]\s*\d{1,2}日?(?:\s+\d{1,2}[:：]\d{2})?)/,
    /(?:締切|期限|提出期限|終了日時|終了日|受付終了)[:：]?\s*(\d{1,2}[\/月]\s*\d{1,2}日?(?:\s+\d{1,2}[:：]\d{2})?)/,
    /(\d{4}[\/\-.年]\s*\d{1,2}[\/\-.月]\s*\d{1,2}日?\s+\d{1,2}[:：]\d{2})/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return normalizeText(match[1]);
    }
  }
  return null;
}

function pickDeadlineAt($, element, deadlineText, now) {
  const endDate = Number($(element).attr('data-end-date'));
  if (Number.isFinite(endDate) && endDate > 0) {
    return new Date(endDate * 1000).toISOString();
  }
  return parseDeadline(deadlineText, now);
}

function parseDeadline(value, now = new Date()) {
  if (!value) {
    return null;
  }

  const normalized = value
    .replace(/年|月/g, '/')
    .replace(/日/g, '')
    .replace(/[.-]/g, '/')
    .replace('：', ':')
    .replace(/\s+/g, ' ')
    .trim();

  const full = normalized.match(/^(\d{4})\/\s*(\d{1,2})\/\s*(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (full) {
    return toLocalIso(full[1], full[2], full[3], full[4], full[5]);
  }

  const partial = normalized.match(/^(\d{1,2})\/\s*(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (partial) {
    return closestYearIso(now, partial[1], partial[2], partial[3], partial[4]);
  }

  return null;
}

// A date without a year belongs to whichever of last/this/next year is closest to now,
// so "1/10" read in December is next January and "12/25" read in January is last December.
function closestYearIso(now, month, day, hour, minute) {
  const year = now.getFullYear();
  const candidates = [year - 1, year, year + 1]
    .map((candidateYear) => toLocalIso(candidateYear, month, day, hour, minute))
    .filter(Boolean);
  if (candidates.length === 0) {
    return null;
  }

  const distance = (iso) => Math.abs(new Date(iso).getTime() - now.getTime());
  return candidates.reduce((best, iso) => (distance(iso) < distance(best) ? iso : best));
}

function toLocalIso(year, month, day, hour = '23', minute = '59') {
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatLocalDeadline(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function isExpired(deadlineAt, now) {
  if (!deadlineAt) {
    return true;
  }
  const deadline = new Date(deadlineAt);
  return Number.isNaN(deadline.getTime()) || deadline.getTime() < now.getTime();
}

function pickStatus($, element, text) {
  const match = text.match(/(未提出|提出済|受付中|終了|未受験|受験済)/);
  if (match) {
    return match[1];
  }

  const executionCount = Number($(element).attr('data-exec-count'));
  if (Number.isFinite(executionCount) && executionCount === 0) {
    return '未提出';
  }

  return null;
}

function normalizeCourseName(value) {
  return cleanCourseName(value)
    .replace(/[（(]\s*[月火水木金土日]\s*(?:曜)?\s*[0-9０-９一二三四五六七八九十]*\s*(?:限|時限)?\s*[）)]/g, '')
    .replace(/[月火水木金土日]\s*(?:曜)?\s*[0-9０-９一二三四五六七八九十]+\s*(?:限|時限)/g, '')
    .replace(/\s+/g, '');
}

function cleanCourseName(value) {
  return normalizeText(value)
    .replace(/^»\s*/, '')
    .replace(/^20\d{2}\s+[A-Z0-9]+-[0-9]+\s+/, '')
    .replace(/締切が近い課題があります。?$/, '')
    .replace(/\s+([0-9０-９])$/, '$1')
    .trim();
}

function normalizeTitle(value) {
  return stripNewBadge(normalizeText(value.normalize('NFKC')))
    .replace(/[ 　]/g, '')
    .replace(/[第１1]回/g, '第一回')
    .replace(/[第２2]回/g, '第二回')
    .replace(/[第３3]回/g, '第三回');
}

function pickSourceId(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.searchParams.get('set_contents_id') ||
      parsed.pathname.match(/\/contents\/([^/]+)/)?.[1] ||
      null
    );
  } catch {
    return null;
  }
}

function deadlineTime(assignment) {
  const time = assignment.deadlineAt ? new Date(assignment.deadlineAt).getTime() : NaN;
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}
