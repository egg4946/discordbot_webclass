import {
  ApplicationCommandOptionType,
  Client,
  GatewayIntentBits,
  MessageFlags,
} from 'discord.js';
import {
  buildAssignmentListEmbeds,
  isUnsubmittedAssignment,
  sortAssignmentsByDeadline,
} from './assignment-view.js';
import { loadConfig } from './config.js';
import { requiresOwner } from './command-access.js';
import { resolveDiscordOwnerUserId } from './discord.js';
import { initializeLogger } from './logger.js';
import {
  addMutedCourse,
  courseChoices,
  isMutedCourse,
  loadMutedCourses,
  MUTES_PATH,
  removeMutedCourse,
  resolveCourseInput,
  saveMutedCourses,
  uniqueCourseNames,
} from './mutes.js';
import { loadRuntimeStatus } from './runtime-status.js';
import { activeAssignments, loadState, STATE_PATH } from './state.js';

const RUNTIME_STATUS_PATH = 'data/runtime-status.json';
const startedAt = new Date();

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
    name: 'webclass-closest',
    description: '提出状況を問わず、提出期限が最も近い課題を表示します',
  },
  {
    name: 'webclass-status',
    description: 'WebClass自動巡回の稼働状態を表示します',
  },
  {
    name: 'webclass-mute',
    description: '指定した授業の自動通知をミュートします（所有者専用）',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'course',
        description: 'ミュートする授業名',
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'webclass-unmute',
    description: '授業の自動通知のミュートを解除します（所有者専用）',
    options: [
      {
        type: ApplicationCommandOptionType.String,
        name: 'course',
        description: 'ミュートを解除する授業名',
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: 'webclass-mutes',
    description: 'ミュート中の授業を表示します（所有者専用）',
  },
];

const MUTE_COMMANDS = new Set(['webclass-mute', 'webclass-unmute', 'webclass-mutes']);
// Serializes read-modify-write of the mute file when commands arrive at the same time.
let muteUpdateQueue = Promise.resolve();

async function main() {
  const config = loadConfig();
  initializeLogger('bot', config.logRetentionDays);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let ownerUserId = null;

  client.once('clientReady', async () => {
    ownerUserId = await resolveDiscordOwnerUserId(config);
    await registerCommands(client, config);
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Commands: ${COMMANDS.map((command) => `/${command.name}`).join(', ')}`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (interaction.isAutocomplete()) {
      await respondToCourseAutocomplete(interaction, ownerUserId).catch((error) => {
        console.error(error);
      });
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!COMMANDS.some((command) => command.name === interaction.commandName)) {
      return;
    }

    const includeSubmitted =
      interaction.commandName === 'webclass-all'
        ? (interaction.options.getBoolean('include-submitted') ?? true)
        : true;
    const ownerOnly = requiresOwner(interaction.commandName, includeSubmitted);

    await interaction.deferReply(
      ownerOnly ? { flags: MessageFlags.Ephemeral } : undefined,
    );

    try {
      if (ownerOnly && interaction.user.id !== ownerUserId) {
        await interaction.editReply(
          'このコマンド（またはオプション）はBot所有者だけが使用できます。',
        );
        return;
      }

      if (interaction.commandName === 'webclass-status') {
        await interaction.editReply({
          embeds: [await buildStatusEmbed()],
        });
        return;
      }

      if (MUTE_COMMANDS.has(interaction.commandName)) {
        await handleMuteCommand(interaction);
        return;
      }

      // Commands answer from the last scheduled check instead of launching a browser.
      const state = await loadState(STATE_PATH);
      if (state.isFirstRun) {
        await interaction.editReply(
          'まだ自動巡回のデータがありません。次回の自動巡回（3時間ごと）の後に試してください。',
        );
        return;
      }

      const context = {
        ephemeral: ownerOnly,
        content: await buildDataNote(state),
      };
      await respondWithAssignments(interaction, activeAssignments(state.assignments), context);
    } catch (error) {
      console.error(error);
      await interaction.editReply(
        '課題データの読み込み中にエラーが発生しました。しばらくしてから試してください。',
      );
    }
  });

  await client.login(config.discordBotToken);
}

async function respondToCourseAutocomplete(interaction, ownerUserId) {
  if (!MUTE_COMMANDS.has(interaction.commandName) || interaction.user.id !== ownerUserId) {
    await interaction.respond([]);
    return;
  }

  const mutedCourses = await loadMutedCourses(MUTES_PATH);
  const query = interaction.options.getFocused();
  if (interaction.commandName === 'webclass-unmute') {
    await interaction.respond(courseChoices(mutedCourses, query));
    return;
  }

  const state = await loadState(STATE_PATH);
  const candidates = uniqueCourseNames(state.assignments).filter(
    (name) => !isMutedCourse(mutedCourses, name),
  );
  await interaction.respond(courseChoices(candidates, query));
}

async function handleMuteCommand(interaction) {
  if (interaction.commandName === 'webclass-mutes') {
    const mutedCourses = await loadMutedCourses(MUTES_PATH);
    await interaction.editReply(
      mutedCourses.length
        ? `🔇 ミュート中の授業（${mutedCourses.length}件）\n${mutedCourses.map((name) => `- ${name}`).join('\n')}`
        : 'ミュート中の授業はありません。',
    );
    return;
  }

  const input = interaction.options.getString('course', true).trim();
  if (!input) {
    await interaction.editReply('授業名を入力してください。');
    return;
  }

  const update = muteUpdateQueue.then(async () => {
    const mutedCourses = await loadMutedCourses(MUTES_PATH);

    if (interaction.commandName === 'webclass-unmute') {
      const course = resolveCourseInput(input, mutedCourses);
      const result = course ? removeMutedCourse(mutedCourses, course.name) : { changed: false };
      if (!result.changed) {
        return course
          ? `「${course.name}」はミュートされていません。`
          : '選択した授業はミュートされていません。';
      }
      await saveMutedCourses(MUTES_PATH, result.courses);
      return `🔔 「${course.name}」のミュートを解除しました。次回の自動巡回から通知が届きます。`;
    }

    // Prefer the exact name WebClass uses, so the saved entry matches future checks.
    const state = await loadState(STATE_PATH);
    const course =
      resolveCourseInput(input, uniqueCourseNames(state.assignments)) ??
      resolveCourseInput(input, mutedCourses);
    if (!course) {
      return '選択した授業が見つかりませんでした。もう一度候補から選んでください。';
    }
    const result = addMutedCourse(mutedCourses, course.name);
    if (!result.changed) {
      return `「${course.name}」は既にミュートしています。`;
    }
    await saveMutedCourses(MUTES_PATH, result.courses);

    const unknownNote = course.known
      ? ''
      : '\n※ 現在の課題データにこの授業名はありません。WebClassの授業名と一致した場合に通知から除外されます。';
    return `🔇 「${course.name}」の自動通知（新規課題・締切変更・24時間前・当日DM）をミュートしました。次回の自動巡回から適用されます。${unknownNote}`;
  });
  // Keep the queue usable even if this update fails.
  muteUpdateQueue = update.catch(() => undefined);

  await interaction.editReply(await update);
}

async function buildDataNote(state) {
  const lines = [];
  if (state.updatedAt) {
    lines.push(`最終巡回: ${discordTime(state.updatedAt)}`);
  }

  const status = await loadRuntimeStatus(RUNTIME_STATUS_PATH);
  if (status.consecutiveFailures > 0) {
    lines.push(
      `⚠️ 直近の自動巡回が${status.consecutiveFailures}回連続で失敗しているため、情報が古い可能性があります。`,
    );
  }
  return lines.join('\n') || undefined;
}

async function respondWithAssignments(interaction, assignments, context) {
  if (
    interaction.commandName === 'webclass-next' ||
    interaction.commandName === 'webclass-closest'
  ) {
    const isUnsubmittedOnly = interaction.commandName === 'webclass-next';
    const nextAssignment = sortAssignmentsByDeadline(
      isUnsubmittedOnly
        ? assignments.filter(isUnsubmittedAssignment)
        : assignments.filter((assignment) => assignment.deadlineAt),
    )[0];
    const embeds = buildAssignmentListEmbeds(
      nextAssignment ? [nextAssignment] : [],
      isUnsubmittedOnly
        ? '提出期限が最も近い未提出課題'
        : '提出期限が最も近い課題',
      isUnsubmittedOnly
        ? '現在、未提出と判定できる課題はありません。'
        : '現在、提出期限を確認できる課題はありません。',
    );
    await sendPagedEmbeds(interaction, embeds, context);
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

  await sendPagedEmbeds(interaction, embeds, context);
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

async function sendPagedEmbeds(interaction, embeds, { ephemeral, content }) {
  const [firstEmbed, ...restEmbeds] = embeds;
  await interaction.editReply({ content, embeds: [firstEmbed] });

  // Follow-ups are public by default, so owner-only lists must stay ephemeral explicitly.
  for (const embed of restEmbeds) {
    await interaction.followUp({
      embeds: [embed],
      ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
    });
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
