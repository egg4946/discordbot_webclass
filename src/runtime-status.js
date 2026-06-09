import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_STATUS = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  consecutiveFailures: 0,
  lastError: null,
  assignmentCount: null,
  notificationCount: null,
};

export async function loadRuntimeStatus(path) {
  try {
    const raw = await readFile(path, 'utf8');
    return { ...DEFAULT_STATUS, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { ...DEFAULT_STATUS };
    }
    throw error;
  }
}

export async function saveRuntimeStatus(path, status) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...DEFAULT_STATUS, ...status }, null, 2)}\n`, 'utf8');
}

export function markAttempt(status, now = new Date()) {
  return { ...status, lastAttemptAt: now.toISOString() };
}

export function markSuccess(status, assignmentCount, notificationCount, now = new Date()) {
  return {
    ...status,
    lastAttemptAt: now.toISOString(),
    lastSuccessAt: now.toISOString(),
    consecutiveFailures: 0,
    lastError: null,
    assignmentCount,
    notificationCount,
  };
}

export function markFailure(status, error, now = new Date()) {
  return {
    ...status,
    lastAttemptAt: now.toISOString(),
    lastFailureAt: now.toISOString(),
    consecutiveFailures: (status.consecutiveFailures ?? 0) + 1,
    lastError: error instanceof Error ? error.message : String(error),
  };
}
