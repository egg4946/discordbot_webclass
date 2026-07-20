import { hashText } from './hash.js';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
let cachedOwnerUserId = null;

export async function sendDiscordMessage(config, payload) {
  return discordRequest(
    config,
    `/channels/${config.discordChannelId}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
}

export async function resolveDiscordOwnerUserId(config) {
  if (config.discordOwnerUserId) {
    return config.discordOwnerUserId;
  }

  if (cachedOwnerUserId) {
    return cachedOwnerUserId;
  }

  const application = await discordRequest(config, '/oauth2/applications/@me');
  cachedOwnerUserId = application.owner?.id ?? null;

  if (!cachedOwnerUserId) {
    throw new Error(
      'Discordアプリの所有者を自動取得できませんでした。DISCORD_OWNER_USER_IDを設定してください。',
    );
  }

  return cachedOwnerUserId;
}

export async function sendDiscordDm(config, userId, payload) {
  const dmChannel = await discordRequest(config, '/users/@me/channels', {
    method: 'POST',
    body: JSON.stringify({ recipient_id: userId }),
  });

  return discordRequest(config, `/channels/${dmChannel.id}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

async function discordRequest(config, path, options = {}) {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${config.discordBotToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord API error: ${response.status} ${body}`);
  }

  return response.json();
}

export function assignmentEmbed(title, description, assignment, color = null) {
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
    color: color ?? courseColor(assignment.courseName),
    fields,
    timestamp: new Date().toISOString(),
  };
}

export function courseColor(courseName) {
  const normalized = (courseName || '不明').normalize('NFKC').trim().toLowerCase();
  const hue = Number.parseInt(hashText(normalized).slice(0, 8), 16) % 360;
  return hslToRgb(hue, 0.68, 0.52);
}

function hslToRgb(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const intermediate = chroma * (1 - Math.abs((sector % 2) - 1));
  const offset = lightness - chroma / 2;
  const [red, green, blue] =
    sector < 1 ? [chroma, intermediate, 0] :
    sector < 2 ? [intermediate, chroma, 0] :
    sector < 3 ? [0, chroma, intermediate] :
    sector < 4 ? [0, intermediate, chroma] :
    sector < 5 ? [intermediate, 0, chroma] :
    [chroma, 0, intermediate];

  return (
    Math.round((red + offset) * 255) * 0x10000 +
    Math.round((green + offset) * 255) * 0x100 +
    Math.round((blue + offset) * 255)
  );
}
