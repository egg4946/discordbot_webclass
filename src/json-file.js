import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Writes to a temporary file and renames it, so a concurrent reader (the bot)
// never sees a half-written file.
export async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}
