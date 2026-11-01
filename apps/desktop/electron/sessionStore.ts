import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

/** Session saves are serialized; a shutdown save invalidates any pending work. */
export class SessionStore<T> {
  private readonly getPath: () => string;
  private readonly normalize: (value: unknown) => T | null;
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(getPath: () => string, normalize: (value: unknown) => T | null) {
    this.getPath = getPath;
    this.normalize = normalize;
  }

  private parse(raw: string): T | null {
    try {
      return this.normalize(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  private async readValidRaw(filePath: string): Promise<string | null> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return this.parse(raw) === null ? null : raw;
    } catch {
      return null;
    }
  }

  private readValidRawSync(filePath: string): string | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return this.parse(raw) === null ? null : raw;
    } catch {
      return null;
    }
  }

  async load(): Promise<T | null> {
    const filePath = this.getPath();
    const raw = (await this.readValidRaw(filePath)) ?? (await this.readValidRaw(`${filePath}.bak`));
    return raw === null ? null : this.parse(raw);
  }

  private enqueue(operation: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const generation = this.generation;
    const isCurrent = () => generation === this.generation;
    const pending = this.queue.then(async () => {
      if (isCurrent()) await operation(isCurrent);
    });
    // A failed save must not prevent the next save or discard from running.
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  save(snapshot: T): Promise<void> {
    const raw = JSON.stringify(snapshot, null, 2);
    return this.enqueue(async (isCurrent) => {
      const filePath = this.getPath();
      const backupPath = `${filePath}.bak`;
      const tempPath = `${filePath}.${randomUUID()}.tmp`;
      const backupTempPath = `${tempPath}.bak`;
      try {
        const previous = await this.readValidRaw(filePath);
        // Never replace a valid backup with a corrupt primary file. Seed a
        // backup on the first save so even the first session has two copies.
        const backup = previous ?? ((await this.readValidRaw(backupPath)) === null ? raw : null);
        await fs.promises.writeFile(tempPath, raw, { encoding: 'utf8', flag: 'wx', flush: true });
        if (backup !== null) {
          await fs.promises.writeFile(backupTempPath, backup, {
            encoding: 'utf8',
            flag: 'wx',
            flush: true,
          });
        }
        if (!isCurrent()) return;
        // Commit without yielding so a synchronous shutdown save cannot be
        // followed by an older async rename. Never unlink the primary first.
        if (backup !== null) fs.renameSync(backupTempPath, backupPath);
        fs.renameSync(tempPath, filePath);
      } finally {
        await Promise.all(
          [tempPath, backupTempPath].map((temporary) =>
            fs.promises.rm(temporary, { force: true }).catch(() => undefined),
          ),
        );
      }
    });
  }

  saveSync(snapshot: T): void {
    this.generation += 1;
    const filePath = this.getPath();
    const backupPath = `${filePath}.bak`;
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    const backupTempPath = `${tempPath}.bak`;
    const raw = JSON.stringify(snapshot, null, 2);
    try {
      const previous = this.readValidRawSync(filePath);
      const backup = previous ?? (this.readValidRawSync(backupPath) === null ? raw : null);
      fs.writeFileSync(tempPath, raw, { encoding: 'utf8', flag: 'wx', flush: true });
      if (backup !== null) {
        fs.writeFileSync(backupTempPath, backup, { encoding: 'utf8', flag: 'wx', flush: true });
        fs.renameSync(backupTempPath, backupPath);
      }
      fs.renameSync(tempPath, filePath);
    } finally {
      for (const temporary of [tempPath, backupTempPath]) {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // A leftover temporary file is never used for restoration.
        }
      }
    }
  }

  clear(): Promise<void> {
    return this.enqueue(async () => this.removeFiles());
  }

  clearSync(): void {
    this.generation += 1;
    this.removeFiles();
  }

  private removeFiles(): void {
    const filePath = this.getPath();
    // Remove the fallback first so a completed discard cannot resurrect it.
    fs.rmSync(`${filePath}.bak`, { force: true });
    fs.rmSync(filePath, { force: true });
  }
}
