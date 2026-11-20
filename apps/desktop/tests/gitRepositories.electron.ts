// Build the renderer first, then run with Electron (ELECTRON_RUN_AS_NODE unset).
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setupGitRepositories } from '../electron/gitRepositories.ts';
import { setupSiteInteractions } from '../electron/siteInteractions.ts';
import { setupFileEditors } from '../electron/fileEditors.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = path.resolve(root, '../../../.tmp');
mkdirSync(tempRoot, { recursive: true });
const profile = mkdtempSync(path.join(tempRoot, 'git-ui-'));
const repo = path.join(profile, 'repo');
mkdirSync(repo);
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' });
git('init', '--initial-branch=main');
git('config', 'user.name', 'Mira Test');
git('config', 'user.email', 'test@example.com');
git('config', 'commit.gpgsign', 'false');
git('config', 'core.autocrlf', 'false');
const olderDate = new Date(Date.now() - 8 * 86_400_000).toISOString();
git('commit', '--allow-empty', '-m', 'Refine browser controls', `--date=${olderDate}`);
git(
  '-c',
  'user.name=Jamie Chen',
  'commit',
  '--allow-empty',
  '-m',
  'Polish repository settings',
  `--date=${olderDate}`,
);
for (let index = 0; index < 12; index++)
  git('commit', '--allow-empty', '-m', `Sidebar history ${index + 1}`);
writeFileSync(path.join(repo, 'hello.txt'), 'original\n');
git('add', '.');
git('commit', '-m', 'Initial UI test commit');
const latestCommitHash = git('rev-parse', 'HEAD').trim();
writeFileSync(path.join(repo, 'hello.txt'), 'modified\n');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => app.exit(1), 90_000);
const url = 'https://github.com/Owner/Repo/issues';
const makeTab = (id: string, address: string) => ({
  id,
  url: address,
  title: address,
  history: [address],
  historyIndex: 0,
  reloadToken: 0,
  isSleeping: false,
  lastActiveAt: Date.now(),
});
ipcMain.handle('git-test-call', (_event, channel: string) => {
  if (channel === 'session-take-window-restore')
    return {
      tabs: [makeTab('github-test', url), makeTab('blank', 'mira://NewTab')],
      activeId: 'github-test',
      savedAt: Date.now(),
    };
  if (
    [
      'history-list',
      'recently-closed-get',
      'incoming-urls-consume',
      'device-connections-state',
      'open-tabs-list',
    ].includes(channel)
  )
    return [];
  if (channel === 'window-consume-initial-url') return '';
  return null;
});
async function until(check: () => Promise<boolean>, message: string) {
  const expires = Date.now() + 15_000;
  while (!(await check())) {
    assert.ok(Date.now() < expires, message);
    await delay(40);
  }
}

