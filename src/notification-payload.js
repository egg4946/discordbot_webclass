import { assignmentEmbed, courseColor } from './discord.js';

export function toDiscordPayload(notification) {
  const { assignment } = notification;

  if (notification.type === 'newAssignment') {
    return {
      embeds: [
        assignmentEmbed('新しい課題が追加されました', '**新規課題**', assignment),
      ],
    };
  }

  if (notification.type === 'deadlineChanged') {
    return {
      embeds: [
        {
          title: '課題の提出期限が変更されました',
          description: '**締切変更**',
          color: courseColor(assignment.courseName),
          fields: [
            { name: '授業', value: assignment.courseName || '不明' },
            { name: '課題名', value: assignment.title || '不明' },
            {
              name: '変更点',
              value: `~~${notification.previousDeadlineText}~~ → **${assignment.deadlineText || '不明'}**`,
            },
          ],
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  if (notification.type === 'deadlineSoon') {
    return {
      embeds: [
        assignmentEmbed(
          '🔴 課題の提出期限まで24時間を切りました',
          '**締切まで24時間以内**',
          assignment,
        ),
      ],
    };
  }

  if (notification.type === 'dueTodayUnsubmitted') {
    return {
      embeds: [
        assignmentEmbed(
          '本日締切の未提出課題があります',
          '**未提出・本日締切**',
          assignment,
        ),
      ],
    };
  }

  throw new Error(`Unknown notification type: ${notification.type}`);
}
