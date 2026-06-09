import 'dotenv/config';

const ALLOWED_WEBCLASS_HOST = 'webclass.nanzan-u.ac.jp';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalList(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig() {
  const config = {
    discordBotToken: required('DISCORD_BOT_TOKEN'),
    discordChannelId: required('DISCORD_CHANNEL_ID'),
    webclassLoginUrl: required('WEBCLASS_LOGIN_URL'),
    webclassUserId: required('WEBCLASS_USER_ID'),
    webclassPassword: required('WEBCLASS_PASSWORD'),
    webclassTargetUrls: optionalList('WEBCLASS_TARGET_URLS'),
    headless: (process.env.WEBCLASS_HEADLESS ?? 'true').toLowerCase() !== 'false',
  };

  assertNanzanWebclassUrl(config.webclassLoginUrl, 'WEBCLASS_LOGIN_URL');
  for (const targetUrl of config.webclassTargetUrls) {
    assertNanzanWebclassUrl(targetUrl, 'WEBCLASS_TARGET_URLS');
  }

  return config;
}

function assertNanzanWebclassUrl(value, name) {
  const url = new URL(value);
  if (url.hostname !== ALLOWED_WEBCLASS_HOST) {
    throw new Error(`${name} must use ${ALLOWED_WEBCLASS_HOST}`);
  }
}
