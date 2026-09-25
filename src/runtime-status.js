import { readFile } from 'node:fs/promises';
import { writeJsonFile } from './json-file.js';

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
  await writeJsonFile(path, { ...DEFAULT_STATUS, ...status });
}

export const FAILURE_NOTIFICATION_THRESHOLD = 3;

// Notify once, exactly when the consecutive failures reach the threshold.
export function shouldNotifyFailure(status) {
  return status.consecutiveFailures === FAILURE_NOTIFICATION_THRESHOLD;
}

// A recovery notice pairs with a failure notice, so it is sent only if one was sent before.
export function shouldNotifyRecovery(previousConsecutiveFailures) {
  return (previousConsecutiveFailures ?? 0) >= FAILURE_NOTIFICATION_THRESHOLD;
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
