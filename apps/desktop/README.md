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
