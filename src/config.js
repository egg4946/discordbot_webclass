import 'dotenv/config';

const ALLOWED_WEBCLASS_HOST = 'webclass.nanzan-u.ac.jp';
const MAX_CHECK_TIMEOUT_MINUTES = 100;

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

function optionalPositiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function loadConfig() {
  const config = {
    discordBotToken: required('DISCORD_BOT_TOKEN'),
    discordChannelId: required('DISCORD_CHANNEL_ID'),
    discordOwnerUserId: process.env.DISCORD_OWNER_USER_ID?.trim() || null,
    webclassLoginUrl: required('WEBCLASS_LOGIN_URL'),
    webclassUserId: required('WEBCLASS_USER_ID'),
    webclassPassword: required('WEBCLASS_PASSWORD'),
    webclassTargetUrls: optionalList('WEBCLASS_TARGET_URLS'),
    headless: (process.env.WEBCLASS_HEADLESS ?? 'true').toLowerCase() !== 'false',
    retryAttempts: optionalPositiveInteger('WEBCLASS_RETRY_ATTEMPTS', 3),
    retryDelayMs: optionalPositiveInteger('WEBCLASS_RETRY_DELAY_MS', 30000),
    logRetentionDays: optionalPositiveInteger('LOG_RETENTION_DAYS', 30),
    // Must stay below the run lock's stale age (2 hours) so a hung check always ends
    // before the next run may take over its lock.
    checkTimeoutMinutes: Math.min(
      optionalPositiveInteger('CHECK_TIMEOUT_MINUTES', 60),
      MAX_CHECK_TIMEOUT_MINUTES,
    ),
  };

  assertNanzanWebclassUrl(config.webclassLoginUrl, 'WEBCLASS_LOGIN_URL');
  for (const targetUrl of config.webclassTargetUrls) {
    assertNanzanWebclassUrl(targetUrl, 'WEBCLASS_TARGET_URLS');
  }

  return config;
}

// The assignment CLI does not need Discord credentials.
export function loadTaskConfig() {
  const config = {
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

export function assertWebclassTaskUrl(value) {
  assertNanzanWebclassUrl(value, 'task URL');
}

function assertNanzanWebclassUrl(value, name) {
  const url = new URL(value);
  if (url.hostname !== ALLOWED_WEBCLASS_HOST) {
    throw new Error(`${name} must use ${ALLOWED_WEBCLASS_HOST}`);
  }
}
