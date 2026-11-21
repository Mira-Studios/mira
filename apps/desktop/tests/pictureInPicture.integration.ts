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
const root = fs.mkdtempSync(path.join(temporaryRoot, 'picture-in-picture-ui-'));
const data = path.join(root, 'data');
const fixture = path.join(root, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({
    name: 'mira-workspaces-test',
    type: 'module',
    main: fileURLToPath(new URL('profileWorker.electron.ts', import.meta.url)),
  }),
);
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html');
  if (request.url === '/embed') {
    response.end(
      `<title>Embedded video</title><iframe allow="autoplay; picture-in-picture" src="http://${request.headers.host?.replace('127.0.0.1', 'localhost')}/?embedded" style="width:680px;height:400px;border:0"></iframe><script>addEventListener('message',e=>{if(e.source===document.querySelector('iframe').contentWindow)window.frameVideoState=e.data;});</script>`,
    );
    return;
  }
  response.end(`<!doctype html><title>PiP fixture</title><style>body{margin:0;background:#161616}video{width:640px;height:360px}</style><video id="movie" muted autoplay loop playsinline controls></video><script>
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
    const ctx=canvas.getContext('2d');let frame=0;
    const draw=setInterval(()=>{ctx.fillStyle=frame++%2?'#365f97':'#9b3b67';ctx.fillRect(0,0,640,360);ctx.fillStyle='#fff';ctx.font='42px sans-serif';ctx.fillText('Mira picture in picture',70,180);},40);
    const stream=canvas.captureStream(25);const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});const chunks=[];
    recorder.ondataavailable=event=>chunks.push(event.data);
    recorder.onstop=()=>{clearInterval(draw);stream.getTracks().forEach(track=>track.stop());movie.src=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));movie.play();};
    recorder.start();setTimeout(()=>recorder.stop(),1200);
    for(const event of ['playing','pause','loadeddata'])movie.addEventListener(event,()=>{if(parent!==window)parent.postMessage({paused:movie.paused},'*');});
  </script>`);
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
const click = async (selector: string, index = 0) => {
  await until(
    async () =>
      await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`, index),
    `Control appears: ${selector}`,
  );
  return evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`, index);
};
const settings = (values: Record<string, unknown>) =>
  evaluate(
    `localStorage.setItem('mira.settings.browser.v1', JSON.stringify({...JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}'), ...${JSON.stringify(values)}})); window.dispatchEvent(new Event('mira:settings-changed')); true`,
  );
