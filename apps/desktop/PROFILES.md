# Desktop profiles

Mira keeps profiles **inside its existing AppData folder**:

```text
Mira/                         (Mira Dev/ for development)
  profiles.json               names, IDs, removal requests, restore roster
  profiles.json.bak
  Profiles/
    default/                  existing data migrates here on first launch
      Local State
      Network/                Chromium cookies and network state
      Local Storage/          renderer and site localStorage
      IndexedDB/
      Cache/
      Partitions/             any persistent Electron partitions
      session.json            tabs, groups, window bounds, active tabs
      session.json.bak
      history.json
      site-permissions.json
      app-state.json
      profile-avatar.png
      background-images/
      web-apps/
      ...                     all other existing and future profile files
    <uuid>/                   each additional profile has the same isolation
```

The precise parent is the AppData directory Mira already used, rather than a
new sibling directory. Migration moves legacy files in place before Electron
opens them, including Chromium's encryption metadata. An interrupted migration
resumes; conflicting files or unreadable registries stop startup to preserve
data. Renaming a profile changes its display name, never its storage path.

Each profile owns a separate Electron process and its own `userData` and
`sessionData`. This isolates all existing main-process singletons and Chromium
storage. New features using the normal storage APIs inherit isolation without
manually prefixing every key. Desktop `AGENTS.md` makes this a requirement for
future work. Do not change those paths or move tabs between processes.

Profiles have their own section in Settings and appear inside the main menu.
Settings → Profiles → Show profile menu in the toolbar moves the controls to a
picture/icon button between Site Settings and Menu for that profile. They are
shown in only one menu location at a time. Edit a profile to rename it or choose/remove a picture. Pictures
are copied into profile storage as small PNGs. Opening a profile creates a new
window and leaves the current window's tabs intact.

A normal application launch shows an onboarding-style profile picker when
there is more than one profile. Settings → Profiles → Ask which profile to open
on startup is enabled by default. With one profile, or with the picker disabled,
Mira opens the default/first remaining profile. Explicit profile, private-window,
and installed-app launches bypass the picker. Each selected profile applies its
own startup restore preference and restores only its own saved windows/tabs.
All profiles keep their own recently closed lists.

Settings → Profiles → Sync settings between profiles lets users opt individual
profiles into a shared preference group. Only browser preferences, custom theme
definitions, custom layout definitions, and referenced wallpaper assets sync.
Tabs, bookmarks, history, downloads, cookies, permissions, and other site data
never enter the sync bundle. Each profile keeps a local settings snapshot; the
registry points to the latest opted-in source. Joining adopts that group's
settings; leaving keeps a private copy. Private windows have no profile controls.

Removal requires confirmation. Open profile processes receive the removal
request, run their usual unsaved-page checks, flush sessions, and exit before
their directories are deleted. Removing the current profile opens another
profile to complete the operation. Cancelling an unsaved-page prompt keeps the
profile. At least one profile must remain. Downloaded files outside the profile
directory are retained.

Default-browser registration and installing an application update operate on
the application/OS. Profile isolation does not duplicate the Mira executable.
