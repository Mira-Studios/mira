import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Replace on the same filesystem, keeping the old file intact if staging fails. */
export async function atomicSaveText(filePath: string, text: string, expected: string): Promise<void> {
  // Resolve links so replacing a symlink does not unexpectedly remove the link itself.
  const target = await fs.realpath(filePath);
  const stat = await fs.stat(target);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.mira-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', stat.mode);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    // Catch external edits while the temporary file was being written.
    if (await fs.readFile(target, 'utf8') !== expected) throw new Error('The file changed on disk during saving. Your edits are still open; save again to review the conflict.');
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}
