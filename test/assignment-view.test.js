import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAssignmentListEmbeds,
  sortAssignmentsByDeadline,
} from '../src/assignment-view.js';

test('sorts assignments by deadline', () => {
  const sorted = sortAssignmentsByDeadline([
    { title: 'later', deadlineAt: '2026-06-12T00:00:00Z' },
    { title: 'first', deadlineAt: '2026-06-10T00:00:00Z' },
    { title: 'unknown', deadlineAt: null },
  ]);

  assert.deepEqual(sorted.map((item) => item.title), ['first', 'later', 'unknown']);
});

test('assignment list displays course, title, deadline, then unsubmitted status', () => {
  const [embed] = buildAssignmentListEmbeds(
    [
      {
        courseName: '通信ネットワーク基礎2',
        title: '第1回課題',
        deadlineText: '2026/06/14 23:59',
        deadlineAt: '2026-06-14T14:59:00Z',
        status: '未提出',
      },
    ],
    '課題',
    'なし',
  );

  assert.match(
    embed.description,
    /授業: 通信ネットワーク基礎2.*課題名: 第1回課題.*提出期限: 2026\/06\/14 23:59.*未提出/s,
  );
});
