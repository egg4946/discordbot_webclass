import { loadConfig } from './config.js';
import {
  resolveDiscordOwnerUserId,
  sendDiscordDm,
  sendDiscordMessage,
} from './discord.js';
import { fetchAssignmentsWithRetry } from './fetch-with-retry.js';
import { initializeLogger } from './logger.js';
import { toDiscordPayload } from './notification-payload.js';
import { notificationDestination } from './notification-routing.js';
import { acquireRunLock } from './run-lock.js';
import {
  loadRuntimeStatus,
  markAttempt,
  markFailure,
  markSuccess,
  saveRuntimeStatus,
  shouldNotifyFailure,
  shouldNotifyRecovery,
} from './runtime-status.js';
import {
  buildNotifications,
  buildStateAfterSending,
  carryOverUnfetchedAssignments,
  loadState,
  saveState,
  STATE_PATH,
} from './state.js';
import { fetchAssignmentSnapshot } from './webclass.js';

const RUNTIME_STATUS_PATH = 'data/runtime-status.json';
const LOCK_PATH = 'data/check.lock';

async function main() {
  const config = loadConfig();
  initializeLogger('check', config.logRetentionDays);
  const releaseLock = await acquireRunLock(LOCK_PATH);

  if (!releaseLock) {
    console.warn('Another WebClass check is already running. This run was skipped.');
    return;
  }

  let runtimeStatus = markAttempt(await loadRuntimeStatus(RUNTIME_STATUS_PATH));
  const previousConsecutiveFailures = runtimeStatus.consecutiveFailures ?? 0;
  await saveRuntimeStatus(RUNTIME_STATUS_PATH, runtimeStatus);

  const recordFailure = async (error) => {
    runtimeStatus = markFailure(runtimeStatus, error);
    await saveRuntimeStatus(RUNTIME_STATUS_PATH, runtimeStatus);
    console.error(error);

    if (shouldNotifyFailure(runtimeStatus)) {
      await sendFailureNotification(config, runtimeStatus).catch((notificationError) => {
        console.error('Failed to send WebClass error notification:', notificationError);
      });
    }
  };

  // A hung browser or network call must not keep the lock forever, so the whole
  // check is aborted after the configured time.
  const watchdog = setTimeout(async () => {
    // Exit even if recording the failure itself hangs.
    setTimeout(() => process.exit(1), 60000).unref();
    try {
      await recordFailure(
        new Error(`WebClass check timed out after ${config.checkTimeoutMinutes} minutes.`),
      );
    } finally {
      await releaseLock().catch(() => undefined);
      process.exit(1);
    }
  }, config.checkTimeoutMinutes * 60 * 1000);
  watchdog.unref();

  try {
    const previousState = await loadState(STATE_PATH);
    const { assignments, failedUrls } = await fetchAssignmentsWithRetry(config, {
      fetcher: fetchAssignmentSnapshot,
    });
    const { notifications, firstRun } = buildNotifications(previousState, assignments);
    const carriedAssignments = failedUrls.length
      ? carryOverUnfetchedAssignments(previousState.assignments, assignments)
      : [];

    if (failedUrls.length) {
      console.warn(
        `Could not read ${failedUrls.length} WebClass page(s); kept ${carriedAssignments.length} previous assignment(s).`,
      );
    }

    if (firstRun) {
      await sendDiscordMessage(config, {
        content: `WebClass通知Botの初回同期が完了しました。課題候補 ${assignments.length} 件を記録しました。`,
      });
    }

    // Save after every delivery so a failure or crash midway never re-sends earlier notices.
    const saveProgress = (sentCount) => {
      const state = buildStateAfterSending(previousState, assignments, notifications, sentCount);
      return saveState(STATE_PATH, {
        assignments: [...state.assignments, ...carriedAssignments],
        notified: state.notified,
      });
    };

    for (const [index, notification] of notifications.entries()) {
      const payload = toDiscordPayload(notification);
      try {
        if (notificationDestination(notification) === 'ownerDm') {
          const ownerUserId = await resolveDiscordOwnerUserId(config);
          await sendDiscordDm(config, ownerUserId, payload);
        } else {
          await sendDiscordMessage(config, payload);
        }
      } catch (error) {
        await saveProgress(index);
        throw error;
      }
      await saveProgress(index + 1);
    }

    await saveProgress(notifications.length);

    const notificationCount = notifications.length + (firstRun ? 1 : 0);
    runtimeStatus = markSuccess(
      runtimeStatus,
      assignments.length,
      notificationCount,
    );
    await saveRuntimeStatus(RUNTIME_STATUS_PATH, runtimeStatus);

    if (shouldNotifyRecovery(previousConsecutiveFailures)) {
      await sendRecoveryNotification(config, previousConsecutiveFailures).catch(
        (notificationError) => {
          console.error('Failed to send WebClass recovery notification:', notificationError);
        },
      );
    }

    console.log(
      `Done. assignments=${assignments.length} notifications=${notificationCount}`,
    );
  } catch (error) {
    await recordFailure(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    await releaseLock();
  }
}

async function sendRecoveryNotification(config, failureCount) {
  await sendDiscordMessage(config, {
    embeds: [
      {
        title: 'WebClassの自動取得が復旧しました',
        description: `**${failureCount}回連続失敗の後、正常に取得できました**`,
        color: 0x27ae60,
        timestamp: new Date().toISOString(),
      },
    ],
  });
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
