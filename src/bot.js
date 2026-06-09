import { Client, GatewayIntentBits } from 'discord.js';
import { buildAssignmentListEmbeds, isUnsubmittedAssignment } from './assignment-view.js';
import { loadConfig } from './config.js';
import { fetchAssignments } from './webclass.js';

const COMMANDS = [
  {
    name: 'webclass-all',
    description: '現在WebClassで検出できる課題を表示します',
  },
  {
    name: 'webclass-unsubmitted',
    description: 'WebClassで未提出または未受験と判定できる課題を表示します',
  },
];

async function main() {
  const config = loadConfig();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('clientReady', async () => {
    await registerCommands(client, config);
    console.log(`Logged in as ${client.user.tag}`);
    console.log('Commands: /webclass-all, /webclass-unsubmitted');
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
      const assignments = await fetchAssignments(config);
      const filteredAssignments =
        interaction.commandName === 'webclass-unsubmitted'
          ? assignments.filter(isUnsubmittedAssignment)
          : assignments;

      const embeds = buildAssignmentListEmbeds(
        filteredAssignments,
        interaction.commandName === 'webclass-unsubmitted'
          ? `未提出のWebClass課題 (${filteredAssignments.length}件)`
          : `現在のWebClass課題 (${filteredAssignments.length}件)`,
        interaction.commandName === 'webclass-unsubmitted'
          ? '未提出または未受験と判定できる課題は見つかりませんでした。'
          : '課題は見つかりませんでした。',
      );

      await sendPagedEmbeds(interaction, embeds);
    } catch (error) {
      console.error(error);
      await interaction.editReply(
        'WebClassの取得中にエラーが発生しました。Botのログを確認してください。',
      );
    }
  });

  await client.login(config.discordBotToken);
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
