import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  getGitHubRepository,
  type GitRepositoryLink,
  type GitEditorRepository,
} from './githubRepository.ts';
import {
  openGitFile,
  readGitDiff,
  readGitSnapshot,
  resolveGitRoot,
  resolveEditorGitRoot,
  readGitHubRemote,
} from './localGit.ts';

export function setupGitRepositories(isPrivate: (window: BrowserWindow) => boolean): void {
  const links = new Map<string, GitRepositoryLink>();
  const privateLinks = new Map<number, Map<string, GitRepositoryLink>>();
  const editorRoots = new Map<number, Map<string, string>>();
  function owner(event: IpcMainInvokeEvent) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame)
      throw new Error('Git access requires the browser window.');
    return win;
  }
  const file = path.join(app.getPath('userData'), 'git-repositories.json');
  const loaded = fs
    .readFile(file, 'utf8')
    .then((text) => {
      const data: unknown = JSON.parse(text);
      if (
        data &&
        typeof data === 'object' &&
        'version' in data &&
        data.version === 1 &&
        'links' in data &&
        Array.isArray(data.links)
      ) {
        for (const entry of data.links) {
          if (
            Array.isArray(entry) &&
            typeof entry[0] === 'string' &&
            getGitHubRepository(`https://github.com/${entry[0]}`)?.key === entry[0] &&
            typeof entry[1]?.path === 'string'
          )
            links.set(entry[0], { path: entry[1].path });
        }
      }
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        console.warn('Could not load Git repository links:', error.message);
    });
  let saving = Promise.resolve();
  function persist() {
    const text = JSON.stringify({ version: 1, links: [...links] });
    const operation = saving.then(async () => {
      await fs.writeFile(`${file}.tmp`, text, 'utf8');
      await fs.rename(`${file}.tmp`, file);
    });
    saving = operation.catch(() => undefined);
    return operation;
  }
  async function access(event: IpcMainInvokeEvent, raw: unknown) {
    const win = owner(event);
    const repo = typeof raw === 'string' ? getGitHubRepository(raw) : null;
    if (!repo) throw new Error('Open a GitHub repository to use local Git.');
    await loaded;
    let entries = links;
    if (isPrivate(win)) {
      if (!privateLinks.has(win.id)) {
        privateLinks.set(win.id, new Map());
        win.once('closed', () => privateLinks.delete(win.id));
      }
      entries = privateLinks.get(win.id)!;
    }
    return { win, repo, entries };
  }
  async function directory(event: IpcMainInvokeEvent, raw: unknown) {
    owner(event);
    if (typeof raw === 'string' && raw.startsWith('file:')) {
      const root = editorRoots.get(event.sender.id)?.get(raw);
      if (!root) throw new Error('Open this repository in the file editor first.');
      if ((await resolveGitRoot(root)) !== (await fs.realpath(root)))
        throw new Error('The file’s repository is no longer available.');
      return root;
    }
    const { repo, entries } = await access(event, raw);
    const link = entries.get(repo.key);
    if (!link) throw new Error('Link a local repository first.');
    // A saved link must still point to the same Git root, not a new parent repo.
    if ((await resolveGitRoot(link.path)) !== (await fs.realpath(link.path)))
      throw new Error('The linked folder is no longer a Git repository. Choose its folder again.');
    return link.path;
  }
  function changed() {
    for (const win of BrowserWindow.getAllWindows())
      if (!win.isDestroyed() && !isPrivate(win)) win.webContents.send('git-links-changed');
  }
  ipcMain.handle(
    'git-repository-editor-get',
    async (event, raw: unknown): Promise<GitEditorRepository | null> => {
      const win = owner(event);
      if (typeof raw !== 'string') throw new Error('Choose a local file.');
      const root = await resolveEditorGitRoot(raw);
      if (!root) {
        editorRoots.get(event.sender.id)?.delete(raw);
        return null;
      }
      await loaded;
      if (win.isDestroyed()) return null;
      let roots = editorRoots.get(event.sender.id);
      if (!roots) {
        roots = new Map();
        editorRoots.set(event.sender.id, roots);
        const senderId = event.sender.id;
        event.sender.once('destroyed', () => editorRoots.delete(senderId));
      }
      roots.set(raw, root);
      const entries = isPrivate(win) ? privateLinks.get(win.id) : links;
      const linked = [...(entries ?? [])].find(([, link]) => link.path === root);
      const github = linked
        ? getGitHubRepository(`https://github.com/${linked[0]}`)
        : await readGitHubRemote(root);
      return {
        repository: {
          key: `local:${root}`,
          name: github?.name ?? path.basename(root),
          github: github?.key ?? null,
        },
        link: { path: root },
        target: raw,
      };
    },
  );
  ipcMain.handle('git-repository-link-get', async (event, raw: unknown) => {
    const { repo, entries } = await access(event, raw);
    return entries.get(repo.key) ?? null;
  });
  ipcMain.handle('git-repository-link-pick', async (event, raw: unknown) => {
    const { win, repo, entries } = await access(event, raw);
    const result = await dialog.showOpenDialog(win, {
      title: `Link ${repo.name} to a local repository`,
      buttonLabel: 'Link repository',
      properties: ['openDirectory'],
      defaultPath: entries.get(repo.key)?.path,
    });
    if (result.canceled || !result.filePaths[0] || win.isDestroyed()) return null;
    const link = { path: await resolveGitRoot(result.filePaths[0]) };
    entries.set(repo.key, link);
    if (entries === links) {
      await persist();
      changed();
    }
    return link;
  });
  ipcMain.handle('git-repository-unlink', async (event, raw: unknown) => {
    const { repo, entries } = await access(event, raw);
    entries.delete(repo.key);
    if (entries === links) {
      await persist();
      changed();
    }
  });
  ipcMain.handle('git-repository-status', async (event, raw: unknown) =>
    readGitSnapshot(await directory(event, raw)),
  );
  ipcMain.handle('git-repository-diff', async (event, raw: unknown, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Choose a file to view its changes.');
    return readGitDiff(await directory(event, raw), name);
  });
  ipcMain.handle('git-repository-file', async (event, raw: unknown, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Choose a repository file.');
    return openGitFile(await directory(event, raw), name);
  });
}
