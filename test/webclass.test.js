import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAssignments, unreadablePageReason } from '../src/webclass.js';

const PAGE_URL = 'https://webclass.nanzan-u.ac.jp/webclass/course.php/example/';
const FUTURE_END_DATE = '4102444740';

function page(items) {
  return `
    <html><body>
      <h1 class="course-name">統計学概論2</h1>
      ${items.join('\n')}
    </body></html>
  `;
}

function content({ title, category, kind, id, badge = '' }) {
  return `
    <div class="cl-contentsList_listGroupItem ${kind}" data-end-date="${FUTURE_END_DATE}">
      ${badge ? `<span class="badge">${badge}</span>` : ''}
      <div class="cm-contentsList_contentName">
        <a href="/webclass/do_contents.php?set_contents_id=${id}">${title}</a>
      </div>
      <span class="cl-contentsList_categoryLabel">${category}</span>
      <span>利用可能期間 2099/12/01 00:00 - 2099/12/31 23:59</span>
      <a href="/webclass/detail.php?id=${id}">詳細</a>
    </div>
  `;
}

test('self-study exercises without an explicit task label are excluded', () => {
  const assignments = extractAssignments(
    page([
      content({
        title: '統計学概論・練習問題（５）（６）',
        category: '自習',
        kind: 'content-kind-selfstudy',
        id: 'practice-5-6',
      }),
    ]),
    PAGE_URL,
  );

  assert.deepEqual(assignments, []);
});

test('New badge is ignored and the real report title is retained', () => {
  const assignments = extractAssignments(
    page([
      content({
        title: '第１２回課題',
        category: 'レポート',
        kind: 'content-kind-report',
        id: 'report-12',
        badge: 'New',
      }),
    ]),
    PAGE_URL,
  );

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].title, '第１２回課題');
  assert.equal(assignments[0].sourceId, 'report-12');
});

test('duplicate course entries produce only one assignment', () => {
  const duplicate = content({
    title: '第１２回課題',
    category: 'レポート',
    kind: 'content-kind-report',
    id: 'report-12',
  });
  const assignments = extractAssignments(page([duplicate, duplicate]), PAGE_URL);

  assert.equal(assignments.length, 1);
});

test('explicitly named tasks remain eligible even when WebClass calls them self-study', () => {
  const assignments = extractAssignments(
    page([
      content({
        title: '第１回課題',
        category: '自習',
        kind: 'content-kind-selfstudy',
        id: 'selfstudy-task-1',
      }),
    ]),
    PAGE_URL,
  );

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].title, '第１回課題');
});

test('titles that merely start with "New" are not truncated', () => {
  const assignments = extractAssignments(
    page([
      content({
        title: 'Newton法レポート',
        category: 'レポート',
        kind: 'content-kind-report',
        id: 'newton-report',
      }),
    ]),
    PAGE_URL,
  );

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].title, 'Newton法レポート');
});

test('different contents sharing a title are kept separately', () => {
  const assignments = extractAssignments(
    page([
      content({
        title: 'レポート課題',
        category: 'レポート',
        kind: 'content-kind-report',
        id: 'report-a',
      }),
      content({
        title: 'レポート課題',
        category: 'レポート',
        kind: 'content-kind-report',
        id: 'report-b',
      }),
    ]),
    PAGE_URL,
  );

  assert.deepEqual(
    assignments.map((item) => item.sourceId).sort(),
    ['report-a', 'report-b'],
  );
});

test('table rows with a plain-text title cell are detected', () => {
  const html = page([
    `<table class="cl-contentsList"><tbody>
      <tr class="content-kind-report">
        <td>第3回レポート</td>
        <td>提出期限 2099/12/31 23:59</td>
        <td><a href="/webclass/do_contents.php?set_contents_id=table-report">詳細</a></td>
      </tr>
    </tbody></table>`,
  ]);
  const assignments = extractAssignments(html, PAGE_URL);

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].title, '第3回レポート');
});

test('a report whose title ends with a UI word such as 作成 is kept', () => {
  const assignments = extractAssignments(
    page([
      content({
        title: '期末レポート作成',
        category: 'レポート',
        kind: 'content-kind-report',
        id: 'final-report',
      }),
    ]),
    PAGE_URL,
  );

  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].title, '期末レポート作成');
});

// Same structure as a real WebClass list item: the attributes sit on the section, the
// period text inside div.cl-contentsList_content, and data-end-date ends at :59 seconds.
const REAL_END_DATE = '1790261999'; // 2026/09/24 23:59:59 JST
const REAL_NOW = new Date('2026-09-20T00:00:00Z');

// `actions` follows the content block, `inside` ends it, `inDetail` joins the 詳細 link and
// `inInfo` ends the title/category/period block: the places an operation link could take.
function listItem({ name, id, execCount, actions = '', inside = '', inDetail = '', inInfo = '', status = '',
  endDate = REAL_END_DATE, period = '2026/09/17 15:30 - 2026/09/24 23:59' }) {
  return `
    <section data-contents-id="${id}" data-contents-name="${name}" data-end-date="${endDate}" data-exec-count="${execCount}" class="list-group-item cl-contentsList_listGroupItem">
      <div class="cl-contentsList_content">
        <div class="cl-contentsList_contentInfo">
          <h4 class="cm-contentsList_contentName">
            <a href="/webclass/do_contents.php?reset_status=1&amp;set_contents_id=${id}">${name}</a>
          </h4>
          <div class="cl-contentsList_categoryLabel">レポート</div>
          ${period ? `<div class="cm-contentsList_contentDetailListItem">
            <div class="cm-contentsList_contentDetailListItemLabel">利用可能期間</div>
            <div class="cm-contentsList_contentDetailListItemData">${period}</div>
          </div>` : ''}
          ${status ? `<div>${status}</div>` : ''}
          ${inInfo}
        </div>
        <div class="cl-contentsList_contentDetail">
          <a href="/webclass/course.php/example/contents/${id}/">詳細</a>
          ${execCount > 0 ? `<div>利用回数 ${execCount}</div>` : ''}
          ${inDetail}
        </div>
        ${inside}
      </div>
      ${actions}
    </section>
  `;
}