async function run() {
  await app.whenReady();
  setupFileEditors();
  const privateIds = new Set<number>();
  setupGitRepositories((win) => privateIds.has(win.id));
  setupSiteInteractions((contents) => BrowserWindow.fromWebContents(contents));
  await session.defaultSession.protocol.handle(
    'https',
    () =>
      new Response('<html><title>GitHub fixture</title><body>Repository page</body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
  );
  let picks = 0;
  let pick: string | null = null;
  dialog.showOpenDialog = (async () => {
    picks++;
    return { canceled: !pick, filePaths: pick ? [pick] : [] };
  }) as typeof dialog.showOpenDialog;
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(root, 'fixtures/git-preload.cjs'),
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  const evaluate = <T = unknown>(code: string) =>
    win.webContents.executeJavaScript(code) as Promise<T>;
  const click = (label: string) =>
    evaluate(
      `(() => { const label = ${JSON.stringify(label)}; const button = [...document.querySelectorAll('button')].find(b => b.checkVisibility() && (b.getAttribute('aria-label') === label || b.textContent.trim() === label)); button?.click(); return !!button; })()`,
    );
  const invoke = (channel: string, ...args: unknown[]) =>
    evaluate(
      `window.electron.ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
    );
  const capture = async (name: string) => {
    await evaluate(
      `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );
    await delay(120);
    writeFileSync(path.join(profile, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  const resizeSidebarTo = async (width: number) => {
    const handle = await evaluate<{ x: number; y: number; width: number }>(
      `(() => { const box = document.querySelector('[aria-label="Resize local Git sidebar"]').getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), width: document.querySelector('.git-repository-dock').getBoundingClientRect().width }; })()`,
    );
    const x = handle.x + handle.width - width;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: handle.x, y: handle.y });
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: handle.x,
      y: handle.y,
      button: 'left',
      clickCount: 1,
    });
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y: handle.y, button: 'left' });
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x,
      y: handle.y,
      button: 'left',
      clickCount: 1,
    });
    await until(
      () =>
        evaluate(
          `document.querySelector('.git-repository-dock').getBoundingClientRect().width === ${width}`,
        ),
      'Sidebar drag reaches the requested width',
    );
  };
  try {
    await win.loadFile(path.resolve(root, '../dist/index.html'));
    await until(
      () =>
        evaluate(
          `!!document.querySelector('[aria-label="Link local Git repository"]:not(:disabled)')`,
        ),
      'Git button appears on GitHub repo',
    );
    const fullPageWidth = await evaluate<number>(
      `document.querySelector('webview').getBoundingClientRect().width`,
    );
    await click('Link local Git repository');
    await until(
      () =>
        evaluate(`!document.querySelector('[aria-label="Link local Git repository"]').disabled`),
      'Cancelled picker finishes',
    );
    assert.equal(await evaluate(`!!document.querySelector('.git-repository-view')`), false);
    assert.equal(await invoke('git-repository-link-get', url), null);
    pick = repo;
    await click('Link local Git repository');
    await until(
      () => evaluate(`!!document.querySelector('.git-file')`),
      'Local Git status renders',
    );
    assert.equal(
      await evaluate(`document.querySelector('.git-branch-bar').textContent.includes('main')`),
      true,
    );
    assert.equal(
      await evaluate(
        `(() => { const page = document.querySelector('webview'); const pageBox = page.getBoundingClientRect(); const dock = document.querySelector('.git-repository-dock').getBoundingClientRect(); return getComputedStyle(page).visibility === 'visible' && pageBox.width > 300 && dock.width === 420 && pageBox.right <= dock.left + 1; })()`,
      ),
      true,
      'GitHub stays visible beside the docked Git sidebar',
    );
    await evaluate(
      `document.querySelector('[aria-label="Resize local Git sidebar"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))`,
    );
    await until(
      () =>
        evaluate(
          `document.querySelector('.git-repository-dock').getBoundingClientRect().width === 440`,
        ),
      'Sidebar resizes with the keyboard',
    );
    const handle = await evaluate<{ x: number; y: number }>(
      `(() => { const box = document.querySelector('[aria-label="Resize local Git sidebar"]').getBoundingClientRect(); return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }; })()`,
    );
    win.webContents.sendInputEvent({ type: 'mouseMove', ...handle });
    win.webContents.sendInputEvent({ type: 'mouseDown', ...handle, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({
      type: 'mouseMove',
      x: handle.x - 40,
      y: handle.y,
      button: 'left',
    });
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: handle.x - 40,
      y: handle.y,
      button: 'left',
      clickCount: 1,
    });
    await until(
      () =>
        evaluate(
          `document.querySelector('.git-repository-dock').getBoundingClientRect().width === 480`,
        ),
      'Sidebar resizes by dragging its divider',
    );
    const chromeGeometry = `JSON.stringify(['.git-toolbar', '.git-branch-bar', '.git-view-tabs'].map(selector => { const element = document.querySelector(selector); const box = element.getBoundingClientRect(); return { selector, x: box.x, y: box.y, width: box.width, height: box.height }; }))`;
    const originalChromeGeometry = await evaluate<string>(chromeGeometry);
    await click('Show commits');
    assert.equal(
      await evaluate(chromeGeometry),
      originalChromeGeometry,
      'Switching sidebar tabs leaves all chrome above the content fixed',
    );
    assert.equal(
      await evaluate(`document.querySelectorAll('.git-commit-group').length`),
      2,
      'Commits are grouped by day',
    );
    await evaluate(
      `(() => { const select = document.querySelector('[aria-label="Filter commits by author"]'); select.value = 'Jamie Chen'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
    assert.equal(
      await evaluate(`document.querySelectorAll('.git-commit-row').length`),
      1,
      'Author filter narrows the commit list',
    );
    await evaluate(
      `(() => { const select = document.querySelector('[aria-label="Filter commits by time"]'); select.value = 'day'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
    assert.equal(
      await evaluate(`document.querySelectorAll('.git-commit-row').length`),
      0,
      'Author and time filters combine',
    );
    await click('Show changes');
    assert.equal(
      await evaluate(
        `!!document.querySelector('.git-file-list')?.checkVisibility() && !document.querySelector('.git-commits')?.checkVisibility()`,
      ),
      true,
      'Changes displays only its own content',
    );
    await click('Show commits');
    await until(
      () => evaluate(`!!document.querySelector('.git-commits')?.checkVisibility()`),
      'Commits content becomes visible',
    );
    assert.deepEqual(
      await evaluate(
        `({ author: document.querySelector('[aria-label="Filter commits by author"]').value, period: document.querySelector('[aria-label="Filter commits by time"]').value })`,
      ),
      { author: 'Jamie Chen', period: 'day' },
      'Commit filters survive switching sidebar tabs',
    );
    await click('Clear filters');
    const commitScroll = await evaluate<number>(
      `(() => { const list = document.querySelector('.git-commits'); list.scrollTop = 240; return list.scrollTop; })()`,
    );
    assert.ok(commitScroll > 0, 'Commit list has enough entries to scroll');
    await click('Show changes');
    await click('Show commits');
    assert.equal(
      await evaluate(`document.querySelector('.git-commits').scrollTop`),
      commitScroll,
      'Commit scroll position survives sidebar tab switching',
    );
    await evaluate(
      `(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__gitCopiedSha = text; } } }); document.querySelector('[aria-label^="Copy commit hash"]').click(); })()`,
    );
    await until(
      () =>
        evaluate(
          `window.__gitCopiedSha === ${JSON.stringify(latestCommitHash)} && !!document.querySelector('[aria-label^="Copied commit"]')`,
        ),
      'Copy button copies the full commit hash and confirms success',
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.git-commits').textContent.includes('Initial UI test commit')`,
      ),
      true,
      'Commits have their own view',
    );
    await click('Show changes');
    await evaluate(`document.querySelector('.git-file').click()`);
    await until(
      () => evaluate(`document.querySelector('.git-diff-pane').textContent.includes('+modified')`),
      'Local diff renders',
    );
    writeFileSync(
      path.join(repo, 'hello.txt'),
      'modified\n' + Array.from({ length: 160 }, (_, index) => `line ${index + 1}\n`).join(''),
    );
    await click('Refresh repository');
    await until(
      () => evaluate(`document.querySelectorAll('.git-diff-line').length > 100`),
      'Long diff is ready for scroll preservation',
    );
    const diffScroll = await evaluate<number>(
      `(() => { const diff = document.querySelector('.git-diff-pane'); diff.scrollTop = 300; return diff.scrollTop; })()`,
    );
    assert.ok(diffScroll > 0, 'Diff is scrollable');
    await click('Show commits');
    assert.equal(
      await evaluate(
        `!!document.querySelector('.git-commits')?.checkVisibility() && !document.querySelector('.git-diff-pane')?.checkVisibility()`,
      ),
      true,
      'Commits hides the Changes diff',
    );
    await click('Show changes');
    await until(
      () => evaluate(`!!document.querySelector('.git-diff-pane')?.checkVisibility()`),
      'Selected file diff is restored when returning to Changes',
    );
    assert.equal(
      await evaluate(`document.querySelector('.git-diff-pane').scrollTop`),
      diffScroll,
      'Changes retains the selected file and diff scroll position',
    );
    writeFileSync(path.join(repo, 'hello.txt'), 'modified\n');
    assert.equal(
      await evaluate(`document.querySelectorAll('.git-file').length`),
      0,
      'File diff uses the full sidebar content area',
    );
    assert.equal(
      await evaluate(`document.querySelector('.git-diff-pane').textContent.includes('diff --git')`),
      false,
      'Diff hides Git file metadata',
    );
    await click('Back to changes');
    assert.equal(
      await evaluate(`document.querySelectorAll('.git-file').length`),
      1,
      'Back returns to the changed files list',
    );
    await evaluate(`document.querySelector('webview').dataset.preserved = 'yes'`);
    await click('Close local Git sidebar');
    assert.equal(
      await evaluate(`!!document.querySelector('.git-repository-view')?.checkVisibility()`),
      false,
    );
    assert.equal(
      await evaluate(`document.querySelector('webview').getBoundingClientRect().width`),
      fullPageWidth,
      'Closing the sidebar restores the full page width',
    );
    await click('Show local Git sidebar');
    await until(
      () => evaluate(`!!document.querySelector('.git-file')`),
      'Linked button opens the Git sidebar',
    );
    assert.equal(
      await evaluate(
        `document.querySelector('.git-repository-dock').getBoundingClientRect().width`,
      ),
      480,
      'Sidebar remembers its resized width',
    );
    await click('Hide local Git sidebar');
    assert.equal(
      await evaluate(`!!document.querySelector('.git-repository-dock')?.checkVisibility()`),
      false,
      'URL bar button hides the sidebar',
    );
    await click('Show local Git sidebar');
    await until(
      () => evaluate(`!!document.querySelector('.git-file')`),
      'URL bar button reopens the sidebar',
    );
    assert.equal(picks, 2, 'Toggling does not reopen picker');
    assert.equal(
      await evaluate(`document.querySelector('webview').dataset.preserved`),
      'yes',
      'GitHub webview preserved',
    );
    await evaluate(`document.querySelector('[data-tab-id="blank"]').click()`);
    await until(
      () =>
        evaluate(
          `!document.querySelector('.git-address-button') && !document.querySelector('.git-repository-view')?.checkVisibility()`,
        ),
      'Local view is scoped to its GitHub tab',
    );
    await evaluate(`document.querySelector('[data-tab-id="github-test"]').click()`);
    await until(
      () => evaluate(`!!document.querySelector('.git-file')`),
      'Returning to the repo tab restores its local view',
    );
    writeFileSync(path.join(repo, 'new.txt'), 'new local file\n');
    await click('Refresh repository');
    await until(
      () => evaluate(`document.querySelectorAll('.git-file').length === 2`),
      'Refresh picks up external changes',
    );
    const saved = JSON.parse(readFileSync(path.join(profile, 'git-repositories.json'), 'utf8'));
    assert.equal(saved.links[0][0], 'owner/repo');
    await evaluate(`document.querySelector('.git-file').click()`);
    await until(
      () => evaluate(`document.querySelector('.git-diff-pane').textContent.includes('+modified')`),
      'Diff reopens',
    );
    assert.equal(
      await evaluate(
        `(() => { const view = document.querySelector('.git-repository-dock'); const box = view.getBoundingClientRect(); const page = document.querySelector('webview').getBoundingClientRect(); return box.width === 480 && box.height > 400 && page.right <= box.left + 1 && getComputedStyle(view).visibility === 'visible'; })()`,
      ),
      true,
      'Git sidebar remains beside the page while showing a diff',
    );
    await capture('local-git-view');
    await click('Back to changes');
    await capture('local-git-changes');
    await click('Show commits');
    await capture('local-git-commits');
    await click('Show changes');
    await resizeSidebarTo(280);
    assert.equal(
      await evaluate(
        `(() => { const dock = document.querySelector('.git-repository-dock').getBoundingClientRect(); return [...document.querySelectorAll('.git-toolbar button')].every(button => { const box = button.getBoundingClientRect(); return box.left >= dock.left && box.right <= dock.right; }); })()`,
      ),
      true,
      'Toolbar remains usable at the minimum sidebar width',
    );
    await evaluate(`document.querySelector('.git-file').click()`);
    await until(
      () => evaluate(`document.querySelector('.git-diff-pane').textContent.includes('+modified')`),
      'Diff works in a narrow sidebar',
    );
    await evaluate(
      `(() => { const settings = JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}'); localStorage.setItem('mira.settings.browser.v1', JSON.stringify({ ...settings, themeId: 'default_light' })); window.dispatchEvent(new Event('mira:settings-changed')); })()`,
    );
    await capture('local-git-light-narrow');
    await click('Show commits');
    await capture('local-git-commits-light-narrow');
    assert.equal(
      await evaluate(
        `(() => { const dock = document.querySelector('.git-repository-dock').getBoundingClientRect(); return [...document.querySelectorAll('.git-commit-row-actions button')].every(button => { const box = button.getBoundingClientRect(); return box.left >= dock.left && box.right <= dock.right; }); })()`,
      ),
      true,
      'Commit actions fit the narrow sidebar',
    );
    await click('Show changes');
    await evaluate(
      `(() => { const settings = JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}'); localStorage.setItem('mira.settings.browser.v1', JSON.stringify({ ...settings, themeId: 'default_dark' })); window.dispatchEvent(new Event('mira:settings-changed')); })()`,
    );
    await resizeSidebarTo(480);
    for (const channel of [
      'link-get',
      'link-pick',
      'unlink',
      'status',
      'diff',
      'file',
      'editor-get',
    ])
      ipcMain.removeHandler(`git-repository-${channel}`);
    setupGitRepositories((win) => privateIds.has(win.id));
    const reloaded = new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    );
    win.reload();
    await reloaded;
    await until(
      () =>
        evaluate(
          `!!document.querySelector('[aria-label="Show local Git sidebar"]:not(:disabled)')`,
        ),
      'Link survives renderer reload',
    );
    await click('Show local Git sidebar');
    await until(() => evaluate(`!!document.querySelector('.git-file')`), 'Saved link reopens');
    assert.equal(
      await evaluate(
        `document.querySelector('.git-repository-dock').getBoundingClientRect().width`,
      ),
      480,
      'Sidebar width survives renderer reload',
    );
    await click('Repository options');
    await click('Unlink repository');
    await until(
      () =>
        evaluate(
          `!!document.querySelector('[aria-label="Link local Git repository"]:not(:disabled)')`,
        ),
      'Unlink returns to GitHub',
    );
    assert.equal(await invoke('git-repository-link-get', url), null);
    assert.equal(
      readFileSync(path.join(repo, 'hello.txt'), 'utf8'),
      'modified\n',
      'Viewing leaves working files intact',
    );
    // Private windows do not persist folder associations.
    const privateWin = new BrowserWindow({
      show: false,
      title: 'Private test',
      webPreferences: { preload: path.join(root, 'fixtures/git-preload.cjs') },
    });
    privateIds.add(privateWin.id);
    await privateWin.loadURL('about:blank');
    await privateWin.webContents.executeJavaScript(
      `window.electron.ipcRenderer.invoke('git-repository-link-pick', ${JSON.stringify(url)})`,
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(profile, 'git-repositories.json'), 'utf8')).links.length,
      0,
    );
    privateWin.destroy();
    const editorFileUrl = pathToFileURL(path.join(repo, 'hello.txt')).href;
    await assert.rejects(invoke('git-repository-status', editorFileUrl), /file editor first/);
    const pickerCount = picks;
    win.webContents.send('open-url-in-new-tab', editorFileUrl);
    await until(
      () =>
        evaluate(
          `!!document.querySelector('iframe')?.contentDocument?.querySelector('.monaco-editor') && !!document.querySelector('[aria-label="Show local Git sidebar"]:not(:disabled)')`,
        ),
      'Local file editor discovers its Git repository',
    );
    assert.equal(
      await evaluate(
        `(() => { const git = document.querySelector('.git-address-button').getBoundingClientRect(); const save = document.querySelector('[aria-label="Save file"]').getBoundingClientRect(); const file = document.querySelector('[aria-label="Show file path"]').getBoundingClientRect(); return save.right <= git.left && file.right <= save.left; })()`,
      ),
      true,
      'Git, Save, and the file path do not overlap',
    );
    await click('Show local Git sidebar');
    await until(
      () =>
        evaluate(
          `!!document.querySelector('.git-file') && document.querySelector('.git-branch-bar').textContent.includes('main')`,
        ),
      'Git sidebar opens beside Monaco',
    );
    assert.equal(picks, pickerCount, 'Opening Git from a local file needs no folder picker');
    assert.equal(
      await evaluate(
        `(() => { const editor = document.querySelector('iframe').getBoundingClientRect(); const git = document.querySelector('.git-repository-dock').getBoundingClientRect(); return editor.width > 300 && editor.right <= git.left + 1; })()`,
      ),
      true,
      'Editor remains visible next to the Git sidebar',
    );
    const themeIconCheck = `(() => { const button = document.querySelector('.git-address-button'); const icon = button.querySelector('.git-logo'); const header = document.querySelector('.git-toolbar'); const mark = header.querySelector('.git-logo'); return icon instanceof SVGSVGElement && getComputedStyle(icon.querySelector('path')).fill === getComputedStyle(button).color && getComputedStyle(mark.querySelector('path')).fill === getComputedStyle(header).color; })()`;
    assert.equal(
      await evaluate(themeIconCheck),
      true,
      'Git marks inherit the dark theme foreground',
    );
    await capture('editor-git-dark');
    await evaluate(
      `(() => { const settings = JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}'); localStorage.setItem('mira.settings.browser.v1', JSON.stringify({ ...settings, themeId: 'default_light' })); window.dispatchEvent(new Event('mira:settings-changed')); })()`,
    );
    assert.equal(
      await evaluate(themeIconCheck),
      true,
      'Git marks inherit the light theme foreground',
    );
    await capture('editor-git-light');
    await click('Show commits');
    assert.equal(
      await evaluate(
        `!![...document.querySelectorAll('.git-commits button')].find(button => (button.getAttribute('aria-label') || '').includes('on GitHub'))`,
      ),
      false,
      'Local repositories without a remote do not invent GitHub links',
    );
    const otherRepo = path.join(profile, 'other-project');
    mkdirSync(otherRepo);
    execFileSync('git', ['init', '--initial-branch=feature'], {
      cwd: otherRepo,
      windowsHide: true,
    });
    writeFileSync(path.join(otherRepo, 'other.txt'), 'A different local repository');
    win.webContents.send(
      'open-url-in-new-tab',
      pathToFileURL(path.join(otherRepo, 'other.txt')).href,
    );
    await until(
      () =>
        evaluate(
          `!!document.querySelector('[aria-label="Show local Git sidebar"]:not(:disabled)')`,
        ),
      'Another editor file detects its own repository',
    );
    await click('Show local Git sidebar');
    await until(
      () =>
        evaluate(
          `document.querySelector('.git-repo-identity h1')?.textContent === 'other-project' && document.querySelector('.git-branch-bar')?.textContent.includes('feature') && !!document.querySelector('[aria-label="View untracked file other.txt"]')`,
        ),
      'Git sidebar follows the active editor file’s repository',
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(profile, 'git-repositories.json'), 'utf8')).links.length,
      0,
      'Editor discovery does not persist GitHub folder links',
    );
    console.log(`Git UI smoke passed. Screenshot: ${path.join(profile, 'local-git-view.png')}`);
  } finally {
    win.destroy();
    clearTimeout(deadline);
  }
}
run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
