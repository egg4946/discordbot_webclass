import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireRunLock } from '../src/run-lock.js';
import { taskDir, taskPath } from '../src/task-store.js';
import { holdLockInChild as hold, startLockChild } from './lock-holder.js';

const CONTENDERS = 8;

// Starts all contenders first and lets them try together, so they really race for the lock.
async function race(kind, target) {
  const children = Array.from({ length: CONTENDERS }, () => startLockChild(kind, target));
  for (const child of children) assert.equal(await child.next(), 'ready');
  for (const child of children) child.send('go');
  const results = await Promise.all(children.map((child) => child.next()));
  return { children, winners: results.filter((result) => result === 'acquired').length, results };
}

async function finish(children) {
  for (const { child } of children) child.stdin.end();
  await Promise.all(children.map(({ exited }) => exited));
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid;
}

// check.lock is taken by path (src/index.js); task.lock through withTaskLock.
async function lockTargets() {
  const directory = join('test-results', `run-lock-${randomBytes(6).toString('hex')}`);
  await mkdir(directory, { recursive: true });
  const id = randomBytes(8).toString('hex');
  await mkdir(taskDir(id), { recursive: true });
  return {
    targets: [
      { kind: 'path', target: join(directory, 'check.lock'), file: join(directory, 'check.lock') },
      { kind: 'task', target: id, file: taskPath(id, 'task.lock') },
    ],
    cleanup: async () => {
      await rm(directory, { recursive: true, force: true });
      await rm(taskDir(id), { recursive: true, force: true });
    },
  };
}

test('only one of eight processes takes a free lock', { timeout: 120000 }, async () => {
  const { targets, cleanup } = await lockTargets();
  try {
    for (const { kind, target } of targets) {
      for (let round = 0; round < 3; round += 1) {
        const { children, winners, results } = await race(kind, target);
        await finish(children);
        assert.equal(winners, 1, `${kind} round ${round}: ${results.join(', ')}`);
      }
    }
  } finally {
    await cleanup();
  }
});

test('a lock left by a killed run goes to exactly one of eight processes', { timeout: 120000 }, async () => {
  const { targets, cleanup } = await lockTargets();
  try {
    for (const { kind, target, file } of targets) {
      for (let round = 0; round < 3; round += 1) {
        // What an earlier version left behind for a run that was killed: a lock file with a pid
        // that no longer exists. It must neither block the lock nor let several processes in.
        await writeFile(file, JSON.stringify({ pid: await deadPid(), startedAt: new Date().toISOString() }));
        const holder = await hold(kind, target);
        holder.child.kill('SIGKILL');
        await holder.exited;

        const { children, winners, results } = await race(kind, target);
        await finish(children);
        assert.equal(winners, 1, `${kind} round ${round}: ${results.join(', ')}`);
      }
    }
  } finally {
    await cleanup();
  }
});

test('a held lock refuses other processes until its holder releases it', { timeout: 60000 }, async () => {
  const { targets, cleanup } = await lockTargets();
  try {
    for (const { kind, target } of targets) {
      const first = await hold(kind, target);
      const { children, winners } = await race(kind, target);
      await finish(children);
      assert.equal(winners, 0, kind);

      first.send('release');
      assert.equal(await first.next(), 'released');
      await first.exited;
      const second = await hold(kind, target);
      second.child.stdin.end();
      await second.exited;
    }
  } finally {
    await cleanup();
  }
});

test('the same process cannot take a lock it already holds', async () => {
  const { targets, cleanup } = await lockTargets();
  const [{ target }] = targets;
  try {
    const release = await acquireRunLock(target);
    assert.equal(typeof release, 'function');
    assert.equal(await acquireRunLock(target), null);
    await release();
    const again = await acquireRunLock(target);
    assert.equal(typeof again, 'function');
    await again();
  } finally {
    await cleanup();
  }
});

test('releasing a lock again never frees the lock another process took since', { timeout: 60000 }, async () => {
  const { targets, cleanup } = await lockTargets();
  const [{ target }] = targets;
  let other = null;
  try {
    const release = await acquireRunLock(target);
    await release();
    other = await hold('path', target);

    // A late or repeated release of the old lock, also while others try to take it.
    const late = release();
    const { children, winners } = await race('path', target);
    await late;
    await release();
    await finish(children);
    assert.equal(winners, 0);
    const mine = await acquireRunLock(target);
    await mine?.();
    assert.equal(mine, null);
  } finally {
    other?.child.kill();
    await other?.exited;
    await cleanup();
  }
});

test('a killed run frees its lock even when a process it started lives on', { timeout: 60000 }, async () => {
  const { targets, cleanup } = await lockTargets();
  const grandchildren = [];
  try {
    for (const { kind, target } of targets) {
      // submit holds the lock while a browser it launched runs; the browser can outlive it.
      const holder = await hold(kind, target, { LOCK_CHILD_SPAWN: '1' });
      grandchildren.push(Number((await holder.next()).replace('spawned ', '')));
      holder.child.kill('SIGKILL');
      await holder.exited;

      const { children, winners } = await race(kind, target);
      await finish(children);
      assert.equal(winners, 1, kind);
    }
  } finally {
    for (const pid of grandchildren) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    await cleanup();
  }
});
