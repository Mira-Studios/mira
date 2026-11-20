# Desktop profile isolation

Every browser window belongs to exactly one profile for its entire lifetime.
Profiles run in separate Electron main processes. `electron/profiles.ts` sets
both `userData` and `sessionData` to `<Mira AppData>/Profiles/<id>` **before**
creating stores, sessions, windows, or acquiring the single-instance lock.
Development uses the same structure inside `Mira Dev`.

When adding or changing any feature (including New Tab cards):

- Store persistent main-process data under `app.getPath('userData')`. That path
  already belongs to the current profile. Do not build feature paths from
  `appData`, the installation directory, or the shared profile registry root.
- Renderer `localStorage`, IndexedDB, CacheStorage, and Electron's
  `session.defaultSession` are automatically profile scoped. Keep versioned
  storage keys. Do not add a second global settings or card store.
- Module-level maps and IPC broadcasts are profile scoped because a process
  owns only one profile. Never exchange feature data or tabs between profile
  processes. The shared registry holds discovery metadata, launch preferences,
  and an optional settings-sync source pointer. Feature data stays in profiles.
- Switch by launching the destination profile, leaving existing windows and
  tabs in their original process. Never mutate the current process's profile,
  session partition, or storage paths after startup. Keep private sessions
  ephemeral and exclude them from saved sessions.
- Include the profile ID in external launchers. Installed web apps from two
  profiles must have distinct launcher identities. OS integration itself
  (default-browser registration, application updates) is application wide.
- Migrations run before Chromium opens storage. Preserve Local State alongside
  cookies and other browser storage. Never silently reset an unreadable profile
  registry, overwrite existing migration targets, or delete a running profile.
- Profile deletion requires a Mira confirmation and the normal unsaved-page
  close checks. Cancellation keeps the profile and all its data.
- Optional settings sync uses the explicit allowlist in
  `electron/profileSettingsPolicy.ts`. Never add tabs, bookmarks, history, site
  permissions, or cookies to it. Apply incoming preferences before initial paint
  and notify open settings views so stale forms cannot overwrite synced values.

Run `npm run test:profiles --workspace apps/desktop` for storage and migration
tests. Build the renderer before `npm run test:profiles-ui --workspace apps/desktop`
for Electron isolation, menu, and restoration tests. Add coverage when changing
profile boundaries or persistence. See [PROFILES.md](PROFILES.md) for the layout.
