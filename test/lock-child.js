// Takes a lock from its own Node process, so the tests check exclusion between real processes.
//   node test/lock-child.js path <lock path>   acquireRunLock (check.lock and the like)
//   node test/lock-child.js task <task-id>     withTaskLock (task.lock)
// Prints "ready", tries the lock on the line "go", prints "acquired" or "busy", and while it
// holds the lock releases it on the next line (or when stdin ends), then prints "released".
// With LOCK_CHILD_SPAWN=1 it starts a long-lived process while holding the lock ("spawned <pid>").
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { acquireRunLock } from '../src/run-lock.js';
import { withTaskLock } from '../src/task-store.js';

function acquired() {
  console.log('acquired');
  if (process.env.LOCK_CHILD_SPAWN === '1') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`spawned ${child.pid}`);
  }
}

const [kind, target] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin });
const input = lines[Symbol.asyncIterator]();

console.log('ready');
await input.next();

if (kind === 'task') {
  try {
    await withTaskLock(target, async () => {
      acquired();
      await input.next();
    });
    console.log('released');
  } catch (error) {
    if (!/既に実行中/.test(error.message)) throw error;
    console.log('busy');
  }
} else {
  const release = await acquireRunLock(target);
  if (release) acquired();
  else console.log('busy');
  if (release) {
    await input.next();
    await release();
    console.log('released');
  }
}
lines.close();
