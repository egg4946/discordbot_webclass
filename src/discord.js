const DISCORD_API_BASE = 'https://discord.com/api/v10';

export async function sendDiscordMessage(config, payload) {
  const response = await fetch(
    `${DISCORD_API_BASE}/channels/${config.discordChannelId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API error: ${response.status} ${body}`);
  }

  return response.json();
}

export function assignmentEmbed(title, description, assignment, color = 0x2f80ed) {
  const fields = [];

  if (assignment.courseName) {
    fields.push({ name: '科目', value: assignment.courseName, inline: true });
  }
  if (assignment.deadlineText) {
    fields.push({ name: '提出期限', value: assignment.deadlineText, inline: true });
  }

  return {
    title,
    description,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };
}
