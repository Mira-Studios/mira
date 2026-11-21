# Desktop App

## Setup

Install dependencies:
```bash
npm install # From root
# New dependencies may be added, run this command again to install them
```

## Development

```bash
# Run the dev app
npm run desktop:dev # From root
npm run dev # In apps/desktop
```

Development runs as **Mira Dev** with a separate profile (`%APPDATA%\Mira Dev`
on Windows). Its settings, history, tabs, cookies, and site storage persist across
dev runs without sharing the installed app's profile. Both apps can run at the
same time. Development does not register OS link handlers or change the installed
app's Windows taskbar tasks.

## Building

Workspaces live inside their owning profile's AppData folder in
`workspaces.v1.json`. Open or create them from the main menu, or enable the
Workspaces section in Settings → Layout → Sidebar. Each workspace has one
window, saved tabs (or a fixed starting set), and its own window preferences.
Manage workspaces in Settings → Workspaces. Editing opens the owning workspace
window. Its Workspace settings menu item sits directly below Settings and uses
the same Settings sections and controls, with a Workspace section for identity
and starting tabs. Normal and private windows have no Workspace settings menu
item. The workspace name and icon appear in its title bar. Profile browsing storage remains shared within that
profile; workspace settings and sessions are excluded from profile settings sync.
Restart restoration includes normal New Tab windows and reopens workspace
windows separately, preserving workspace ownership even when restoring tabs.

Run `npm run test:workspaces --workspace apps/desktop` for storage tests. Build
the renderer before `npm run test:workspaces-ui --workspace apps/desktop` for
the isolated Electron workspace flow.

```bash
# Build
npm run desktop:build # From root
npm run build # In apps/desktop
```

## App Structure

```
apps/desktop/
├── electron/         # Main process code
├── src/              # Renderer process (React)
├── assets/           # Icons and static files
├── dist/             # Build output (generated)
└── release/          # Packaged apps (generated)
```
