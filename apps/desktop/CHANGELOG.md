# Changelog

## Unreleased

## v1.1.2 - 2026-11-12

### Added

- Add history save time setting
- Search/site suggestions taken from history and bookmarks
- Switch to tab in suggestions

### Fixed

- First tab curve got cut off when active
- Improve YouTube ad blocking
- Dev tools can open docked

## v1.1.1 - 2026-11-01

- Fix tab closing animations

## v1.1.0 - 2026-11-01

### Added

- Private windows
- Pinned tabs
- Tab groups with names, colors, and collapse controls
- Mute and unmute tabs
- Recently closed page for restoring tabs, groups, and windows
- Optional minimized window unloading to save memory, with screenshot previews while restoring
- Site permission controls
- Cookie controls and per-site cookie deletion
- USB, Bluetooth, HID, and serial device connection prompts and controls
- Motion and orientation permissions
- Site dialogs, passkey prompts, and unsaved changes protection
- Page zoom controls
- Hard reload and clear cache and reload options when right-clicking the reload button
- YouTube ad skipping option (beta)
- MAILTO link support
- Registration for additional file types, including PDF, SVG, XHTML, MHTML, and XML
- Mira link handling
- PWA Support
- Setting for opening external links in a new window

### Updated

- Redesign tabs, settings, and onboarding
- Move layout settings into a separate section
- URL bar and controls can move into the top bar with vertical tabs
- Round URL bar
- Update dialogs and prompt animations
- Reload button shows a cancel button while loading
- Mira logo hides when the tab bar gets crowded
- Restoring windows initially loads only the active tab to reduce memory use
- Improve session saving with atomic saves and backup recovery
- Update updates page
- Allow fullscreen without permission prompts

### Fixed

- HTTP warning appearing again when navigating to another page on the same site
- URL bar sometimes showing an incorrect URL
- Tabs going blank when restoring windows
- App going blank when switching to vertical tabs
- Network error pages appearing incorrectly
- Back and forward navigation
- Links opening in popup windows when they should open in tabs
- Cross-site cookies
- Missing or incorrect favicons
- Tab titles getting cut off
- Tab scrolling
- Main menu opening and closing when opening site settings

## v1.0.0 - 2026-04-01

- Add report issue button in settings
- Fullscreen hides top bar and tabs
- Localhost urls work
- HTTPS first and HTTP warning page
- Windows stack correctly
- Add open in new window option to the taskbar context menu (Windows)
- Tabs can be dragged out into a new window
- Fix tab animations
- Fix included themes not showing
- Fix nested bookmark folders
- Change tab sleeping indicator
- Fix multi-tab logins

## v0.14.0 - 2026-03-22

- Add view button to update prompt
- Fix context menu open in new tab 
- Fix context menu open in new window
- Bookmark shortcuts work even when webview is focused
- Tabs keep their width when dragging
- Webview has white background
- Fix bookmarks context menu
- Finish bookmarks menu and folders

## v0.13.1 - 2026-03-21

- Update updates page

## v0.13.0 - 2026-03-21

- Add updates page

## v0.12.0 - 2026-03-21

- Fix new tabs opening from links
- Fixed duplicate tab
- Update downloads pop-up
- Restoring goes to last active tab instead of new tab
- Add bookmarks

## v0.11.1 - 2026-03-20

- Progress on fixing updates
- Default browser on Windows now works
- Fix tab dragging
- Fix tab animations
- Work on vertical tabs
- Devtools for correct tab
- Update context menu for vertical tabs

## v0.10.0 - 2026-03-16

- Update prompt
- Links work on windows

## v0.9.3 - 2026-03-12

- Linux release

## v0.9.1 - 2026-03-12

- Add animations toggle
- Add some animations

## v0.9.0 - 2026-02-20

- Add auto update
- Run on startup option
- Opens maximized
- Update installer
- Auto restore
- Onboarding flow
- Add about:blank
- Add tracker blocking
- Add tracker and ad blocker settings to the onboarding flow
- Context menu
- Add faster build scripts for testing (`build:fast`, `build:portable`, `build:nsis`, `build:renderer`)
- Open in new tab works
- Open in new window works
- Add search engine settings
- Add dev settings
- Add most common shortcuts
- _blank and data-link links work now
- Update context menu to use os menu

## v0.8.1 - 2026-02-17

- Fix macOS tab reloading issue

## v0.8.0 - 2026-02-17

- History shows site title
- Restoring tabs will restore all windows and window locations
- Work on updates
- Use real Windows window controls
- Added layouts, similar to themes
- Tabs can be rearranged
- Settings for new tab logo and welcome message
- Devtools now work
- Tab name updates correctly for internal pages
- Add shortcut to reopen last closed tab
- Auto focus address bar
- Shortcuts work while address bar is focused
- Find in page
- Shortcuts to swap tabs

## v0.7.0 - 2026-02-15

- Added more menu options (new tab/window, history, downloads, print, settings).
- Added a theme creator page (`mira://themecreator`).
- Added better multi-window support.
- Improved keyboard shortcuts, including macOS behavior.
- Improved the top bar/address bar and icons.
- Improved macOS window controls and fullscreen behavior.
- Fixed `Ctrl+N` opening too many windows.
- Fixed address/navigation issues.

## v0.6.0 - 2026-02-13

- Added tab sleeping.
- Added error pages.
- Added app icon.
- Themes

## v0.5.0 - 2026-02-12

- New tab url setting
- Middle click opens link in new tab

## v0.4.0 - 2026-02-12

- Added downloads.
- Added browsing history.
- Tabs restore on reopen

## v0.3.0 - 2026-02-11

- Added keyboard shortcuts.
- Added forward/back/reload navigation buttons.
- Added address bar search fallback for non-URL input.
- Improved tab behavior.

## v0.2.0 - 2026-02-11

- Migrated to Electron.
- Added tab support.

## v0.1.0 - 2026-02-09

- Initial release.
- Added ESLint setup.
