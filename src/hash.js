import { createHash } from 'node:crypto';

export function hashText(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
