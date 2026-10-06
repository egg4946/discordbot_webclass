import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./lock-child.js', import.meta.url));

// A separate Node process running test/lock-child.js (see there for the protocol).
export function startLockChild(kind, target, env = {}) {
  const child = spawn(process.execPath, [CHILD, kind, target], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...env },
  });
  child.stdout.setEncoding('utf8');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    child,
    exited: once(child, 'exit'),
    next: async () => (await lines.next()).value,
    send: (line) => child.stdin.write(`${line}\n`),
  };
}

// Takes the lock in another process and keeps it until `release()`.
export async function holdLockInChild(kind, target, env) {
  const holder = startLockChild(kind, target, env);
  assert.equal(await holder.next(), 'ready');
  holder.send('go');
  assert.equal(await holder.next(), 'acquired');
  holder.release = async () => {
    holder.send('release');
    assert.equal(await holder.next(), 'released');
    await holder.exited;
  };
  return holder;
}
