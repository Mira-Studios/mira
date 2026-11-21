// Build the renderer before running this isolated Electron flow test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = path.resolve(desktop, '../../.tmp');
fs.mkdirSync(temporaryRoot, { recursive: true });
const root = fs.mkdtempSync(path.join(temporaryRoot, 'find-in-page-ui-'));
const data = path.join(root, 'data');
const fixture = path.join(root, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({
    name: 'mira-find-in-page-test',
    type: 'module',
    main: fileURLToPath(new URL('profileWorker.electron.ts', import.meta.url)),
  }),
);
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end(
    '<title>Find fixture</title><h1>Alpha alpha alpha</h1><p>beta gamma</p><input id="state" value="original">',
  );
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}/`;
const environment = {
  ...process.env,
  MIRA_TEST_USER_DATA_DIR: data,
  MIRA_PROFILE_TEST_CONTROL: root,
};
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron') as string, [fixture], {
  cwd: desktop,
  env: environment,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
child.stderr.on('data', (value) => {
  diagnostics += String(value);
});
child.stdout.on('data', (value) => {
  diagnostics += String(value);
});
async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `${message}\n${diagnostics.slice(-2000)}`);
    await delay(60);
  }
}
async function command<T = unknown>(
  action: string,
  values: Record<string, unknown> = {},
): Promise<T> {
  const id = randomUUID();
  fs.writeFileSync(
    path.join(root, 'default-command.json'),
    JSON.stringify({ id, action, ...values }),
  );
  const response = path.join(root, `default-${id}.json`);
  await until(() => fs.existsSync(response), `${action} responds`);
  const result = JSON.parse(fs.readFileSync(response, 'utf8'));
  assert.ok(result.ok, result.error);
  return result.result;
}
const evaluate = <T = unknown>(code: string, index = 0) => command<T>('eval', { code, index });
const click = (selector: string, index = 0) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`, index);
const settings = (values: Record<string, unknown>) =>
  evaluate(
    `localStorage.setItem('mira.settings.browser.v1', JSON.stringify({...JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}'), ...${JSON.stringify(values)}})); window.dispatchEvent(new Event('mira:settings-changed')); true`,
  );
