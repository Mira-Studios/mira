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
const root = fs.mkdtempSync(path.join(temporaryRoot, 'pinned-tabs-ui-'));
const data = path.join(root, 'data');
const fixture = path.join(root, 'app');
fs.mkdirSync(data);
fs.mkdirSync(fixture);
fs.writeFileSync(path.join(data, 'app-state.json'), JSON.stringify({ onboardingCompleted: true }));
fs.writeFileSync(
  path.join(fixture, 'package.json'),
  JSON.stringify({
    name: 'mira-vertical-address-test',
    type: 'module',
    main: fileURLToPath(new URL('profileWorker.electron.ts', import.meta.url)),
  }),
);
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<title>Sidebar preservation</title><input id="state" value="original">');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
fs.writeFileSync(
  path.join(data, 'site-permissions.json'),
  JSON.stringify({ origins: { '127.0.0.1': { unknown: 'allow' } } }),
);
const environment = {
  ...process.env,
  MIRA_TEST_USER_DATA_DIR: data,
  MIRA_PROFILE_TEST_CONTROL: root,
  MIRA_PERMISSION_TEST: '1',
};
delete environment.ELECTRON_RUN_AS_NODE;
let diagnostics = '';
function launch() {
const child = spawn(createRequire(import.meta.url)('electron') as string, [fixture], {
  cwd: desktop,
  env: environment,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (value) => {
  diagnostics += String(value);
});
child.stdout.on('data', (value) => {
  diagnostics += String(value);
});
return child;
}
let child = launch();
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
const settings = (values: Record<string, unknown>) =>
  evaluate(
    `localStorage.setItem('mira.settings.browser.v1', JSON.stringify({...JSON.parse(localStorage.getItem('mira.settings.browser.v1') || '{}'), ...${JSON.stringify(values)}})); window.dispatchEvent(new Event('mira:settings-changed')); true`,
  );

const pin = async () => {
  await until(async () => await evaluate<boolean>(`!!document.querySelector('[data-tab-id]:not([data-pinned="true"])')`), 'Unpinned tab renders');
  const previous = await evaluate<number>(`document.querySelectorAll('[data-tab-id][data-pinned="true"]').length`);
  await evaluate(`document.querySelector('[data-tab-id]:not([data-pinned="true"])').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:160,clientY:20}));true`);
  await until(async () => await evaluate<boolean>(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(item=>item.textContent.trim()==='Pin Tab')`), 'Pin action available');
  await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(item=>item.textContent.trim()==='Pin Tab').click();true`);
  await until(async () => await evaluate<boolean>(`document.querySelectorAll('[data-tab-id][data-pinned="true"]').length===${previous + 1}`), 'Tab pins');
};
const geometry = () => evaluate<{ viewport: { left: number; top: number }; paddingLeft: number; paddingTop: number; gap: number; pinned: { left: number; right: number; top: number; bottom: number }[]; regular: { left: number } }>(`(()=>{const strip=document.querySelector('.tab-strip-scroll');const style=getComputedStyle(strip);return {viewport:strip.getBoundingClientRect().toJSON(),paddingLeft:parseFloat(style.paddingLeft),paddingTop:parseFloat(style.paddingTop),gap:parseFloat(style.gap),pinned:Array.from(strip.querySelectorAll('[data-pinned="true"]')).map(tab=>tab.getBoundingClientRect().toJSON()),regular:strip.querySelector('[data-tab-id]:not([data-pinned="true"])').getBoundingClientRect().toJSON()}})()`);
try {
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Electron ready');
  await until(async () => { try { return await evaluate<boolean>(`!!document.querySelector('[data-tab-id]')`); } catch { return false; } }, 'Renderer ready');
  await settings({ tabStripPosition: 'top', sidebarEnabled: false, animationsEnabled: false, nativeTextFieldContextMenu: false });
  const curveGeometry = () => evaluate(`(()=>{const strip=document.querySelector('.tab-strip-scroll');const tab=strip.querySelector('.theme-tab-selected');const curve=tab?.querySelector('.tab-connection-curve');return {scrollTop:strip.scrollTop,strip:strip.getBoundingClientRect().toJSON(),tab:tab?.getBoundingClientRect().toJSON(),curve:curve?.getBoundingClientRect().toJSON()}})()`);
  const beforePin = await curveGeometry() as { tab: { left: number; height: number }; curve: { top: number; bottom: number } };
  await pin();
  const afterPin = await curveGeometry() as typeof beforePin;
  assert.ok(Math.abs(afterPin.tab.left - beforePin.tab.left) < 1, 'Pinning does not shift the tab to the right');
  assert.ok(Math.abs(afterPin.curve.bottom - beforePin.curve.bottom) < .5, 'Pinning keeps inverse curves on the same baseline');
  await command('shortcut', { value: 'new-tab' });
  const beforeSecondPin = await curveGeometry() as typeof beforePin;
  await pin();
  const afterSecondPin = await curveGeometry() as typeof beforePin;
  assert.ok(Math.abs(afterSecondPin.curve.bottom - beforeSecondPin.curve.bottom) < .5, 'Multiple pinned tabs keep the curve baseline stable');
  for (let index = 0; index < 26; index++) { await command('shortcut', { value: 'new-tab' }); await delay(80); }
  await until(async () => await evaluate<boolean>(`document.querySelector('.tab-strip-scroll').scrollWidth>document.querySelector('.tab-strip-scroll').clientWidth`), 'Tab strip overflows');
  await delay(150);
  for (const offset of [0, 80, 250, 100000]) {
    await evaluate(`(()=>{const strip=document.querySelector('.tab-strip-scroll');strip.scrollLeft=${offset};strip.dispatchEvent(new Event('scroll'));return true})()`);
    await delay(60);
    const rects = await geometry();
    assert.ok(await evaluate<boolean>(`(()=>{const background=document.querySelector('[data-pinned-tab-background]');if(!background)return false;const r=background.getBoundingClientRect();const pins=Array.from(document.querySelectorAll('[data-pinned="true"]')).map(tab=>tab.getBoundingClientRect());return r.left<=pins[0].left && r.right>=pins.at(-1).right && getComputedStyle(background).backgroundColor!=='rgba(0, 0, 0, 0)'})()`), 'Scrolling pinned tabs have an opaque continuous backing');
    assert.ok(Math.abs(rects.pinned[0].left - rects.viewport.left - rects.paddingLeft) < 1.5, `First pinned tab aligns with strip inset at ${offset}`);
    assert.ok(Math.abs(rects.pinned[1].left - rects.pinned[0].right - rects.gap) < 1.5, `Pinned tabs keep their spacing at ${offset}`);
    if (offset === 0) assert.ok(rects.regular.left >= rects.pinned[1].right + rects.gap - 1.5, 'Pinned tabs do not overlap the first regular tab');
  }
  await evaluate(`(()=>{const strip=document.querySelector('.tab-strip-scroll');strip.scrollLeft=0;strip.dispatchEvent(new Event('scroll'));return true})()`);
  for (const index of [0, 1, 2, 3, 5, 7]) {
    await evaluate(`document.querySelectorAll('.theme-tab[data-tab-id]')[${index}].click();true`);
    await delay(60);
    const joins = await evaluate<{left:number;right:number;expectedLeft:number;expectedRight:number;leftY:number;rightY:number}>(`(()=>{const tab=document.querySelector('.theme-tab-selected');const bounds=tab.getBoundingClientRect();const style=getComputedStyle(tab);const connection=tab.querySelector('.tab-connection');const r=parseFloat(getComputedStyle(connection).getPropertyValue('--tabConnectionRadius'));const point=new DOMPoint(r+.5,.5);const left=point.matrixTransform(connection.querySelector('.tab-connection-curve-0 g').getScreenCTM());const right=point.matrixTransform(connection.querySelector('.tab-connection-curve-1 g').getScreenCTM());const scale=window.devicePixelRatio;return {left:left.x,right:right.x,leftY:left.y,rightY:right.y,expectedLeft:Math.round(bounds.left*scale)/scale+parseFloat(style.borderLeftWidth)/2,expectedRight:Math.round(bounds.right*scale)/scale-parseFloat(style.borderRightWidth)/2}})()`);
    assert.ok(Math.abs(joins.left-joins.expectedLeft)<.06 && Math.abs(joins.right-joins.expectedRight)<.06, `Both curves join the tab borders consistently at tab ${index}: ${JSON.stringify(joins)}`);
    assert.ok(Math.abs(joins.leftY-joins.rightY)<.06, 'Mirrored curves use the same vertical baseline');
  }
  await command('screenshot', { file: path.join(root, 'horizontal-pinned.png') });
  const inactiveIconY = await evaluate<number>(`(()=>{const tab=document.querySelector('[data-tab-id]:not([data-pinned="true"])');const icon=tab.querySelector('[data-tab-content]').firstElementChild;const r=icon.getBoundingClientRect();window.__faviconTabId=tab.dataset.tabId;return r.top+r.height/2})()`);
  await evaluate(`document.querySelector('[data-tab-id="'+window.__faviconTabId+'"]').click();true`);
  await until(async () => await evaluate<boolean>(`document.querySelector('[data-tab-id="'+window.__faviconTabId+'"]').classList.contains('theme-tab-selected')`), 'Regular tab selects');
  const activeIconY = await evaluate<number>(`(()=>{const icon=document.querySelector('[data-tab-id="'+window.__faviconTabId+'"] [data-tab-content]').firstElementChild;const r=icon.getBoundingClientRect();return r.top+r.height/2})()`);
  assert.ok(Math.abs(activeIconY-inactiveIconY)<.25, 'Selecting a tab keeps its favicon on the same baseline');
  await settings({ animationsEnabled: true });
  await evaluate(`(()=>{window.__originalTabGeometry={};for(const [key,value] of Object.entries({'--layoutTabRadius':'24px','--layoutTopBarHeight':'62px','--layoutTabHeight':'38px'})){window.__originalTabGeometry[key]=document.documentElement.style.getPropertyValue(key);document.documentElement.style.setProperty(key,value)}return true})()`);
  await delay(100);
  await evaluate(`(()=>{window.__pinCurveSamples=[];const deadline=performance.now()+800;const sample=()=>{const curve=document.querySelector('.theme-tab-selected .tab-connection-curve');if(curve){const r=curve.getBoundingClientRect();window.__pinCurveSamples.push({top:r.top,bottom:r.bottom})}if(performance.now()<deadline)requestAnimationFrame(sample)};requestAnimationFrame(sample);return true})()`);
  await pin();
  await delay(850);
  const curveSamples = await evaluate<{top: number; bottom: number}[]>('window.__pinCurveSamples');
  assert.ok(curveSamples.length > 2 && ['top','bottom'].every(edge=>{const positions=curveSamples.map(sample=>sample[edge as keyof typeof sample]);return Math.max(...positions)-Math.min(...positions)<.5}), 'Inverse curves do not move vertically during animated pinning, including large-radius layouts');
  await evaluate(`for(const [key,value] of Object.entries(window.__originalTabGeometry))document.documentElement.style.setProperty(key,value);true`);
  await settings({ animationsEnabled: false });
  for (let index = 0; index < 3; index++) await pin();
  for (const side of ['left', 'right']) {
    await settings({ tabStripPosition: side, addressBarPosition: 'vertical-tabs' });
    await until(async () => await evaluate<boolean>(`document.querySelector('.address-bar-in-vertical-tabs')?.dataset.side===${JSON.stringify(side)}`), 'Vertical tab side applies');
    await evaluate(`(()=>{const strip=document.querySelector('.tab-strip-scroll');strip.scrollTop=300;strip.dispatchEvent(new Event('scroll'));return true})()`);
    await delay(100);
    const rects = await geometry();
    assert.ok(Math.abs(rects.pinned[0].top - rects.viewport.top - rects.paddingTop) < 1.5, `Pinned tabs respect vertical padding on ${side}`);
    assert.ok(Math.abs(rects.pinned[1].top-rects.pinned[0].top)<1 && rects.pinned[1].left>rects.pinned[0].right, `Pinned tabs use columns on ${side}`);
    assert.ok(Math.abs(rects.pinned[3].top-rects.pinned[0].bottom-rects.gap)<1.5, `Pinned tabs wrap after three tiles on ${side}`);
    assert.equal(await evaluate<number>(`document.querySelectorAll('[data-pinned="true"] .tab-title').length`), 0, 'Pinned tiles are favicon-only');
    assert.ok(await evaluate<boolean>(`(()=>{const pins=Array.from(document.querySelectorAll('[data-pinned="true"]'));return pins.every(tab=>{const r=tab.getBoundingClientRect();const icon=tab.querySelector('[data-tab-content]').firstElementChild.getBoundingClientRect();return Math.abs(r.left+r.width/2-icon.left-icon.width/2)<1 && Math.abs(r.top+r.height/2-icon.top-icon.height/2)<1})})()`), 'Tile favicons are centered');
    assert.ok(await evaluate<boolean>(`(()=>{const normal=document.querySelector('[data-tab-id]:not([data-pinned="true"])').getBoundingClientRect();const tile=document.querySelector('[data-pinned="true"]').getBoundingClientRect();return normal.width>tile.width*2})()`), 'Regular tabs retain full-width rows');
    assert.ok(await evaluate<boolean>(`document.querySelector('.tab-strip-scroll').scrollTop>0`), 'Only the vertical tab list scrolls under the pinned grid');
    await command('screenshot', { file: path.join(root, `${side}-pinned-grid.png`) });
  }
  await evaluate(`document.querySelector('[data-pinned="true"]').click();true`);
  await until(async()=>await evaluate<boolean>(`document.querySelector('[data-pinned="true"]').classList.contains('theme-tab-selected')`),'A pinned tile selects normally');
  await evaluate(`document.querySelector('[data-pinned="true"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:160,clientY:100}));true`);
  await until(async()=>await evaluate<boolean>(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(item=>item.textContent.trim()==='Unpin Tab')`),'Grid tile retains its context menu');
  await evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(item=>item.textContent.trim()==='Unpin Tab').click();true`);
  await until(async()=>await evaluate<boolean>(`document.querySelectorAll('[data-pinned="true"]').length===5`),'Grid tile can be unpinned');
  await pin();
  const tilePositions = await evaluate<{id:string;x:number;y:number}[]>(`Array.from(document.querySelectorAll('[data-pinned="true"]')).map(tab=>{const r=tab.getBoundingClientRect();return {id:tab.dataset.tabId,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})`);
  await command('mouse-input', { input: { type:'mouseMove', x:tilePositions[0].x,y:tilePositions[0].y } });
  await command('mouse-input', { input: { type:'mouseDown', x:tilePositions[0].x,y:tilePositions[0].y,button:'left',clickCount:1 } });
  for(const ratio of [.25,.5,.75,1]) await command('mouse-input',{input:{type:'mouseMove',x:Math.round(tilePositions[0].x+(tilePositions[1].x-tilePositions[0].x)*ratio),y:tilePositions[0].y,modifiers:['leftButtonDown']}});
  await command('mouse-input', { input:{type:'mouseUp',x:tilePositions[1].x,y:tilePositions[1].y,button:'left',clickCount:1} });
  await until(async()=>await evaluate<boolean>(`document.querySelectorAll('[data-pinned="true"]')[1].dataset.tabId===${JSON.stringify(tilePositions[0].id)}`),'Pinned tiles reorder horizontally within a row');
  await command('screenshot', { file: path.join(root, 'right-pinned.png') });
  await settings({ tabStripPosition: 'top', animationsEnabled: true, startupRestoreBehavior: 'windows' });
  await until(async () => await evaluate<boolean>(`!!document.querySelector('.tab-connection-horizontal')`), 'Horizontal curves render before restart');
  await delay(220);
  await evaluate(`document.querySelector('[data-tab-id]:not([data-pinned="true"])').click();true`);
  await until(async () => await evaluate<boolean>(`!document.querySelector('.theme-tab-selected').hasAttribute('data-pinned')`), 'A regular tab is selected before quitting');
  await command('quit');
  await until(() => child.exitCode !== null, 'Fixture exits');
  fs.rmSync(path.join(root, 'default-ready.json'), { force: true });
  child = launch();
  await until(() => fs.existsSync(path.join(root, 'default-ready.json')), 'Restored fixture ready');
  await until(async () => { try { return await evaluate<boolean>(`!!document.querySelector('.tab-connection-horizontal') && !document.querySelector('.browser-restoring-layout')`); } catch { return false; } }, 'Restored tab curves ready');
  const startupCurve = () => evaluate(`(()=>{const tab=document.querySelector('.theme-tab-selected');const curve=tab.querySelector('.tab-connection-curve');return {tab:tab.getBoundingClientRect().toJSON(),curve:curve.getBoundingClientRect().toJSON(),transform:getComputedStyle(tab).transform,radius:getComputedStyle(tab.querySelector('.tab-connection')).getPropertyValue('--tabConnectionRadius'),scrollTop:document.querySelector('.tab-strip-scroll').scrollTop}})()`);
  const coldCurve = await startupCurve() as typeof beforePin;
  assert.ok(Math.abs(coldCurve.tab.height-beforePin.tab.height)<.1 && Math.abs(coldCurve.curve.bottom-beforePin.curve.bottom)<.25, 'Fresh and restored windows use the same curve geometry');
  await command('screenshot', { file: path.join(root, 'startup-curve.png'), preserveBounds: true });
  await command('shortcut', { value: 'move-active-tab-right' });
  await delay(250);
  const movedCurve = await startupCurve() as typeof beforePin;
  assert.ok(Math.abs(coldCurve.curve.top-movedCurve.curve.top)<.25 && Math.abs(coldCurve.curve.bottom-movedCurve.curve.bottom)<.25, 'Moving a restored tab does not correct or change its startup curve position');
  const center = await evaluate<{x:number;y:number}>(`(()=>{const r=document.querySelector('.theme-tab-selected').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  await command('mouse-input', { input: { type: 'mouseMove', x: center.x, y: center.y } });
  await command('mouse-input', { input: { type: 'mouseDown', x: center.x, y: center.y, button: 'left', clickCount: 1 } });
  for (const distance of [20,50,80,110]) await command('mouse-input', { input: { type: 'mouseMove', x: center.x-distance, y: center.y, modifiers: ['leftButtonDown'] } });
  await command('mouse-input', { input: { type: 'mouseUp', x: center.x-110, y: center.y, button: 'left', clickCount: 1 } });
  await delay(300);
  const draggedCurve = await startupCurve() as typeof beforePin;
  assert.ok(Math.abs(coldCurve.curve.top-draggedCurve.curve.top)<.25 && Math.abs(coldCurve.curve.bottom-draggedCurve.curve.bottom)<.25, 'A pointer drag leaves the startup curve baseline unchanged');
  await command('screenshot', { file: path.join(root, 'moved-curve.png'), preserveBounds: true });
  console.log(`PASS: pinned tabs align without overlapping neighbors during horizontal overflow and scrolling, and remain aligned on both vertical tab sides. Artifacts: ${root}`);
} catch (error) {
  try { console.error(await geometry()); } catch { /* Preserve failure. */ }
  throw error;
} finally {
  try { await command('quit'); } catch { /* Fixture only. */ }
  if (child.exitCode === null) child.kill();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}


