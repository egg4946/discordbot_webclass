import test from 'node:test';
import assert from 'node:assert/strict';
import { courseColor } from '../src/discord.js';
import { toDiscordPayload } from '../src/notification-payload.js';
import { notificationDestination } from '../src/notification-routing.js';

test('due-today unsubmitted notifications go only to the owner DM', () => {
  assert.equal(
    notificationDestination({ type: 'dueTodayUnsubmitted' }),
    'ownerDm',
  );
});

test('other automatic notifications remain in the shared channel', () => {
  for (const type of ['newAssignment', 'deadlineChanged', 'deadlineSoon']) {
    assert.equal(notificationDestination({ type }), 'channel');
  }
});

test('deadline-soon embed does not expose submission status', () => {
  const assignment = {
      courseName: '通信ネットワーク基礎2',
      title: '第1回課題',
      deadlineText: '2026/06/10 23:59',
      status: '未提出',
      sourceText: '未提出',
  };
  const [embed] = toDiscordPayload({ type: 'deadlineSoon', assignment }).embeds;

  const visibleText = [
    embed.title,
    embed.description,
    ...embed.fields.flatMap((field) => [field.name, field.value]),
  ].join(' ');

  assert.doesNotMatch(visibleText, /未提出|提出済|未受験|受験済/);
  assert.match(embed.title, /^🔴/);
  assert.equal(embed.color, courseColor(assignment.courseName));
});

test('course colors are stable and differ between courses', () => {
  assert.equal(
    courseColor('通信ネットワーク基礎2'),
    courseColor('通信ネットワーク基礎2'),
  );
  assert.notEqual(
    courseColor('通信ネットワーク基礎2'),
    courseColor('科学技術論B'),
  );
});
