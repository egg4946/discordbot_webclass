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
    fields.push({ name: '授業', value: assignment.courseName, inline: false });
  }
  if (assignment.title) {
    fields.push({ name: '課題名', value: assignment.title, inline: false });
  }
  if (assignment.deadlineText) {
    fields.push({ name: '提出期限', value: assignment.deadlineText, inline: false });
  }

  return {
    title,
    description,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };
}
