import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_HISTORY_RETENTION_DAYS, normalizeHistoryRetentionDays, pruneHistoryEntries,
  type HistoryRetentionDays,
} from './historyPolicy.ts';

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
}

/** Serialize reads, writes and policy changes so a stale write cannot restore deleted history. */
export class HistoryStore {
  private entries: HistoryEntry[] = [];
  private retention: HistoryRetentionDays = DEFAULT_HISTORY_RETENTION_DAYS;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly historyPath: string;
  private readonly policyPath: string;

  constructor(directory: string) {
    this.historyPath = path.join(directory, 'history.json');
    this.policyPath = path.join(directory, 'history-settings.json');
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async persist(): Promise<void> {
    await fs.writeFile(this.historyPath, JSON.stringify(this.entries), 'utf8');
  }

  snapshot(): HistoryEntry[] {
    return pruneHistoryEntries(this.entries, this.retention).map(entry => ({ ...entry }));
  }

  load(): Promise<void> {
    return this.run(async () => {
      await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
      try {
        this.retention = normalizeHistoryRetentionDays(JSON.parse(await fs.readFile(this.policyPath, 'utf8')).retentionDays);
      } catch { this.retention = DEFAULT_HISTORY_RETENTION_DAYS; }
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(this.historyPath, 'utf8'));
        this.entries = Array.isArray(parsed) ? parsed.filter((entry): entry is HistoryEntry =>
          !!entry && typeof entry.id === 'string' && typeof entry.url === 'string' &&
          typeof entry.title === 'string' && Number.isFinite(entry.visitedAt),
        ) : [];
      } catch { this.entries = []; }
      this.entries = this.snapshot();
      await this.persist();
    });
  }

  setRetention(value: unknown): Promise<HistoryRetentionDays> {
    return this.run(async () => {
      const next = normalizeHistoryRetentionDays(value);
      if (next === this.retention) return next;
      // Persist the policy before pruning so a restart enforces it even if the
      // history write is interrupted. Rename avoids a partially written policy.
      await fs.writeFile(`${this.policyPath}.tmp`, JSON.stringify({ retentionDays: next }), 'utf8');
      await fs.rename(`${this.policyPath}.tmp`, this.policyPath);
      this.retention = next;
      this.entries = this.snapshot();
      await this.persist();
      return next;
    });
  }

  list(): Promise<HistoryEntry[]> {
    return this.run(async () => {
      this.entries = this.snapshot();
      await this.persist();
      return this.snapshot();
    });
  }

  add(payload: { url?: string; title?: string }): Promise<boolean> {
    return this.run(async () => {
      const url = payload.url?.trim();
      if (this.retention === 0 || !url || url.startsWith('mira://')) return false;
      this.entries = this.snapshot();
      const now = Date.now();
      const latest = this.entries[0];
      if (latest?.url === url && now - latest.visitedAt < 1500) return false;
      this.entries.unshift({ id: randomUUID(), url, title: payload.title?.trim() || url, visitedAt: now });
      await this.persist();
      return true;
    });
  }

  updateTitle(payload: { url?: string; title?: string }): Promise<boolean> {
    return this.run(async () => {
      const url = payload.url?.trim();
      const title = payload.title?.trim();
      if (this.retention === 0 || !url || url.startsWith('mira://') || !title || title === url) return false;
      this.entries = this.snapshot();
      const match = this.entries.find(entry => entry.url === url);
      if (match) {
        if (match.title === title) return false;
        match.title = title;
      } else {
        this.entries.unshift({ id: randomUUID(), url, title, visitedAt: Date.now() });
      }
      await this.persist();
      return true;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.run(async () => {
      const next = this.entries.filter(entry => entry.id !== id);
      if (next.length === this.entries.length) return false;
      this.entries = next;
      await this.persist();
      return true;
    });
  }

  clear(): Promise<boolean> {
    return this.run(async () => {
      const changed = this.entries.length > 0;
      this.entries = [];
      await this.persist();
      return changed;
    });
  }
}
