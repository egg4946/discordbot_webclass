import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';

// A lock is a local IPC name (a named pipe on Windows, an abstract Unix socket on Linux) derived
// from the lock path, and holding it means listening on that name. Binding the name is a single
// operating-system call that succeeds for one process only, and the operating system frees the
// name when the listener is closed or its process ends in any way, including being killed. So
// there is no lock file to judge stale or remove: no process ever takes a lock away from another,
// and a release only closes the releasing process's own listener.
export async function acquireRunLock(path) {
  const name = await lockName(path);
  // Anyone connecting is dropped; the name only needs to be held.
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: name, exclusive: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') return null;
    throw error;
  }
  // Holding the lock must not keep a finished process alive.
  server.unref();

  let released = null;
  return () => {
    released ??= new Promise((resolve) => server.close(() => resolve()));
    return released;
  };
}

async function lockName(path) {
  // The same lock reached through another spelling of the path (relative, a symlink, another
  // letter case on Windows) must get the same name.
  await mkdir(dirname(path), { recursive: true });
  const real = join(await realpath(dirname(path)), basename(path));
  const key = process.platform === 'win32' ? real.toLowerCase() : real;
  // Exactly 107 characters, all of sun_path after the leading NUL: Node 20 binds an abstract
  // name padded with NULs to the full sun_path, Node 24 binds just its characters, so with a
  // shorter name the two versions would hold different locks for the same path.
  const name = `discordbot-webclass-lock-${createHash('sha512').update(key).digest('hex')}`.slice(0, 107);
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  // The leading NUL puts the socket in Linux's abstract namespace: no file is created, and the
  // name disappears with the last listener.
  if (process.platform === 'linux') return `\0${name}`;
  throw new Error(`実行ロックは Windows と Linux でのみ使えます (platform: ${process.platform})。`);
}
