import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotifications } from '../src/state.js';

function assignment(overrides = {}) {
  return {
    id: 'assignment-v1',
    stableKey: 'course-task',
    courseName: '通信ネットワーク基礎2',
    title: '第1回課題',
    deadlineText: '2026/06/10 23:59',
    deadlineAt: '2026-06-10T14:59:00.000Z',
    status: '未提出',
    ...overrides,
  };
}

test('notifies when a new assignment is added', () => {
  const result = buildNotifications(
    { assignments: [], notified: {} },
    [assignment({ deadlineAt: '2026-06-15T14:59:00.000Z' })],
    new Date('2026-06-09T00:00:00.000Z'),
  );

  assert.deepEqual(result.notifications.map((item) => item.type), ['newAssignment']);
});

test('new assignment suppresses 24-hour and due-today reminders', () => {
  const now = new Date('2026-06-10T00:00:00.000Z');
  const current = assignment();
  const first = buildNotifications({ assignments: [], notified: {} }, [current], now);

  assert.deepEqual(first.notifications.map((item) => item.type), ['newAssignment']);

  const second = buildNotifications(
    { assignments: [current], notified: first.notified },
    [current],
    new Date('2026-06-10T03:00:00.000Z'),
  );
  assert.deepEqual(second.notifications, []);
});

test('notifies with the old deadline when a deadline changes', () => {
  const previous = assignment({
    id: 'assignment-old',
    deadlineText: '2026/06/12 23:59',
    deadlineAt: '2026-06-12T14:59:00.000Z',
  });
  const current = assignment({
    id: 'assignment-new',
    deadlineText: '2026/06/13 23:59',
    deadlineAt: '2026-06-13T14:59:00.000Z',
  });
  const result = buildNotifications(
    { assignments: [previous], notified: {} },
    [current],
    new Date('2026-06-09T00:00:00.000Z'),
  );

  assert.equal(result.notifications[0].type, 'deadlineChanged');
  assert.equal(result.notifications[0].previousDeadlineText, '2026/06/12 23:59');
});

test('notifies when a deadline is within 24 hours but not today in Tokyo', () => {
  const current = assignment({
    deadlineText: '2026/06/11 10:00',
    deadlineAt: '2026-06-11T01:00:00.000Z',
    status: null,
  });
  const result = buildNotifications(
    { assignments: [current], notified: {} },
    [current],
    new Date('2026-06-10T03:00:00.000Z'),
  );

  assert.deepEqual(result.notifications.map((item) => item.type), ['deadlineSoon']);
});

test('due-today DM and shared 24-hour notification are both sent', () => {
  const current = assignment();
  const result = buildNotifications(
    { assignments: [current], notified: {} },
    [current],
    new Date('2026-06-10T00:00:00.000Z'),
  );

  assert.deepEqual(result.notifications.map((item) => item.type), [
    'dueTodayUnsubmitted',
    'deadlineSoon',
  ]);
});

test('matches an older state entry by WebClass content ID when its title changed', () => {
  const previous = assignment({
    stableKey: 'old-title-key',
    title: 'New',
    url: 'https://webclass.nanzan-u.ac.jp/webclass/do_contents.php?set_contents_id=same-task',
  });
  const current = assignment({
    stableKey: 'real-title-key',
    title: '第1回課題',
    sourceId: 'same-task',
  });
  const result = buildNotifications(
    { assignments: [previous], notified: {} },
    [current],
    new Date('2026-06-09T00:00:00.000Z'),
  );

  assert.deepEqual(result.notifications, []);
});

test('does not send a due-today notification for a submitted assignment', () => {
  const current = assignment({ status: null });
  const result = buildNotifications(
    { assignments: [current], notified: {} },
    [current],
    new Date('2026-06-10T00:00:00.000Z'),
  );

  assert.deepEqual(result.notifications.map((item) => item.type), ['deadlineSoon']);
});