const invoke = (channel: string, ...args: unknown[]) =>
  evaluate(
    `window.electron.ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
  );

const count = async () => (await command<{ windows: number[] }>('snapshot')).windows.length;
const fill = (text: string) =>
  evaluate(
    `(() => {const input=document.querySelector('.find-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
  );
const matchCount = async (value: string) =>
  until(
    async () =>
      await evaluate<boolean>(
        `document.querySelector('.find-count')?.textContent===${JSON.stringify(value)}`,
      ),
    `Matches update to ${value}`,
  );
try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron ready');
  await until(async () => (await count()) > 0, 'Browser opens');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`),
    'Browser ready',
  );
  await settings({ animationsEnabled: true });
  await invoke('tab-open-url-in-new-tab', url);
  await until(async () => {
    try {
      return await evaluate<boolean>(
        `document.querySelector('webview')?.executeJavaScript("document.body?.textContent.includes('Alpha alpha alpha')")`,
      );
    } catch {
      return false;
    }
  }, 'Page ready');
  const sourceId = await evaluate<string>(
    `document.querySelector('.theme-tab-selected').dataset.tabId`,
  );
  await evaluate(
    `(() => {const view=document.querySelector('webview');window.findCalls=[];view.addEventListener('found-in-page',event=>window.findCalls.push({kind:'found',result:event.result}));const find=view.findInPage.bind(view);const stop=view.stopFindInPage.bind(view);view.findInPage=(query,options)=>{const id=find(query,options);window.findCalls.push({kind:'find',query,options,id});return id;};view.stopFindInPage=action=>{window.findCalls.push({kind:'stop',action});return stop(action);};return true;})()`,
  );
  const before = await evaluate(
    `document.querySelector('webview').getBoundingClientRect().toJSON()`,
  );
  await command('shortcut', { value: 'find-in-page' });
  await until(
    async () =>
      await evaluate<boolean>(`document.activeElement===document.querySelector('.find-input')`),
    'Find opens and focuses',
  );
  assert.deepEqual(
    await evaluate(`document.querySelector('webview').getBoundingClientRect().toJSON()`),
    before,
    'Popup does not shift page geometry',
  );
  await evaluate(
    `(() => {const view=document.querySelector('webview');window.delayFindResults=true;view.addEventListener('found-in-page',event=>{if(!window.delayFindResults||event.delayedFindResult)return;event.stopImmediatePropagation();const result=event.result;setTimeout(()=>view.dispatchEvent(Object.assign(new Event('found-in-page'),{result,delayedFindResult:true})),400);},true);return true;})()`,
  );
  await fill('alpha');
  assert.equal(
    await evaluate(`document.querySelector('.find-count').textContent`),
    '…',
    'First search does not display zero while checking',
  );
  await matchCount('1/3');
  await fill('beta');
  assert.equal(
    await evaluate(`document.querySelector('.find-count').textContent`),
    '1/3',
    'Keep the previous result count while checking',
  );
  await matchCount('1/1');
  await evaluate(`window.delayFindResults=false;true`);
  await fill('missing');
  await matchCount('0/0');
  await fill('alpha');
  await matchCount('1/3');
  await click('[aria-label="Next match"]');
  await matchCount('2/3');
  await click('[aria-label="Previous match"]');
  await matchCount('1/3');
  await click('[aria-label="Match case"]');
  await matchCount('1/2');
  await click('[aria-label="Match case"]');
  await matchCount('1/3');
  await command('screenshot', { file: path.join(root, 'find-popover.png') });
  await evaluate(`document.querySelector('webview').focus();true`);
  await delay(2000);
  assert.equal(
    await evaluate(`!!document.querySelector('.find-popover')`),
    true,
    'Find stays open after focus leaves and time passes',
  );
  await click('[aria-label="Close find"]');
  await until(
    async () => await evaluate<boolean>(`!document.querySelector('.find-popover')`),
    'Close finishes animation',
  );
  await command('screenshot', { file: path.join(root, 'find-closed.png') });
  assert.equal(
    await evaluate(
      `window.findCalls.at(-1).kind==='stop' && window.findCalls.at(-1).action==='clearSelection'`,
    ),
    true,
    'Closing clears native search highlights',
  );
  await command('shortcut', { value: 'find-in-page' });
  await matchCount('1/3');
  await fill('');
  await matchCount('');
  assert.equal(
    await evaluate(`window.findCalls.at(-1).action`),
    'clearSelection',
    'Empty query clears native highlights',
  );
  await fill('beta');
  await matchCount('1/1');
  await evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));true`,
  );
  await until(
    async () => await evaluate<boolean>(`!document.querySelector('.find-popover')`),
    'Escape closes',
  );
  assert.equal(
    await evaluate(`window.findCalls.at(-1).action`),
    'clearSelection',
    'Escape clears highlights',
  );
  await command('shortcut', { value: 'find-in-page' });
  await matchCount('1/1');
  await click('.tab-new-tab-btn');
  await until(
    async () => await evaluate<boolean>(`document.querySelector('.find-input')?.disabled===true`),
    'Find stays open on internal page',
  );
  assert.equal(
    await evaluate(`window.findCalls.at(-1).action`),
    'clearSelection',
    'Switching away clears old tab highlights',
  );
  await click(`[data-tab-id="${sourceId}"]`);
  await matchCount('1/1');
  await command('shortcut', { value: 'stop-loading' });
  await until(
    async () => await evaluate<boolean>(`!document.querySelector('.find-popover')`),
    'Escape from the page closes find',
  );
  console.log(
    `PASS: floating find popup, live native matches, next/previous, case, persistent visibility, closing/clearing highlights and tab switching.\nArtifacts: ${root}`,
  );
} catch (failure) {
  try {
    console.error(
      'Find state:',
      await evaluate(
        `({text:document.querySelector('.find-popover')?.textContent,calls:window.findCalls})`,
      ),
    );
  } catch {
    /* Preserve failure. */
  }
  throw failure;
} finally {
  try {
    await command('quit');
  } catch {
    /* Fixture only. */
  }
  if (child.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
