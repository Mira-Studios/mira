import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeSettingsBundle, type SettingsBundle } from './profileSettingsPolicy.ts';

export interface Profile {
  id: string;
  name: string;
  hasAvatar?: boolean;
  removalToken?: string;
  syncSettings?: boolean;
  settingsSyncSince?: number;
}

interface ProfileRegistry {
  version: 1;
  profiles: Profile[];
  restoreProfiles: string[];
  settingsSource?: string;
  settingsUpdatedAt?: number;
  showPickerOnStartup?: boolean;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PROFILE_ID = /^(default|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Only profile discovery is shared. All feature data belongs under dataPath(). */
export class ProfileStore {
  readonly root: string;
  readonly registryPath: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.registryPath = path.join(this.root, 'profiles.json');
    fs.mkdirSync(this.root, { recursive: true });
    this.locked(() => {
      if (fs.existsSync(this.registryPath) || fs.existsSync(`${this.registryPath}.bak`)) {
        this.read(); // Fail closed rather than replacing an unreadable registry.
        return;
      }
      this.migrateLegacy();
      this.write({
        version: 1,
        profiles: [{ id: 'default', name: 'Default' }],
        restoreProfiles: ['default'],
      });
    });
  }

  dataPath(id: string): string {
    if (!PROFILE_ID.test(id)) throw new Error('Invalid profile ID.');
    return path.join(this.root, 'Profiles', id);
  }

  read(): ProfileRegistry {
    for (const file of [this.registryPath, `${this.registryPath}.bak`]) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as ProfileRegistry;
        if (
          data.version !== 1 ||
          !Array.isArray(data.profiles) ||
          !data.profiles.length ||
          data.profiles.some(
            (p) =>
              !PROFILE_ID.test(p.id) ||
              typeof p.name !== 'string' ||
              !p.name.trim() ||
              (p.removalToken !== undefined && !UUID.test(p.removalToken)),
          ) ||
          new Set(data.profiles.map((p) => p.id)).size !== data.profiles.length ||
          !Array.isArray(data.restoreProfiles) ||
          data.restoreProfiles.some((id) => !data.profiles.some((p) => p.id === id)) ||
          (data.settingsSource && !data.profiles.some((p) => p.id === data.settingsSource))
        )
          continue;
        return data;
      } catch {
        /* Try the last valid registry. */
      }
    }
    throw new Error(
      'Mira could not read the profile registry. Your profile data has been preserved.',
    );
  }

  get(id: string): Profile {
    const profile = this.read().profiles.find((p) => p.id === id);
    if (!profile) throw new Error('This profile no longer exists.');
    return profile;
  }

  setShowPickerOnStartup(enabled: boolean) {
    this.update((registry) => {
      registry.showPickerOnStartup = enabled;
    });
  }

  shouldShowPicker(): boolean {
    const registry = this.read();
    return (
      registry.showPickerOnStartup !== false &&
      registry.profiles.filter((p) => !p.removalToken).length > 1
    );
  }

  private write(value: ProfileRegistry) {
    const temporary = `${this.registryPath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', flush: true });
    // Keep the new complete registry as fallback too, so removed profiles cannot resurrect.
    const backup = `${temporary}.bak`;
    fs.copyFileSync(temporary, backup);
    this.replaceFile(backup, `${this.registryPath}.bak`);
    this.replaceFile(temporary, this.registryPath);
  }

  private replaceFile(source: string, destination: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(source, destination);
        return;
      } catch (error) {
        if (
          attempt >= 49 ||
          !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
        sleep(20);
      }
    }
  }

  private locked<T>(operation: () => T): T {
    const lock = path.join(this.root, 'profiles.lock');
    const deadline = Date.now() + 10_000;
    let descriptor: number;
    for (;;) {
      try {
        descriptor = fs.openSync(lock, 'wx');
        fs.writeSync(descriptor, String(process.pid));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const pid = Number(fs.readFileSync(lock, 'utf8'));
          if (
            (pid > 0 && !this.pidRunning(pid)) ||
            (!pid && Date.now() - fs.statSync(lock).mtimeMs > 5000)
          ) {
            fs.unlinkSync(lock);
            continue;
          }
        } catch {
          /* Another process may be releasing the lock. */
        }
        if (Date.now() > deadline) throw new Error('Profiles are busy. Try again.');
        sleep(20);
      }
    }
    try {
      return operation();
    } finally {
      fs.closeSync(descriptor);
      fs.unlinkSync(lock);
    }
  }

  private update<T>(change: (registry: ProfileRegistry) => T): T {
    return this.locked(() => {
      const registry = this.read();
      const result = change(registry);
      this.write(registry);
      return result;
    });
  }

  private migrateLegacy() {
    const destination = this.dataPath('default');
    fs.mkdirSync(destination, { recursive: true });
    // Move before Chromium starts. A partial migration resumes on the next launch;
    // files already moved are never replaced. Keep names, including OS encryption keys.
    for (const entry of fs.readdirSync(this.root)) {
      if (
        ['Profiles', 'profiles.lock'].includes(entry) ||
        /^Singleton|^DevToolsActivePort$|^lockfile$/i.test(entry)
      )
        continue;
      const source = path.join(this.root, entry);
      const target = path.join(destination, entry);
      if (fs.existsSync(target))
        throw new Error(`Profile migration stopped to preserve both copies of ${entry}.`);
      fs.renameSync(source, target);
    }
  }

  create(name: unknown, initialize?: (directory: string, profile: Profile) => void): Profile {
    const profile: Profile = { id: randomUUID(), name: this.validateName(name) };
    return this.update((registry) => {
      fs.mkdirSync(this.dataPath(profile.id), { recursive: true });
      fs.writeFileSync(
        path.join(this.dataPath(profile.id), 'app-state.json'),
        JSON.stringify({ onboardingCompleted: true }),
      );
        // Finish external-data imports before discovery can launch this profile.
        initialize?.(this.dataPath(profile.id), profile);
        registry.profiles.push(profile);
      return profile;
    });
  }

  rename(id: string, name: unknown) {
    const normalized = this.validateName(name);
    this.update((registry) => {
      const profile = registry.profiles.find((p) => p.id === id && !p.removalToken);
      if (!profile) throw new Error('This profile is unavailable.');
      profile.name = normalized;
    });
  }

  private validateName(name: unknown): string {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60)
      throw new Error('Enter a profile name between 1 and 60 characters.');
    return name.trim();
  }

  setAvatar(id: string, png: Buffer | null) {
    this.update((registry) => {
      const profile = registry.profiles.find((p) => p.id === id && !p.removalToken);
      if (!profile) throw new Error('This profile is unavailable.');
      const file = path.join(this.dataPath(id), 'profile-avatar.png');
      if (png) {
        const temporary = `${file}.tmp`;
        fs.writeFileSync(temporary, png);
        this.replaceFile(temporary, file);
      } else fs.rmSync(file, { force: true });
      profile.hasAvatar = !!png;
    });
  }

  avatar(id: string): string | undefined {
    if (!this.get(id).hasAvatar) return undefined;
    try {
      return `data:image/png;base64,${fs.readFileSync(path.join(this.dataPath(id), 'profile-avatar.png')).toString('base64')}`;
    } catch {
      return undefined;
    }
  }

  markRunning(id: string) {
    this.update((registry) => {
      if (!registry.profiles.some((p) => p.id === id && !p.removalToken))
        throw new Error('This profile is being removed.');
      fs.mkdirSync(this.dataPath(id), { recursive: true });
      fs.writeFileSync(
        path.join(this.dataPath(id), 'mira-runtime.json'),
        JSON.stringify({ pid: process.pid }),
      );
      if (!registry.restoreProfiles.includes(id)) registry.restoreProfiles.push(id);
    });
  }

  private readSettings(id: string): SettingsBundle | null {
    try {
      return normalizeSettingsBundle(
        JSON.parse(fs.readFileSync(path.join(this.dataPath(id), 'settings-sync.json'), 'utf8')),
      );
    } catch {
      return null;
    }
  }

  private writeSettings(id: string, settings: SettingsBundle) {
    const file = path.join(this.dataPath(id), 'settings-sync.json');
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(settings), { flush: true });
    this.replaceFile(temporary, file);
  }

  private copySettingsAssets(source: string, target: string, settings: SettingsBundle) {
    const browser = settings['mira.settings.browser.v1'];
    const image = browser ? JSON.parse(browser)?.backgroundImage : null;
    const key = typeof image === 'string' ? /^local:([a-f0-9]{64})$/.exec(image)?.[1] : undefined;
    if (!key || source === target) return;
    for (const extension of ['png', 'jpg', 'webp', 'gif', 'bmp']) {
      const from = path.join(this.dataPath(source), 'background-images', `${key}.${extension}`);
      const to = path.join(this.dataPath(target), 'background-images', `${key}.${extension}`);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
    }
  }

  syncedSettings(id: string): SettingsBundle | null {
    const registry = this.read();
    if (!registry.profiles.find((p) => p.id === id)?.syncSettings || !registry.settingsSource)
      return null;
    const settings = this.readSettings(registry.settingsSource);
    if (settings) this.copySettingsAssets(registry.settingsSource, id, settings);
    return settings;
  }

  settingsUpdate(id: string) {
    const registry = this.read();
    if (!registry.profiles.find((p) => p.id === id)?.syncSettings || !registry.settingsSource)
      return null;
    const settings = this.readSettings(registry.settingsSource);
    if (!settings) return null;
    this.copySettingsAssets(registry.settingsSource, id, settings);
    return { settings, updatedAt: registry.settingsUpdatedAt ?? 0 };
  }

  publishSettings(id: string, value: unknown, changedAt = Date.now(), initial = false) {
    const settings = normalizeSettingsBundle(value);
    this.locked(() => {
      const registry = this.read();
      const profile = registry.profiles.find((p) => p.id === id && !p.removalToken);
      if (!profile) return;
      const sourceSettings = registry.settingsSource
        ? this.readSettings(registry.settingsSource)
        : null;
      // A delayed renderer save must never overwrite newer shared preferences,
      // or predate the explicit action of joining a sync group.
      if (
        profile.syncSettings &&
        sourceSettings &&
        (initial ||
          changedAt < (registry.settingsUpdatedAt ?? 0) ||
          changedAt < (profile.settingsSyncSince ?? 0))
      ) {
        this.copySettingsAssets(registry.settingsSource!, id, sourceSettings);
        this.writeSettings(id, sourceSettings);
        return;
      }
      const previous = this.readSettings(id);
      const raw = JSON.stringify(settings);
      if (raw !== JSON.stringify(previous)) this.writeSettings(id, settings);
      if (!profile.syncSettings || raw === JSON.stringify(sourceSettings)) return;
      registry.settingsSource = id;
      registry.settingsUpdatedAt = changedAt;
      this.write(registry);
    });
  }

  setSettingsSync(id: string, enabled: boolean) {
    this.update((registry) => {
      const profile = registry.profiles.find((p) => p.id === id && !p.removalToken);
      if (!profile) throw new Error('This profile is unavailable.');
      profile.syncSettings = enabled;
      if (enabled) {
        profile.settingsSyncSince = Date.now();
        if (!registry.settingsSource && this.readSettings(id)) {
          registry.settingsSource = id;
          registry.settingsUpdatedAt = Date.now();
        }
      } else if (registry.settingsSource === id) this.reassignSettingsSource(registry, id);
    });
  }

  private reassignSettingsSource(registry: ProfileRegistry, outgoing: string) {
    const next = registry.profiles.find(
      (p) => p.id !== outgoing && p.syncSettings && !p.removalToken,
    );
    const snapshot = this.readSettings(outgoing);
    if (next && snapshot) {
      this.copySettingsAssets(outgoing, next.id, snapshot);
      this.writeSettings(next.id, snapshot);
      registry.settingsSource = next.id;
    } else {
      delete registry.settingsSource;
      delete registry.settingsUpdatedAt;
    }
  }

  private pidRunning(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  isRunning(id: string): boolean {
    try {
      const { pid } = JSON.parse(
        fs.readFileSync(path.join(this.dataPath(id), 'mira-runtime.json'), 'utf8'),
      );
      return Number.isInteger(pid) && pid > 0 && this.pidRunning(pid);
    } catch {
      return false;
    }
  }

  beginRemoval(id: string): string {
    return this.update((registry) => {
      if (registry.profiles.filter((p) => !p.removalToken).length < 2)
        throw new Error('Keep at least one profile.');
      const profile = registry.profiles.find((p) => p.id === id && !p.removalToken);
      if (!profile) throw new Error('This profile is unavailable.');
      return (profile.removalToken = randomUUID());
    });
  }

  cancelRemoval(id: string, token: string) {
    this.update((registry) => {
      const profile = registry.profiles.find((p) => p.id === id && p.removalToken === token);
      if (profile) delete profile.removalToken;
    });
  }

  finishRemoval(id: string, token: string) {
    let removedDirectory: string | undefined;
    this.locked(() => {
      const registry = this.read();
      if (!registry.profiles.some((p) => p.id === id && p.removalToken === token))
        throw new Error('Removal request expired.');
      if (this.isRunning(id)) throw new Error('Close this profile’s windows to remove it.');
      if (registry.settingsSource === id) this.reassignSettingsSource(registry, id);
      const original = this.dataPath(id);
      const removedRoot = path.join(this.root, 'Profiles', '.removed');
      const removed = path.join(removedRoot, `${id}-${token}`);
      fs.mkdirSync(removedRoot, { recursive: true });
      // Detach the complete directory before deleting anything. A locked file or
      // a failed registry commit must leave a kept profile completely intact.
      if (fs.existsSync(original)) this.replaceFile(original, removed);
      registry.profiles = registry.profiles.filter((p) => p.id !== id);
      registry.restoreProfiles = registry.restoreProfiles.filter((value) => value !== id);
      try {
        this.write(registry);
      } catch (error) {
        if (fs.existsSync(removed)) this.replaceFile(removed, original);
        throw error;
      }
      removedDirectory = removed;
    });
    // Windows can retain Chromium handles briefly after the owning process exits.
    // A cleanup failure never recreates an empty profile or rolls back consent.
    if (removedDirectory) {
      try {
        fs.rmSync(removedDirectory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch (error) {
        console.error('Profile removed; remaining files will be cleaned on next startup', error);
      }
    }
  }

  cleanupRemovedProfiles() {
    const removedRoot = path.join(this.root, 'Profiles', '.removed');
    const pending = new Set(
      this.read()
        .profiles.filter((p) => p.removalToken)
        .map((p) => `${p.id}-${p.removalToken}`),
    );
    try {
      for (const entry of fs.readdirSync(removedRoot)) {
        if (!/^(default|[a-f0-9-]{36})-[a-f0-9-]{36}$/.test(entry) || pending.has(entry)) continue;
        const target = path.resolve(removedRoot, entry);
        if (path.dirname(target) !== path.resolve(removedRoot)) continue;
        void fs.promises
          .rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
          .catch(() => undefined);
      }
    } catch {
      /* No deferred removals. */
    }
  }
}
