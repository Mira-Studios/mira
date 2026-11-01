import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { SessionStore } from '../electron/sessionStore.ts';

type Snapshot = { tabs: string[] };
const first: Snapshot = { tabs: ['https://first.example'] };
const second: Snapshot = { tabs: ['https://second.example'] };
const third: Snapshot = { tabs: ['https://third.example'] };

function normalize(value: unknown): Snapshot | null {
  if (typeof value !== 'object' || !value || !('tabs' in value)) return null;
  const tabs = value.tabs;
  return Array.isArray(tabs) && tabs.length > 0 && tabs.every((tab) => typeof tab === 'string')
    ? { tabs }
    : null;
}

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-session-'));
  const filePath = path.join(directory, 'session.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reopen = () => new SessionStore(() => filePath, normalize);
  const read = (file = filePath) => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { directory, filePath, backupPath: `${filePath}.bak`, store: reopen(), reopen, read };
}

function pauseNextWrite(t: TestContext) {
  const writeFile = fs.promises.writeFile;
  let resume!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let pause = true;
  t.mock.method(fs.promises, 'writeFile', async (...args: Parameters<typeof writeFile>) => {
    await writeFile(...args);
    if (pause) {
      pause = false;
      reached();
      await released;
    }
  });
  t.after(resume);
  return { paused, resume };
}

for (const synchronous of [false, true]) {
  const mode = synchronous ? 'shutdown' : 'live';

  test(`${mode} saves seed a backup, then retain the previous complete session`, async (t) => {
    const { store, reopen, read, backupPath, directory } = fixture(t);
    const save = (snapshot: Snapshot) =>
      synchronous ? store.saveSync(snapshot) : store.save(snapshot);
    await save(first);
    assert.deepEqual(read(), first);
    assert.deepEqual(read(backupPath), first);
    await save(second);
    assert.deepEqual(await reopen().load(), second);
    assert.deepEqual(read(backupPath), first);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['session.json', 'session.json.bak']);
  });

  test(`${mode} saves preserve a valid backup when the primary is corrupt`, async (t) => {
    const { store, filePath, backupPath, read, reopen } = fixture(t);
    await store.save(first);
    fs.writeFileSync(filePath, '{"tabs":');
    if (synchronous) store.saveSync(second);
    else await store.save(second);
    assert.deepEqual(read(backupPath), first);
    assert.deepEqual(await reopen().load(), second);
  });

  test(`${mode} replacement failure leaves the primary intact`, async (t) => {
    const { store, filePath, backupPath, read, directory } = fixture(t);
    await store.save(first);
    await store.save(second);
    const rename = fs.renameSync;
    const replacement = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
      if (args[1] === filePath) throw new Error('replacement failed');
      return rename(...args);
    });
    if (synchronous) assert.throws(() => store.saveSync(third), /replacement failed/);
    else await assert.rejects(store.save(third), /replacement failed/);
    assert.deepEqual(read(), second);
    assert.deepEqual(read(backupPath), second);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['session.json', 'session.json.bak']);
    replacement.mock.restore();
    await store.save(third);
    assert.deepEqual(read(), third);
  });
}

test('restart uses the backup for missing, truncated, or structurally invalid primary sessions', async (t) => {
  const { store, filePath, reopen } = fixture(t);
  await store.save(first);
  await store.save(second);
  for (const invalid of ['', '{"tabs":', '{}', '{"tabs":[]}']) {
    fs.writeFileSync(filePath, invalid);
    assert.deepEqual(await reopen().load(), first);
  }
  fs.unlinkSync(filePath);
  assert.deepEqual(await reopen().load(), first);
});

test('invalid backups and interrupted temporary files are ignored', async (t) => {
  const { filePath, backupPath, reopen } = fixture(t);
  fs.writeFileSync(`${filePath}.interrupted.tmp`, JSON.stringify(first));
  assert.equal(await reopen().load(), null);
  fs.writeFileSync(filePath, '{');
  fs.writeFileSync(backupPath, '{}');
  assert.equal(await reopen().load(), null);
});

test('overlapping live saves commit in order', async (t) => {
  const { store, read, backupPath } = fixture(t);
  await Promise.all([store.save(first), store.save(second), store.save(third)]);
  assert.deepEqual(read(), third);
  assert.deepEqual(read(backupPath), second);
});

test('a shutdown save supersedes both an in-flight save and queued older saves', async (t) => {
  const { store, read, backupPath } = fixture(t);
  await store.save(first);
  const { paused, resume } = pauseNextWrite(t);
  const saving = store.save(second);
  const queued = store.save(first);
  await paused;
  store.saveSync(third);
  resume();
  await Promise.all([saving, queued]);
  assert.deepEqual(read(), third);
  assert.deepEqual(read(backupPath), first);
  await store.save(second);
  assert.deepEqual(read(), second);
  assert.deepEqual(read(backupPath), third);
});

test('a synchronous discard prevents an in-flight save from resurrecting a session', async (t) => {
  const { store, reopen, directory } = fixture(t);
  await store.save(first);
  const { paused, resume } = pauseNextWrite(t);
  const saving = store.save(second);
  await paused;
  store.clearSync();
  resume();
  await saving;
  assert.equal(await reopen().load(), null);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('discard clears both copies after pending saves and future saves start a new backup', async (t) => {
  const { store, reopen, read, backupPath, directory } = fixture(t);
  await Promise.all([store.save(first), store.save(second), store.clear()]);
  assert.equal(await reopen().load(), null);
  assert.deepEqual(fs.readdirSync(directory), []);
  await store.save(third);
  assert.deepEqual(read(backupPath), third);
});

test('failed temporary writes preserve both copies and do not block later saves', async (t) => {
  const { store, read, backupPath } = fixture(t);
  await store.save(first);
  await store.save(second);
  const failure = t.mock.method(fs.promises, 'writeFile', async () => {
    throw new Error('disk full');
  });
  await assert.rejects(store.save(third), /disk full/);
  assert.deepEqual(read(), second);
  assert.deepEqual(read(backupPath), first);
  failure.mock.restore();
  await store.save(third);
  assert.deepEqual(read(), third);
});

test('a failed backup replacement leaves both existing files intact', async (t) => {
  const { store, read, backupPath } = fixture(t);
  await store.save(first);
  await store.save(second);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (...args: Parameters<typeof rename>) => {
    if (args[1] === backupPath) throw new Error('backup locked');
    return rename(...args);
  });
  await assert.rejects(store.save(third), /backup locked/);
  assert.deepEqual(read(), second);
  assert.deepEqual(read(backupPath), first);
});
