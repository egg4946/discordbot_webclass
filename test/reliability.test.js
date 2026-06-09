import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchAssignmentsWithRetry } from '../src/fetch-with-retry.js';
import { acquireRunLock } from '../src/run-lock.js';
import { markFailure, markSuccess } from '../src/runtime-status.js';

test('retries WebClass fetches until one succeeds', async () => {
  let attempts = 0;
  const result = await fetchAssignmentsWithRetry(
    { retryAttempts: 3, retryDelayMs: 1 },
    {
      fetcher: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('temporary failure');
        }
        return ['ok'];
      },
    },
  );

  assert.equal(attempts, 3);
  assert.deepEqual(result, ['ok']);
});

test('throws after all retry attempts fail', async () => {
  let attempts = 0;
  await assert.rejects(
    fetchAssignmentsWithRetry(
      { retryAttempts: 2, retryDelayMs: 1 },
      {
        fetcher: async () => {
          attempts += 1;
          throw new Error('still failing');
        },
      },
    ),
    /still failing/,
  );
  assert.equal(attempts, 2);
});

test('run lock prevents a second concurrent run', async () => {
  const directory = join('test-results', `lock-${Date.now()}`);
  const lockPath = join(directory, 'check.lock');
  await mkdir(directory, { recursive: true });

  try {
    const release = await acquireRunLock(lockPath);
    assert.equal(typeof release, 'function');
    assert.equal(await acquireRunLock(lockPath), null);
    await release();

    const releaseAgain = await acquireRunLock(lockPath);
    assert.equal(typeof releaseAgain, 'function');
    await releaseAgain();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale run locks are replaced', async () => {
  const directory = join('test-results', `stale-lock-${Date.now()}`);
  const lockPath = join(directory, 'check.lock');
  await mkdir(directory, { recursive: true });
  await writeFile(lockPath, 'stale', 'utf8');

  try {
    const release = await acquireRunLock(lockPath, -1);
    assert.equal(typeof release, 'function');
    await release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime status counts failures and resets after success', () => {
  const first = markFailure({}, new Error('one'), new Date('2026-06-09T00:00:00Z'));
  const third = markFailure(
    markFailure(first, new Error('two'), new Date('2026-06-09T03:00:00Z')),
    new Error('three'),
    new Date('2026-06-09T06:00:00Z'),
  );
  assert.equal(third.consecutiveFailures, 3);
  assert.equal(third.lastError, 'three');

  const success = markSuccess(
    third,
    4,
    1,
    new Date('2026-06-09T09:00:00Z'),
  );
  assert.equal(success.consecutiveFailures, 0);
  assert.equal(success.assignmentCount, 4);
  assert.equal(success.notificationCount, 1);
  assert.equal(success.lastError, null);
});
