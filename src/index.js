import { loadConfig } from './config.js';
import { assignmentEmbed, sendDiscordMessage } from './discord.js';
import { buildNotifications, loadState, saveState } from './state.js';
import { fetchAssignments } from './webclass.js';

const STATE_PATH = 'data/state.json';

async function main() {
  const config = loadConfig();
  const previousState = await loadState(STATE_PATH);
  const assignments = await fetchAssignments(config);
  const { notifications, notified, firstRun } = buildNotifications(previousState, assignments);

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

  console.log(
    `Done. assignments=${assignments.length} notifications=${
      notifications.length + (firstRun ? 1 : 0)
    }`,
  );
}

function toDiscordPayload(notification) {
  const { assignment } = notification;

  if (notification.type === 'newAssignment') {
    return {
      embeds: [
        assignmentEmbed(
          '新しいWebClass課題を検出しました',
          assignment.title,
          assignment,
          0x2f80ed,
        ),
      ],
    };
  }

  if (notification.type === 'deadlineSoon') {
    return {
      embeds: [
        assignmentEmbed(
          `WebClass課題の締切${notification.threshold}時間前です`,
          assignment.title,
          assignment,
          0xeb5757,
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
