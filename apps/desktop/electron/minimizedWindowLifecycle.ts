export interface WindowSuspensionSettings {
  enabled: boolean;
  delayMs: number;
}

export function normalizeWindowSuspensionSettings(value: unknown): WindowSuspensionSettings {
  const candidate = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    enabled: candidate.enabled === true,
    delayMs:
      typeof candidate.delayMs === 'number' && Number.isFinite(candidate.delayMs)
        ? Math.min(24 * 60 * 60 * 1000, Math.max(1000, Math.floor(candidate.delayMs)))
        : 5 * 60 * 1000,
  };
}

export interface WindowPreview {
  show(): void;
  dispose(): void;
}

interface SuspensionHost {
  isMinimized(): boolean;
  capture(): Promise<WindowPreview | null>;
  unload(): Promise<boolean>;
  restore(): void;
  onError(error: unknown): void;
}

/** Timers live in the main process, which keeps running while renderers are asleep. */
export class MinimizedWindowLifecycle {
  private settings = normalizeWindowSuspensionSettings(null);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private phase: 'awake' | 'capturing' | 'unloading' | 'suspended' | 'restoring' | 'closed' =
    'awake';
  private preview: WindowPreview | null = null;
  private resumeRequested = false;
  private host: SuspensionHost;

  constructor(host: SuspensionHost) {
    this.host = host;
  }

  get isUnloaded(): boolean {
    return this.phase === 'unloading' || this.phase === 'suspended';
  }

  get isRestoring(): boolean {
    return this.phase === 'restoring';
  }

  get restoreToken(): number | undefined {
    return this.isRestoring ? this.generation : undefined;
  }

  configure(value: unknown): void {
    const next = normalizeWindowSuspensionSettings(value);
    if (next.enabled === this.settings.enabled && next.delayMs === this.settings.delayMs) return;
    this.settings = next;
    this.cancelTimer();
    if (this.phase === 'capturing') {
      this.generation++;
      this.phase = 'awake';
    }
    if (!next.enabled) this.activate();
    else this.minimize();
  }

  minimize(): void {
    this.cancelTimer();
    if (!this.settings.enabled || this.phase !== 'awake' || !this.host.isMinimized()) return;
    this.timer = setTimeout(() => {
      void this.suspend();
    }, this.settings.delayMs);
    this.timer.unref?.();
  }

  activate(): void {
    this.cancelTimer();
    if (this.phase === 'capturing') {
      this.generation++;
      this.phase = 'awake';
    } else if (this.phase === 'unloading') {
      // Navigation must finish before starting the shell again.
      this.resumeRequested = true;
    } else if (this.phase === 'suspended') {
      this.phase = 'restoring';
      this.host.restore();
    }
  }

  ready(): boolean {
    if (this.phase !== 'restoring') return false;
    this.preview?.dispose();
    this.preview = null;
    this.phase = 'awake';
    this.minimize();
    return true;
  }

  close(): void {
    this.cancelTimer();
    this.generation++;
    this.phase = 'closed';
    this.preview?.dispose();
    this.preview = null;
  }

  private cancelTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async suspend(): Promise<void> {
    if (!this.settings.enabled || this.phase !== 'awake' || !this.host.isMinimized()) return;
    const generation = ++this.generation;
    this.phase = 'capturing';
    try {
      const preview = await this.host.capture();
      if (generation !== this.generation || !this.settings.enabled || !this.host.isMinimized()) {
        preview?.dispose();
        if (generation === this.generation) this.phase = 'awake';
        return;
      }
      if (!preview) {
        this.phase = 'awake';
        this.retry();
        return;
      }
      this.preview = preview;
      preview.show();
      this.phase = 'unloading';
      this.resumeRequested = false;
      const unloaded = await this.host.unload();
      if (generation !== this.generation) return;
      if (!unloaded) {
        this.preview?.dispose();
        this.preview = null;
        this.phase = 'awake';
        this.retry();
        return;
      }
      this.phase = 'suspended';
      if (this.resumeRequested || !this.settings.enabled || !this.host.isMinimized())
        this.activate();
    } catch (error) {
      this.host.onError(error);
      if (generation !== this.generation) return;
      // A failed navigation may already have torn down some tabs. Rebuild from the snapshot.
      if (this.phase === 'unloading') {
        this.phase = 'suspended';
        this.activate();
      } else {
        this.preview?.dispose();
        this.preview = null;
        this.phase = 'awake';
        this.retry();
      }
    }
  }

  private retry(): void {
    this.cancelTimer();
    if (!this.settings.enabled || this.phase !== 'awake' || !this.host.isMinimized()) return;
    this.timer = setTimeout(() => {
      void this.suspend();
    }, 30_000);
    this.timer.unref?.();
  }
}
