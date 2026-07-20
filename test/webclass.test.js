import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAssignments } from '../src/webclass.js';

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
