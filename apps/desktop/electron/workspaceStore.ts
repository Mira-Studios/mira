import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_ICONS, workspaceSettings, type Workspace } from './workspacePolicy.ts';
type Entry = Workspace & { session: unknown };
export class WorkspaceStore {
  private entries: Entry[] = [];
  private readonly file: string;
  constructor(directory: string) {
    this.file = path.join(directory, 'workspaces.v1.json');
    mkdirSync(directory, { recursive: true });
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.workspaces))
        throw new Error('Invalid workspace storage.');
      this.entries = data.workspaces;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  private persist() {
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ version: 1, workspaces: this.entries }));
    renameSync(`${this.file}.tmp`, this.file);
  }
  list(): Workspace[] {
    return this.entries.map((entry) =>
      structuredClone({
        id: entry.id,
        name: entry.name,
        icon: entry.icon,
        avatar: entry.avatar,
        startup: entry.startup,
        urls: entry.urls,
        settings: entry.settings,
      }),
    );
  }
  get(id: string) {
    return this.entries.find((entry) => entry.id === id);
  }
  save(value: Partial<Workspace>) {
    const previous = value.id ? this.get(value.id) : undefined;
    if (value.id && !previous) throw new Error('Workspace not found.');
    const name = typeof value.name === 'string' ? value.name.trim().slice(0, 60) : '';
    if (!name) throw new Error('Enter a workspace name.');
    const avatar = value.avatar ?? null;
    if (
      avatar &&
      (typeof avatar !== 'string' ||
        avatar.length > 500_000 ||
        !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar))
    )
      throw new Error('Invalid workspace picture.');
    const urls = Array.isArray(value.urls)
      ? value.urls
          .filter(
            (url): url is string =>
              typeof url === 'string' && /^(https?:\/\/|mira:\/\/)/i.test(url),
          )
          .slice(0, 100)
      : [];
    const entry: Entry = {
      id: previous?.id ?? randomUUID(),
      name,
      avatar,
      icon: WORKSPACE_ICONS.includes(value.icon as (typeof WORKSPACE_ICONS)[number])
        ? value.icon!
        : 'panels',
      startup: value.startup === 'fixed' ? 'fixed' : 'restore',
      urls,
      settings: workspaceSettings(value.settings ?? previous?.settings),
      session: previous?.session ?? null,
    };
    if (previous) this.entries[this.entries.indexOf(previous)] = entry;
    else this.entries.push(entry);
    this.persist();
    return this.list().find((item) => item.id === entry.id)!;
  }
  setSettings(id: string, value: unknown) {
    const entry = this.get(id);
    if (!entry) throw new Error('Workspace not found.');
    entry.settings = workspaceSettings(value);
    this.persist();
  }
  setSession(id: string, snapshot: unknown) {
    const entry = this.get(id);
    if (!entry) return;
    entry.session = snapshot;
    this.persist();
  }
  remove(id: string) {
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.persist();
  }
}
