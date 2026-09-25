import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeAssignments,
  buildNotifications,
  buildStateAfterSending,
  carryOverUnfetchedAssignments,
} from '../src/state.js';

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

test('reminders already sent under a legacy stableKey are not sent again', () => {
  const deadlineKey = '2026-06-10T14:59:00.000Z';
  const previous = assignment({
    stableKey: 'old-title-key',
    url: 'https://webclass.nanzan-u.ac.jp/webclass/do_contents.php?set_contents_id=same-task',
  });
  const current = assignment({ stableKey: 'new-title-key', sourceId: 'same-task' });
  const result = buildNotifications(
    {
      assignments: [previous],
      notified: {
        [`old-title-key:${deadlineKey}:deadline24`]: '2026-06-09T20:00:00.000Z',
        [`old-title-key:${deadlineKey}:dueToday`]: '2026-06-09T20:00:00.000Z',
      },
    },
    [current],
    new Date('2026-06-10T00:00:00.000Z'),
  );

  assert.deepEqual(result.notifications, []);
});

test('a new content with the same title as an existing one is still announced', () => {
  const existing = assignment({ sourceId: 'task-a', deadlineAt: '2026-06-15T14:59:00.000Z' });
  const added = assignment({ sourceId: 'task-b', deadlineAt: '2026-06-20T14:59:00.000Z' });
  const result = buildNotifications(
    { assignments: [existing], notified: {} },
    [existing, added],
    new Date('2026-06-09T00:00:00.000Z'),
  );

  assert.deepEqual(result.notifications.map((item) => [item.type, item.assignment.sourceId]), [
    ['newAssignment', 'task-b'],
  ]);
});

test('a failed send keeps undelivered notifications detectable on the next run', () => {
  const now = new Date('2026-06-10T00:00:00.000Z');
  const reminded = assignment({ stableKey: 'reminded', sourceId: 'reminded' });
  const added = assignment({ stableKey: 'added', sourceId: 'added', title: '第2回課題' });
  const previousState = { assignments: [reminded], notified: {} };
  const fetched = [reminded, added];
  const { notifications } = buildNotifications(previousState, fetched, now);

  assert.deepEqual(notifications.map((item) => item.type), [
    'dueTodayUnsubmitted',
    'deadlineSoon',
    'newAssignment',
  ]);

  // Only the first notification was delivered before Discord failed.
  const saved = buildStateAfterSending(previousState, fetched, notifications, 1);
  const retry = buildNotifications({ ...saved, isFirstRun: false }, fetched, now);

  assert.deepEqual(retry.notifications.map((item) => item.type), [
    'deadlineSoon',
    'newAssignment',
  ]);
});

test('an undelivered deadline change is detected again on the next run', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const previous = assignment({ sourceId: 'task', deadlineAt: '2026-06-12T14:59:00.000Z' });
  const current = assignment({ sourceId: 'task', deadlineAt: '2026-06-13T14:59:00.000Z' });
  const previousState = { assignments: [previous], notified: {} };
  const { notifications } = buildNotifications(previousState, [current], now);

  const saved = buildStateAfterSending(previousState, [current], notifications, 0);
  const retry = buildNotifications(saved, [current], now);

  assert.deepEqual(retry.notifications.map((item) => item.type), ['deadlineChanged']);
});

test('assignments of unreadable courses are carried over and not re-announced', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const readable = assignment({ sourceId: 'a', courseName: '科学技術論B' });
  const unreadable = assignment({ sourceId: 'b', courseName: '統計学概論2' });
  const expired = assignment({
    sourceId: 'c',
    courseName: '統計学概論2',
    deadlineAt: '2026-05-01T14:59:00.000Z',
  });

  const carried = carryOverUnfetchedAssignments([readable, unreadable, expired], [readable], now);
  assert.deepEqual(carried, [unreadable]);

  const nextRun = buildNotifications(
    { assignments: [readable, ...carried], notified: {} },
    [readable, unreadable],
    now,
  );
  assert.deepEqual(nextRun.notifications, []);
});

test('bot commands only list assignments whose deadline has not passed', () => {
  const now = new Date('2026-06-10T00:00:00.000Z');
  const upcoming = assignment({ sourceId: 'upcoming' });
  const passed = assignment({ sourceId: 'passed', deadlineAt: '2026-06-09T14:59:00.000Z' });
  const broken = assignment({ sourceId: 'broken', deadlineAt: null });

  assert.deepEqual(activeAssignments([upcoming, passed, broken], now), [upcoming]);
});