const invoke = (channel: string, ...args: unknown[]) =>
  evaluate(
    `window.electron.ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
  );

type Info = {
  processId: number;
  bounds: { x: number; y: number; width: number; height: number };
  content: { x: number; y: number; width: number; height: number };
  parent: number | null;
  onTop: boolean;
  visible: boolean;
  minimized: boolean;
};
const count = async () => (await command<{ windows: number[] }>('snapshot')).windows.length;
const info = (index = 0) => command<Info>('window-info', { index });
const inMode = async (mode: string) => {
  try {
    return await evaluate<boolean>(
      `document.querySelector('.pip-player')?.dataset.mode === ${JSON.stringify(mode)}`,
      1,
    );
  } catch {
    return false;
  }
};
const source = <T = unknown>(code: string) =>
  evaluate<T>(`document.querySelector('webview').executeJavaScript(${JSON.stringify(code)})`);
const videoPlaying = () =>
  source<boolean>(
    `!!document.querySelector('video') && !document.querySelector('video').paused && document.querySelector('video').readyState>=2`,
  );
const pipReady = async () => {
  await until(async () => (await count()) === 2, 'PiP window opens');
  await until(
    async () =>
      await evaluate<boolean>(`document.querySelector('.pip-player')?.dataset.ready==='true'`, 1),
    'Real video frames arrive in PiP',
    20000,
  );
};
const closePip = () =>
  evaluate(
    `setTimeout(()=>document.querySelector('[aria-label="Close picture in picture"]').click(),50);true`,
    1,
  );
try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron ready');
  await until(async () => (await count()) === 1, 'Browser opens');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`),
    'Browser ready',
  );
  await settings({ animationsEnabled: false, pipOnTabSwitch: true, pipOnWindowHidden: true });
  await command('window-show');
  await invoke('tab-open-url-in-new-tab', url);
  await until(async () => {
    try {
      return await videoPlaying();
    } catch {
      return false;
    }
  }, 'Fixture video plays');
  const sourceTab = await evaluate<string>(`document.querySelector('[data-tab-id]').dataset.tabId`);
  await invoke('tab-open-url-in-new-tab', 'mira://History');
  await pipReady();
  await command('window-show');
  await until(
    async () => await inMode('window'),
    'Tab-switch PiP remains inside the visible browser',
  );
  assert.equal(await evaluate(`document.querySelector('.pip-player').dataset.mode`, 1), 'window');
  assert.equal((await info(1)).parent, null, 'PiP uses no native ownership that could interfere with browser windows');
  assert.notEqual(
    (await info(1)).processId,
    (await info()).processId,
    'PiP rendering is isolated from the browser shell',
  );
  await settings({
    tabSleepValue: 1,
    tabSleepUnit: 'seconds',
    tabSleepMode: 'discard',
    suspendMinimizedWindows: true,
    minimizedWindowSleepValue: 1,
    minimizedWindowSleepUnit: 'seconds',
  });
  await delay(1300);
  assert.equal(await videoPlaying(), true, 'An active PiP source is protected from tab sleeping');
  await invoke('window-minimize');
  await until(async () => await inMode('desktop'), 'Minimizing switches PiP to the desktop');
  await delay(1300);
  assert.equal(
    await videoPlaying(),
    true,
    'PiP keeps its source alive when the minimized-window delay expires',
  );
  await command('window-show');
  await until(
    async () => await inMode('window'),
    'Restoring the browser returns PiP to its in-window position',
  );
  await settings({
    tabSleepValue: 3,
    tabSleepUnit: 'minutes',
    tabSleepMode: 'freeze',
    suspendMinimizedWindows: false,
  });
  await click('[aria-label="Pause"]', 1);
  await until(
    async () => await source<boolean>(`document.querySelector('video').paused`),
    'Pause controls the original video',
  );
  await until(
    async () =>
      await evaluate<boolean>(
        `!document.querySelector('[aria-label="Video position"]').disabled`,
        1,
      ),
    'Seek is available for recorded video',
  );
  await evaluate(
    `(() => {const slider=document.querySelector('[aria-label="Video position"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'0.4');slider.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    1,
  );
  await until(
    async () =>
      await source<boolean>(`Math.abs(document.querySelector('video').currentTime-0.4)<0.15`),
    'Seek controls the source video',
  );
  await evaluate(
    `(() => {const slider=document.querySelector('[aria-label="Video volume"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'0.35');slider.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,
    1,
  );
  await until(
    async () => await source<boolean>(`Math.abs(document.querySelector('video').volume-0.35)<0.01`),
    'Volume controls the source video',
  );
  await click('[aria-label="Play"]', 1);
  await until(async () => await videoPlaying(), 'Play resumes original video');
  await click('[aria-label="Mute video"]', 1);
  await until(
    async () => await source<boolean>(`document.querySelector('video').muted`),
    'Mute silences the original video',
  );
  await click('[aria-label="Unmute video"]', 1);
  await until(
    async () => await source<boolean>(`document.querySelector('video').muted===false`),
    'Mute control changes original media',
  );
  const host = await info();
  const inlineBounds = { x: host.content.x + 50, y: host.content.y + 80, width: 400, height: 297 };
  await command('window-bounds', { index: 1, bounds: inlineBounds });
  await delay(300);
  const rememberedInline = (await info(1)).bounds;
  await invoke('window-new');
  await until(
    async () => (await count()) === 3,
    'Another browser window opens while PiP is active',
  );
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`, 2),
    'New window remains usable',
  );
  await delay(400);
  assert.equal(await count(), 3, 'PiP does not close newly opened windows');
  assert.deepEqual(
    (await info(1)).bounds,
    rememberedInline,
    'Changing browser focus does not resize PiP',
  );
  await evaluate(`setTimeout(()=>window.electron.ipcRenderer.invoke('window-close'),50);true`, 2);
  await until(async () => (await count()) === 2, 'Only the requested normal window closes');
  await command('window-show');
  await command('screenshot', { index: 1, file: path.join(root, 'pip-controls.png') });
  await command('window-hide');
  await until(async () => await inMode('desktop'), 'Hidden window switches to desktop PiP');
  assert.equal((await info(1)).parent, null);
  assert.equal((await info(1)).onTop, true);
  assert.equal((await info(1)).visible, true);
  const desktopInitial = (await info(1)).bounds;
  assert.equal(
    desktopInitial.width,
    rememberedInline.width,
    'Switching to desktop preserves the resized width',
  );
  assert.equal(
    desktopInitial.height,
    rememberedInline.height,
    'Switching to desktop preserves the resized height',
  );
  await command('window-bounds', {
    index: 1,
    bounds: {
      ...desktopInitial,
      x: desktopInitial.x - 60,
      y: desktopInitial.y - 40,
      width: 420,
      height: 308,
    },
  });
  await delay(300);
  const rememberedDesktop = (await info(1)).bounds;
  await command('window-show');
  await until(async () => await inMode('window'), 'Showing Mira restores in-window PiP');
  assert.deepEqual(
    (await info(1)).bounds,
    { ...rememberedInline, width: rememberedDesktop.width, height: rememberedDesktop.height },
    'In-window position is remembered without changing the current player size',
  );
  await command('window-hide');
  await until(async () => await inMode('desktop'), 'Desktop mode returns');
  assert.deepEqual(
    (await info(1)).bounds,
    rememberedDesktop,
    'Desktop placement and size are remembered separately',
  );
  await command('window-show');
  await until(
    async () => await inMode('window'),
    'In-window player is ready before returning to the source',
  );
  await evaluate(
    `setTimeout(()=>document.querySelector('[aria-label="Return to tab"]').click(),50);true`,
    1,
  );
  await until(async () => (await count()) === 1, 'Return-to-tab closes PiP');
  await until(
    async () =>
      await evaluate<boolean>(
        `getComputedStyle(document.querySelector('webview')).visibility === 'visible'`,
      ),
    'Return-to-tab selects the original video tab',
  );
  await settings({ pipOnTabSwitch: false, pipOnWindowHidden: true });
  await command('window-show');
  await delay(150);
  await invoke('tab-open-url-in-new-tab', 'mira://Downloads');
  await delay(1000);
  assert.equal(await count(), 1, 'Tab-switch PiP can be disabled');
  await command('window-hide');
  await pipReady();
  await settings({ pipOnWindowHidden: false });
  await until(async () => (await count()) === 1, 'Hidden-window PiP can be disabled independently');
  await command('window-show');
  await settings({ pipOnTabSwitch: true, pipOnWindowHidden: true });
  await evaluate(`document.querySelector('[data-tab-id="${sourceTab}"]').click();true`);
  await delay(250);
  await invoke('tab-open-url-in-new-tab', 'mira://Settings#section=general');
  await pipReady();
  await closePip();
  await until(async () => (await count()) === 1, 'Close button dismisses PiP');
  await delay(1000);
  assert.equal(await count(), 1, 'Dismissed PiP stays closed until returning to its source');
  await command('window-show');
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('#pip-on-tab-switch')`),
    'Settings exposes both PiP toggles',
  );
  assert.equal(await evaluate(`document.querySelector('#pip-on-window-hidden').checked`), true);
  await source(`document.querySelector('video').pause();true`);
  await invoke('tab-open-url-in-new-tab', `${url}embed`);
  const embedded = <T = unknown>(code: string) =>
    evaluate<T>(
      `[...document.querySelectorAll('webview')].find(view=>view.getURL().endsWith('/embed')).executeJavaScript(${JSON.stringify(code)})`,
    );
  await until(async () => {
    try {
      return await embedded<boolean>(`window.frameVideoState?.paused === false`);
    } catch {
      return false;
    }
  }, 'Iframe video plays');
  await invoke('tab-open-url-in-new-tab', 'mira://History');
  await pipReady();
  await click('[aria-label="Pause"]', 1);
  await until(
    async () => await embedded<boolean>(`window.frameVideoState?.paused === true`),
    'PiP controls the video in its iframe',
  );
  await closePip();
  await until(async () => (await count()) === 1, 'Embedded PiP closes');
  await delay(350);
  const placementFile = path.join(data, 'Profiles', 'default', 'picture-in-picture.v1.json');
  const beforePrivate = fs.readFileSync(placementFile, 'utf8');
  await invoke('window-new-private');
  await until(async () => (await count()) === 2, 'Private browser opens');
  await command('window-show', { index: 1 });
  await until(
    async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`, 1),
    'Private renderer ready',
  );
  await evaluate(
    `window.electron.ipcRenderer.invoke('tab-open-url-in-new-tab',${JSON.stringify(url)})`,
    1,
  );
  await until(async () => {
    try {
      return await evaluate<boolean>(
        `document.querySelector('webview').executeJavaScript("!!document.querySelector('video') && !document.querySelector('video').paused")`,
        1,
      );
    } catch {
      return false;
    }
  }, 'Private video plays');
  await evaluate(
    `window.electron.ipcRenderer.invoke('tab-open-url-in-new-tab','mira://History')`,
    1,
  );
  await until(async () => (await count()) === 3, 'Private PiP opens');
  await until(
    async () =>
      await evaluate<boolean>(`document.querySelector('.pip-player')?.dataset.ready==='true'`, 2),
    'Private PiP receives frames',
  );
  const privateBounds = (await info(2)).bounds;
  await command('window-bounds', {
    index: 2,
    bounds: { ...privateBounds, width: 300, height: 180 },
  });
  await delay(350);
  assert.equal(
    fs.readFileSync(placementFile, 'utf8'),
    beforePrivate,
    'Private PiP does not persist placements',
  );
  await evaluate(`setTimeout(()=>window.electron.ipcRenderer.invoke('window-close'),50);true`, 1);
  await until(async () => (await count()) === 1, 'Closing a private source closes its PiP');
  console.log(
    `PASS: real video streaming, automatic tab/desktop PiP, playback controls, resizing, separate remembered bounds, return-to-tab, dismissal and independent settings.\nArtifacts: ${root}`,
  );
} catch (failure) {
  try {
    console.error(
      'PiP fixture state:',
      await source(
        `(() => {const v=document.querySelector('video');return {paused:v.paused,ended:v.ended,loop:v.loop,time:v.currentTime,duration:v.duration,ready:v.readyState};})()`,
      ),
    );
    if ((await count()) > 1) console.error('PiP UI:', await evaluate(`document.body.innerText`, 1));
  } catch {
    /* Preserve the original failure. */
  }
  throw failure;
} finally {
  try {
    await command('quit');
  } catch {
    /* Only this fixture is stopped. */
  }
  if (child.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
