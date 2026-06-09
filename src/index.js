import { loadConfig } from './config.js';
import { assignmentEmbed, sendDiscordMessage } from './discord.js';
import { fetchAssignmentsWithRetry } from './fetch-with-retry.js';
import { initializeLogger } from './logger.js';
import { acquireRunLock } from './run-lock.js';
import {
  loadRuntimeStatus,
  markAttempt,
  markFailure,
  markSuccess,
  saveRuntimeStatus,
} from './runtime-status.js';
import { buildNotifications, loadState, saveState } from './state.js';

const STATE_PATH = 'data/state.json';
const RUNTIME_STATUS_PATH = 'data/runtime-status.json';
const LOCK_PATH = 'data/check.lock';
const ERROR_NOTIFICATION_THRESHOLD = 3;

async function main() {
  const config = loadConfig();
  initializeLogger('check', config.logRetentionDays);
  const releaseLock = await acquireRunLock(LOCK_PATH);

  if (!releaseLock) {
    console.warn('Another WebClass check is already running. This run was skipped.');
    return;
  }

  let runtimeStatus = markAttempt(await loadRuntimeStatus(RUNTIME_STATUS_PATH));
  await saveRuntimeStatus(RUNTIME_STATUS_PATH, runtimeStatus);

  try {
    const previousState = await loadState(STATE_PATH);
    const assignments = await fetchAssignmentsWithRetry(config);
    const { notifications, notified, firstRun } = buildNotifications(
      previousState,
      assignments,
    );

    if (firstRun) {
      await sendDiscordMessage(config, {
        content: `WebClass通知Botの初回同期が完了しました。課題候補 ${assignments.length} 件を記録しました。`,
      });
    }

    for (const notification of notifications) {
      await sendDiscordMessage(config, toDiscordPayload(notification));
    }

    await saveState(STATE_PATH, {
      assignments,
      notified,
    });

    const notificationCount = notifications.length + (firstRun ? 1 : 0);
    runtimeStatus = markSuccess(
      runtimeStatus,
      assignments.length,
      notificationCount,
    );
    await saveRuntimeStatus(RUNTIME_STATUS_PATH, runtimeStatus);

    console.log(
      `Done. assignments=${assignments.length} notifications=${notificationCount}`,
    );
  } catch (error) {
    runtimeStatus = markFailure(runtimeStatus, error);
    await saveRuntimeStatus(RUNTIME_STATUS_PATH, runtimeStatus);
    console.error(error);

    if (runtimeStatus.consecutiveFailures === ERROR_NOTIFICATION_THRESHOLD) {
      await sendFailureNotification(config, runtimeStatus).catch((notificationError) => {
        console.error('Failed to send WebClass error notification:', notificationError);
      });
    }

    process.exitCode = 1;
  } finally {
    await releaseLock();
  }
}

async function sendFailureNotification(config, runtimeStatus) {
  await sendDiscordMessage(config, {
    embeds: [
      {
        title: 'WebClassの自動取得に連続で失敗しています',
        description: `**${runtimeStatus.consecutiveFailures}回連続失敗**`,
        color: 0xc0392b,
        fields: [
          {
            name: '最終エラー',
            value: truncate(runtimeStatus.lastError || '不明なエラー', 1000),
          },
          {
            name: '最終成功',
            value: runtimeStatus.lastSuccessAt || '成功記録なし',
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function toDiscordPayload(notification) {
  const { assignment } = notification;

  if (notification.type === 'newAssignment') {
    return {
      embeds: [
        assignmentEmbed('新しい課題が追加されました', '**新規課題**', assignment, 0x2f80ed),
      ],
    };
  }

  if (notification.type === 'deadlineChanged') {
    return {
      embeds: [
        {
          title: '課題の提出期限が変更されました',
          description: '**締切変更**',
          color: 0xf2994a,
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
          '課題の提出期限まで24時間を切りました',
          '**締切まで24時間以内**',
          assignment,
          0xeb5757,
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
          0xc0392b,
        ),
      ],
    };
  }

  throw new Error(`Unknown notification type: ${notification.type}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
