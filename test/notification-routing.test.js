import test from 'node:test';
import assert from 'node:assert/strict';
import { assignmentEmbed } from '../src/discord.js';
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
  const embed = assignmentEmbed(
    '課題の提出期限まで24時間を切りました',
    '**締切まで24時間以内**',
    {
      courseName: '通信ネットワーク基礎2',
      title: '第1回課題',
      deadlineText: '2026/06/10 23:59',
      status: '未提出',
      sourceText: '未提出',
    },
  );

  const visibleText = [
    embed.title,
    embed.description,
    ...embed.fields.flatMap((field) => [field.name, field.value]),
  ].join(' ');

  assert.doesNotMatch(visibleText, /未提出|提出済|未受験|受験済/);
});
