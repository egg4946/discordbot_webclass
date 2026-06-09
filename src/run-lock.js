import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

export async function acquireRunLock(path, staleMs = DEFAULT_STALE_MS) {
  await mkdir(dirname(path), { recursive: true });

  try {
    return await createLock(path);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }

  const lockStat = await stat(path).catch(() => null);
  if (lockStat && Date.now() - lockStat.mtimeMs <= staleMs) {
    return null;
  }

  await unlink(path).catch((error) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });

  return createLock(path);
}

async function createLock(path) {
  const handle = await open(path, 'wx');
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    'utf8',
  );

  return async () => {
    await handle.close().catch(() => undefined);
    await unlink(path).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  };
}
