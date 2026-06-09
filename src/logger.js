import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';

const LOG_DIR = 'logs';
let initialized = false;

export function initializeLogger(prefix, retentionDays = 30) {
  if (initialized) {
    return;
  }
  initialized = true;
  mkdirSync(LOG_DIR, { recursive: true });
  deleteExpiredLogs(retentionDays);

  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${formatArgs(args)}\n`;
      appendFileSync(join(LOG_DIR, `${prefix}-${localDateKey()}.log`), line, 'utf8');
    };
  }
}

function deleteExpiredLogs(retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(LOG_DIR)) {
    const path = join(LOG_DIR, name);
    try {
      if (name.endsWith('.log') && statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
      }
    } catch {
      // A log may be rotated or removed by another process.
    }
  }
}

function localDateKey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatArgs(args) {
  return args
    .map((value) => (typeof value === 'string' ? value : inspect(value, { depth: 4 })))
    .join(' ');
}
