import { promises as fs } from 'node:fs';
import path from 'node:path';

import { GETTING_STARTED_STEPS, initialGettingStarted, type GettingStartedStep, type GettingStartedState } from './gettingStartedPolicy.ts';

export class GettingStartedStore {
  private pending: Promise<unknown> = Promise.resolve();
  private file: string;
  constructor(directory: string) { this.file = path.join(directory, 'getting-started.v1.json'); }
  async read(): Promise<GettingStartedState> {
    await this.pending;
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<GettingStartedState>;
      return { version: 1, completed: GETTING_STARTED_STEPS.filter(step => data.completed?.includes(step)), dismissed: data.dismissed === true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return initialGettingStarted();
      throw new Error('Could not read getting-started progress.');
    }
  }
  async update(step?: GettingStartedStep, dismiss = false): Promise<GettingStartedState> {
    const state = await this.read();
    // Serialize writes; merge again inside the queue so two windows cannot lose progress.
    const operation = this.pending.then(async () => {
      let latest = state;
      try {
        const stored = JSON.parse(await fs.readFile(this.file, 'utf8')) as GettingStartedState;
        latest = { version: 1, completed: GETTING_STARTED_STEPS.filter(item => stored.completed?.includes(item)), dismissed: stored.dismissed === true };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const next: GettingStartedState = { version: 1, completed: GETTING_STARTED_STEPS.filter(item => latest.completed.includes(item) || item === step), dismissed: latest.dismissed || dismiss };
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(next), 'utf8');
      await fs.rename(temporary, this.file);
      return next;
    });
    this.pending = operation.catch(() => undefined);
    return operation;
  }
}
