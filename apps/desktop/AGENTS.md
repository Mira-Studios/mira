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
- Workspaces are owned by the current profile and stored in `workspaces.v1.json`
  under its `userData` directory. A workspace owns one window. Tag its restart
  snapshot with its workspace ID, restore it into that workspace, and never merge
  its tabs into ordinary windows. Prevent tab transfers across workspace
  boundaries. Read preferences through `getBrowserSettings()` and write through
  `saveBrowserSettings()` so window overrides remain workspace scoped. Add new
  window-local preferences to `electron/workspacePolicy.ts` deliberately; never
  include cookies, history, profile sync, OS integration, or other profile data.
  Workspace creation only collects identity; editing belongs on its settings page.
- Picture-in-picture windows are auxiliary players, never browser windows or
  session-restore targets. Route video/controls only between the owning guest
  frame and its player. Keep source tabs/windows awake while a player is active.
  Placement preferences live in profile `userData`; private placements stay in
  memory. In-window and desktop positions are separate, with the latest resized
  size carried between modes. Never use native owner/child relationships for PiP;
  keep its in-window presentation bounded to its owner and follow owner visibility.

Run `npm run test:profiles --workspace apps/desktop` for storage and migration
tests. Build the renderer before `npm run test:profiles-ui --workspace apps/desktop`
for Electron isolation, menu, and restoration tests. Add coverage when changing
profile boundaries or persistence. See [PROFILES.md](PROFILES.md) for the layout.