test('real list items give one assignment each with the status from data-exec-count', () => {
  const assignments = extractAssignments(
    page([
      listItem({ name: '第1回レポート', id: 'not-opened', execCount: 0 }),
      listItem({ name: '第2回レポート', id: 'opened', execCount: 1 }),
    ]),
    PAGE_URL,
    REAL_NOW,
  );
  const bySourceId = Object.fromEntries(assignments.map((item) => [item.sourceId, item]));

  assert.equal(assignments.length, 2);
  assert.equal(bySourceId['not-opened'].status, '未提出');
  assert.equal(bySourceId.opened.status, null);
  // Floored to the minute so deadlines saved before this change compare as unchanged.
  assert.equal(bySourceId['not-opened'].deadlineAt, '2026-09-24T14:59:00.000Z');
});

test('status words inside the title do not override data-exec-count', () => {
  const [item] = extractAssignments(
    page([listItem({ name: '授業終了後レポート', id: 'after-class', execCount: 0 })]),
    PAGE_URL,
    REAL_NOW,
  );

  assert.equal(item.status, '未提出');
});

// WebClass may show operation links such as マイレポート in a list item. Wherever they sit, the
// item text then ends with a UI word, although the content itself is an assignment.
test('operation links anywhere in a list item keep the assignment and its fields', () => {
  const link = (label) => `<div class="cl-contentsList_contentDetailListItem"><a href="/webclass/course.php/example/my-reports">${label}</a></div>`;
  for (const label of ['マイレポート', 'テスト結果']) {
    for (const place of ['actions', 'inside', 'inDetail', 'inInfo']) {
      const extract = (fields) => extractAssignments(page([listItem({ name: '第3回レポート', id: 'with-link', execCount: 0, [place]: link(label), ...fields })]), PAGE_URL, REAL_NOW);
      const where = `${label} ${place}`;
      const [unsubmitted, ...rest] = extract({});
      assert.equal(rest.length, 0, where);
      assert.equal(unsubmitted?.title, '第3回レポート', where);
      assert.equal(unsubmitted.status, '未提出', where);
      assert.equal(unsubmitted.deadlineAt, '2026-09-24T14:59:00.000Z', where);
      assert.equal(extract({ execCount: 1, status: '提出済' })[0]?.status, '提出済', where);
      // Without a deadline nothing is notified, link or not.
      assert.deepEqual(extract({ endDate: '0', period: '' }), [], where);
    }
  }
});

test('titles that contain an operation word are assignments, a bare operation label is not', () => {
  const titles = ['第2回 テスト結果の分析レポート', 'マイレポートの使い方に関するレポート', '期末レポート作成'];
  const assignments = extractAssignments(
    page([
      ...titles.map((name, index) => listItem({ name, id: `similar-${index}`, execCount: 0 })),
      listItem({ name: 'マイレポート', id: 'bare-label', execCount: 0 }),
    ]),
    PAGE_URL,
    REAL_NOW,
  );

  assert.deepEqual(assignments.map((item) => item.title).sort(), [...titles].sort());
});

function textDeadlinePage(deadline) {
  return page([
    `<div class="cl-contentsList_listGroupItem content-kind-report">
      <div class="cm-contentsList_contentName">
        <a href="/webclass/do_contents.php?set_contents_id=no-year">第5回レポート</a>
      </div>
      <span class="cl-contentsList_categoryLabel">レポート</span>
      <span>提出期限 ${deadline}</span>
    </div>`,
  ]);
}

test('a January deadline without a year read in December belongs to next year', () => {
  const [item] = extractAssignments(
    textDeadlinePage('1/10 23:59'),
    PAGE_URL,
    new Date(2026, 11, 20, 12, 0),
  );

  const deadline = new Date(item.deadlineAt);
  assert.equal(deadline.getFullYear(), 2027);
  assert.equal(deadline.getMonth(), 0);
  assert.equal(deadline.getDate(), 10);
});

test('a December deadline without a year read in January is last year and expired', () => {
  const assignments = extractAssignments(
    textDeadlinePage('12/25 23:59'),
    PAGE_URL,
    new Date(2027, 0, 5, 12, 0),
  );

  assert.deepEqual(assignments, []);
});

test('a deadline without a year later in the same year stays in this year', () => {
  const [item] = extractAssignments(
    textDeadlinePage('10/1 23:59'),
    PAGE_URL,
    new Date(2026, 8, 17, 12, 0),
  );

  assert.equal(new Date(item.deadlineAt).getFullYear(), 2026);
});

test('a normal course page is readable', () => {
  assert.equal(unreadablePageReason(page([])), null);
});

test('error and maintenance pages are treated as unreadable', () => {
  const maintenance = '<html><body><h1>ただいまシステムメンテナンス中です</h1></body></html>';
  const systemError = '<html><body><h2>システムエラーが発生しました</h2></body></html>';
  const blank = '<html><body><p>しばらくしてから再度アクセスしてください。</p></body></html>';

  assert.match(unreadablePageReason(maintenance), /error page/);
  assert.match(unreadablePageReason(systemError), /error page/);
  assert.match(unreadablePageReason(blank), /no course name/);
});

test('a course whose name merely contains "エラー" is still readable', () => {
  const html = '<html><body><h1 class="course-name">エラー訂正符号論</h1></body></html>';
  assert.equal(unreadablePageReason(html), null);
});
