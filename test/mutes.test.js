import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  addMutedCourse,
  courseChoices,
  isMutedCourse,
  loadMutedCourses,
  partitionMutedNotifications,
  removeMutedCourse,
  resolveCourseInput,
  saveMutedCourses,
  uniqueCourseNames,
} from '../src/mutes.js';
import { buildNotifications, buildStateAfterSending } from '../src/state.js';

function assignment(overrides = {}) {
  return {
    stableKey: 'course-task',
    courseName: '通信ネットワーク基礎2',
    title: '第1回課題',
    deadlineText: '2026/06/10 23:59',
    deadlineAt: '2026-06-10T14:59:00.000Z',
    status: '未提出',
    ...overrides,
  };
}

test('course names match regardless of width and spacing', () => {
  assert.equal(isMutedCourse(['通信ネットワーク基礎２'], '通信 ネットワーク基礎2'), true);
  assert.equal(isMutedCourse(['通信ネットワーク基礎2'], '科学技術論B'), false);
  assert.equal(isMutedCourse(['通信ネットワーク基礎2'], ''), false);
});

test('muting and unmuting report whether anything changed', () => {
  const added = addMutedCourse([], '科学技術論B');
  assert.deepEqual(added, { courses: ['科学技術論B'], changed: true });
  assert.equal(addMutedCourse(added.courses, '科学技術論Ｂ').changed, false);

  assert.deepEqual(removeMutedCourse(added.courses, '科学技術論B'), { courses: [], changed: true });
  assert.equal(removeMutedCourse([], '科学技術論B').changed, false);
});

test('muted courses are saved and loaded, and a missing file means no mutes', async () => {
  const directory = join('data', 'test-mutes');
  const path = join(directory, 'mutes.json');
  await rm(directory, { recursive: true, force: true });

  assert.deepEqual(await loadMutedCourses(path), []);
  await saveMutedCourses(path, ['科学技術論B']);
  assert.deepEqual(await loadMutedCourses(path), ['科学技術論B']);
  await rm(directory, { recursive: true, force: true });
});

test('muted notifications are not replayed on the next run or after unmuting', () => {
  const now = new Date('2026-06-10T00:00:00.000Z');
  const mutedTask = assignment({ sourceId: 'muted', courseName: '科学技術論B' });
  const activeTask = assignment({ sourceId: 'active' });
  const previousState = { assignments: [], notified: {} };
  const fetched = [mutedTask, activeTask];

  const built = buildNotifications(previousState, fetched, now);
  const { muted, active } = partitionMutedNotifications(built.notifications, ['科学技術論B']);
  assert.deepEqual(muted.map((item) => item.assignment.sourceId), ['muted']);
  assert.deepEqual(active.map((item) => item.assignment.sourceId), ['active']);

  // Only the muted ones count as delivered, as if sending the active one failed.
  const ordered = [...muted, ...active];
  const saved = buildStateAfterSending(previousState, fetched, ordered, muted.length);

  // Even with no mutes any more, the muted course is not announced again.
  const nextRun = buildNotifications(saved, fetched, now);
  assert.deepEqual(nextRun.notifications.map((item) => item.assignment.sourceId), ['active']);
});

test('autocomplete choices are unique, filtered, and within Discord limits', () => {
  const names = uniqueCourseNames([
    assignment({ courseName: '統計学概論2' }),
    assignment({ courseName: '統計学概論２' }),
    assignment({ courseName: '科学技術論B' }),
    assignment({ courseName: 'あ'.repeat(150) }),
  ]);
  assert.equal(names.length, 3);

  const [statistics] = courseChoices(names, '統計');
  assert.equal(statistics.name, '統計学概論2');
  assert.equal(resolveCourseInput(statistics.value, names).name, '統計学概論2');
  assert.ok(
    courseChoices(names, '').every((choice) => choice.name.length <= 100 && choice.value.length <= 100),
  );

  const many = Array.from({ length: 40 }, (_, index) => `授業${index}`);
  assert.equal(courseChoices(many, '').length, 25);
});

test('a course name longer than 100 characters can be muted and unmuted from its choice', () => {
  const longName = `情報${'あ'.repeat(99)}`;
  assert.equal(longName.length, 101);

  const [muteChoice] = courseChoices([longName, '科学技術論B'], '情報');
  const muteTarget = resolveCourseInput(muteChoice.value, [longName, '科学技術論B']);
  assert.deepEqual(muteTarget, { name: longName, known: true });

  const { courses } = addMutedCourse([], muteTarget.name);
  assert.equal(isMutedCourse(courses, longName), true);

  const [unmuteChoice] = courseChoices(courses, '');
  const unmuteTarget = resolveCourseInput(unmuteChoice.value, courses);
  assert.deepEqual(removeMutedCourse(courses, unmuteTarget.name), { courses: [], changed: true });
});

test('typed course names resolve to the known name, and stale choices resolve to nothing', () => {
  assert.deepEqual(resolveCourseInput('科学技術論Ｂ', ['科学技術論B']), {
    name: '科学技術論B',
    known: true,
  });
  assert.deepEqual(resolveCourseInput('未知の授業', ['科学技術論B']), {
    name: '未知の授業',
    known: false,
  });
  assert.equal(resolveCourseInput('course:0000000000000000', ['科学技術論B']), null);
});
