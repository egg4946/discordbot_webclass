import {
  ApplicationCommandOptionType,
  Client,
  GatewayIntentBits,
} from 'discord.js';
import {
  buildAssignmentListEmbeds,
  isUnsubmittedAssignment,
  sortAssignmentsByDeadline,
} from './assignment-view.js';
import { loadConfig } from './config.js';
import { fetchAssignmentsWithRetry } from './fetch-with-retry.js';
import { initializeLogger } from './logger.js';
import { loadRuntimeStatus } from './runtime-status.js';

const RUNTIME_STATUS_PATH = 'data/runtime-status.json';
const startedAt = new Date();
let activeFetch = null;

const COMMANDS = [
  {
    name: 'webclass-all',
    description: '現在WebClassで検出できる課題を期限順で表示します',
    options: [
      {
        type: ApplicationCommandOptionType.Boolean,
        name: 'include-submitted',
        description: '提出済みの課題も表示します（省略時: 表示する）',
        required: false,
      },
    ],
  },
  {
    name: 'webclass-unsubmitted',
    description: 'WebClassで未提出または未受験と判定できる課題を表示します',
  },
  {
    name: 'webclass-next',
    description: '提出期限が最も近い未提出課題を表示します',
  },
  {
    name: 'webclass-status',
    description: 'WebClass自動巡回の稼働状態を表示します',
  },
];

async function main() {
  const config = loadConfig();
  initializeLogger('bot', config.logRetentionDays);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('clientReady', async () => {
    await registerCommands(client, config);
    console.log(`Logged in as ${client.user.tag}`);
    console.log(
      'Commands: /webclass-all, /webclass-unsubmitted, /webclass-next, /webclass-status',
    );
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!COMMANDS.some((command) => command.name === interaction.commandName)) {
      return;
    }

    await interaction.deferReply();

    try {
      if (interaction.commandName === 'webclass-status') {
        await interaction.editReply({
          embeds: [await buildStatusEmbed()],
        });
        return;
      }

      const assignments = await getAssignments(config);
      await respondWithAssignments(interaction, assignments);
    } catch (error) {
      console.error(error);
      await interaction.editReply(
        'WebClassの取得中にエラーが発生しました。再試行にも失敗したため、しばらくしてから試してください。',
      );
    }
  });

  await client.login(config.discordBotToken);
}

async function getAssignments(config) {
  if (!activeFetch) {
    activeFetch = fetchAssignmentsWithRetry(config).finally(() => {
      activeFetch = null;
    });
  }
  return activeFetch;
}

async function respondWithAssignments(interaction, assignments) {
  if (interaction.commandName === 'webclass-next') {
    const nextAssignment = sortAssignmentsByDeadline(
      assignments.filter(isUnsubmittedAssignment),
    )[0];
    const embeds = buildAssignmentListEmbeds(
      nextAssignment ? [nextAssignment] : [],
      '提出期限が最も近い未提出課題',
      '現在、未提出と判定できる課題はありません。',
    );
    await sendPagedEmbeds(interaction, embeds);
    return;
  }

  const showOnlyUnsubmitted = interaction.commandName === 'webclass-unsubmitted';
  const includeSubmitted =
    interaction.commandName === 'webclass-all'
      ? (interaction.options.getBoolean('include-submitted') ?? true)
      : false;
  const filteredAssignments =
    showOnlyUnsubmitted || !includeSubmitted
      ? assignments.filter(isUnsubmittedAssignment)
      : assignments;

  const embeds = buildAssignmentListEmbeds(
    filteredAssignments,
    showOnlyUnsubmitted || !includeSubmitted
      ? `未提出のWebClass課題 (${filteredAssignments.length}件)`
      : `現在のWebClass課題 (${filteredAssignments.length}件)`,
    showOnlyUnsubmitted || !includeSubmitted
      ? '未提出または未受験と判定できる課題は見つかりませんでした。'
      : '課題は見つかりませんでした。',
  );

  await sendPagedEmbeds(interaction, embeds);
}

async function buildStatusEmbed() {
  const status = await loadRuntimeStatus(RUNTIME_STATUS_PATH);
  const healthy = status.consecutiveFailures === 0 && Boolean(status.lastSuccessAt);

  return {
    title: 'WebClass Bot 稼働状態',
    color: healthy ? 0x27ae60 : 0xf2994a,
    fields: [
      { name: 'Bot起動時刻', value: discordTime(startedAt), inline: false },
      {
        name: '最終巡回',
        value: status.lastAttemptAt ? discordTime(status.lastAttemptAt) : '記録なし',
        inline: false,
      },
      {
        name: '最終成功',
        value: status.lastSuccessAt ? discordTime(status.lastSuccessAt) : '記録なし',
        inline: false,
      },
      {
        name: '連続失敗',
        value: `${status.consecutiveFailures ?? 0}回`,
        inline: true,
      },
      {
        name: '最終取得件数',
        value:
          status.assignmentCount === null ? '記録なし' : `${status.assignmentCount}件`,
        inline: true,
      },
      {
        name: '直近の通知数',
        value:
          status.notificationCount === null
            ? '記録なし'
            : `${status.notificationCount}件`,
        inline: true,
      },
      ...(status.lastError
        ? [{ name: '最終エラー', value: truncate(status.lastError, 1000), inline: false }]
        : []),
    ],
    timestamp: new Date().toISOString(),
  };
}

function discordTime(value) {
  const timestamp = Math.floor(new Date(value).getTime() / 1000);
  return `<t:${timestamp}:F> (<t:${timestamp}:R>)`;
}

function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

async function sendPagedEmbeds(interaction, embeds) {
  const [firstEmbed, ...restEmbeds] = embeds;
  await interaction.editReply({ embeds: [firstEmbed] });

  for (const embed of restEmbeds) {
    await interaction.followUp({ embeds: [embed] });
  }
}

async function registerCommands(client, config) {
  if (process.env.DISCORD_GUILD_ID) {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    await guild.commands.set(COMMANDS);
    console.log(`Registered guild commands for ${guild.name}`);
    return;
  }

  const channel = await client.channels.fetch(config.discordChannelId);
  if (channel?.guild) {
    await channel.guild.commands.set(COMMANDS);
    console.log(`Registered guild commands for ${channel.guild.name}`);
    return;
  }

  await client.application.commands.set(COMMANDS);
  console.log('Registered global commands');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
