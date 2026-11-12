// Run with node_modules/electron/dist/electron.exe apps/desktop/tests/youtubeAdBeta.electron.ts
// Unset ELECTRON_RUN_AS_NODE before launching Electron.
import { app, BrowserWindow, ipcMain, session, webContents } from 'electron';
import type { WebContents } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  applyYoutubeAdBeta,
  registerYoutubeAdPreload,
  setupYoutubeAdBlockingSettings,
} from '../electron/youtubeAdBlocking.ts';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = path.resolve(testRoot, '../../../.tmp');
mkdirSync(tempRoot, { recursive: true });
const userData = mkdtempSync(path.join(tempRoot, 'youtube-ad-blocking-'));
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const deadline = globalThis.setTimeout(() => {
  console.error('YouTube ad blocking integration test timed out');
  app.exit(1);
}, 45_000);

function playerResponse() {
  return {
    responseContext: { visitorData: 'fixture-visitor' },
    playabilityStatus: { status: 'OK' },
    streamingData: { formats: [{ itag: 18, url: 'https://media.example/video.mp4' }] },
    videoDetails: { videoId: 'fixture-video', title: 'Fixture content' },
    adPlacements: [{ adPlacementRenderer: {} }],
    playerAds: [{ playerLegacyDesktopWatchAdsRenderer: {} }],
    adSlots: [{ adSlotRenderer: {} }],
    unrelated: { adPlacements: ['keep-unrelated-metadata'] },
  };
}

function fixturePage(embed = false) {
  return `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="script-src 'nonce-fixture'; frame-src https://www.youtube-nocookie.com">
    <script nonce="fixture">
      window.ytInitialPlayerResponse = ${JSON.stringify(playerResponse())};
      window.earlyPlayerSnapshot = JSON.parse(JSON.stringify(window.ytInitialPlayerResponse));
      window.ytplayer = { config: { args: { player_response: JSON.stringify(${JSON.stringify(playerResponse())}) } } };
      window.earlyLegacySnapshot = JSON.parse(window.ytplayer.config.args.player_response);
      window.ytInitialData = { playerResponse: ${JSON.stringify(playerResponse())}, unrelated: { adSlots: ['keep'] } };
      window.earlyInitialDataSnapshot = JSON.parse(JSON.stringify(window.ytInitialData));
    </script></head><body>
    <div id="movie_player" class="html5-video-player"><video></video></div>
    ${embed ? '' : '<iframe src="https://www.youtube-nocookie.com/embed/fixture-video"></iframe>'}
    </body></html>`;
}

async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 5000) {
  const expires = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < expires, message);
    await delay(25);
  }
}

function assertPlayerClean(value: ReturnType<typeof playerResponse>, message: string) {
  for (const field of ['adPlacements', 'playerAds', 'adSlots'] as const) {
    assert.ok(!value[field] || value[field].length === 0, `${message}: ${field} removed`);
  }
  const expected = playerResponse();
  assert.deepEqual(value.streamingData, expected.streamingData, `${message}: video stream preserved`);
  assert.deepEqual(value.playabilityStatus, expected.playabilityStatus, `${message}: playability preserved`);
  assert.deepEqual(value.responseContext, expected.responseContext, `${message}: response context preserved`);
  assert.deepEqual(value.videoDetails, expected.videoDetails, `${message}: video details preserved`);
  assert.deepEqual(value.unrelated, expected.unrelated, `${message}: unrelated metadata preserved`);
}

async function run() {
  let win: BrowserWindow | undefined;
  try {
    await app.whenReady();
    let enabled = true;
    const settingRequests: string[] = [];
    ipcMain.on('youtube-ad-beta-enabled', (event) => {
      settingRequests.push(`${event.sender.getType()}: ${event.senderFrame?.url}`);
    });
    setupYoutubeAdBlockingSettings(() => enabled);
    const partition = `youtube-ad-fixture-${process.pid}`;
    const ses = session.fromPartition(partition);
    registerYoutubeAdPreload(ses);
    registerYoutubeAdPreload(ses);
    assert.equal(ses.getPreloadScripts().length, 1, 'Preload registration is idempotent');
    const preloadErrors: string[] = [];
    app.on('web-contents-created', (_event, contents) => {
      contents.on('preload-error', (_errorEvent, preloadPath, error) => {
        preloadErrors.push(`${preloadPath}: ${error.message}`);
      });
    });
    await ses.protocol.handle('https', async (request) => {
      const url = new URL(request.url);
      if ((url.pathname === '/watch' && url.searchParams.get('fixture') !== 'json') || url.pathname.startsWith('/embed/')) {
        return new Response(fixturePage(url.pathname.startsWith('/embed/')), {
          headers: { 'Content-Type': 'text/html' },
        });
      }
      if (url.searchParams.has('delay')) await delay(250);
      const payload = url.searchParams.has('array') ? [{ playerResponse: playerResponse() }]
        : url.searchParams.has('envelope') || url.pathname.endsWith('/next')
          ? { playerResponse: playerResponse(), unrelated: { adSlots: ['keep'] } }
          : playerResponse();
      const body = url.searchParams.has('malformed') ? '{broken-json' : JSON.stringify(payload);
      return new Response(body, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json', 'X-Fixture': 'preserved' },
      });
    });
    win = new BrowserWindow({
      show: false,
      webPreferences: { webviewTag: true, contextIsolation: true, sandbox: true },
    });
    win.webContents.on('will-attach-webview', (_event, preferences) => {
      preferences.nodeIntegration = false;
      preferences.nodeIntegrationInSubFrames = true;
      preferences.contextIsolation = true;
      preferences.sandbox = true;
      preferences.backgroundThrottling = false;
    });
    await win.loadURL(`data:text/html,${encodeURIComponent(`<webview partition="${partition}" src="https://www.youtube.com/watch?v=fixture-video"></webview>`)}`);
    let guest: WebContents | undefined;
    await until(() => {
      guest = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview'
        && contents.hostWebContents === win?.webContents);
      return !!guest && !guest.isLoading() && guest.mainFrame.framesInSubtree.length === 2;
    }, 'YouTube fixture and embedded player load');
    const contents = guest!;
    assert.deepEqual(preloadErrors, [], 'Sandboxed document-start preload runs without errors');

    for (const frame of contents.mainFrame.framesInSubtree) {
      const initial = await frame.executeJavaScript('({ player: window.earlyPlayerSnapshot, legacy: window.earlyLegacySnapshot, data: window.earlyInitialDataSnapshot, installed: !!window.__miraYoutubeAdBeta })');
      assert.equal(initial.installed, true, `Helper installed before page scripts in ${frame.url}; requests: ${settingRequests.join(', ')}`);
      assertPlayerClean(initial.player, 'Document-start player');
      assertPlayerClean(initial.legacy, 'Legacy initial player config');
      assertPlayerClean(initial.data.playerResponse, 'Nested initial page player data');
      assert.deepEqual(initial.data.unrelated, { adSlots: ['keep'] });
    }
    console.log('PASS document-start installation, legacy config and privacy embeds');

    const fetchResults = await contents.executeJavaScript(`(async () => {
      const results = [];
      for (const endpoint of ['player', 'playlist', 'get_watch', 'resolve_url']) {
        const url = location.origin + '/youtubei/v1/' + endpoint + '?fixture=1';
        const response = await fetch(url, { method: 'POST', body: '{}' });
        const copy = response.clone();
        results.push({ endpoint, url: response.url, expectedUrl: url, status: response.status,
          statusText: response.statusText, type: response.type, redirected: response.redirected,
          header: response.headers.get('x-fixture'), before: response.bodyUsed,
          player: await response.json(), after: response.bodyUsed, clone: JSON.parse(await copy.text()),
          cloneUrl: copy.url, cloneType: copy.type, cloneRedirected: copy.redirected });
      }
      return results;
    })()`);
    for (const result of fetchResults) {
      assertPlayerClean(result.player, `Fetch ${result.endpoint}`);
      assertPlayerClean(result.clone, `Cloned fetch ${result.endpoint}`);
      assert.equal(result.url, result.expectedUrl, 'Fetch response URL preserved');
      assert.equal(result.status, 200);
      assert.equal(result.statusText, 'OK');
      assert.equal(result.type, 'basic');
      assert.equal(result.redirected, false);
      assert.equal(result.cloneUrl, result.expectedUrl, 'Cloned response URL preserved');
      assert.equal(result.cloneType, 'basic', 'Cloned response type preserved');
      assert.equal(result.cloneRedirected, false, 'Cloned response redirect metadata preserved');
      assert.equal(result.header, 'preserved');
      assert.equal(result.before, false);
      assert.equal(result.after, true);
    }
    const next = await contents.executeJavaScript(`fetch('/youtubei/v1/next', {method:'POST'}).then(r => r.json())`);
    assertPlayerClean(next.playerResponse, 'Nested next response');
    assert.deepEqual(next.unrelated, { adSlots: ['keep'] });
    const playerEnvelopes = await contents.executeJavaScript(`Promise.all([
      '/youtubei/v1/player?envelope', '/youtubei/v1/player?array'
    ].map(url => fetch(url, { method: 'POST' }).then(response => response.json())))`);
    assertPlayerClean(playerEnvelopes[0].playerResponse, 'Player object envelope');
    assert.deepEqual(playerEnvelopes[0].unrelated, { adSlots: ['keep'] });
    assertPlayerClean(playerEnvelopes[1][0].playerResponse, 'Player array envelope');
    const unmodified = await contents.executeJavaScript(`(async () => ({
      unrelatedPath: await (await fetch('/api/unrelated')).json(),
      similarPath: await (await fetch('/youtubei/v1/player-extra')).json(),
      malformed: await (await fetch('/youtubei/v1/player?malformed')).text()
    }))()`);
    assert.deepEqual(unmodified.unrelatedPath, playerResponse(), 'Unrelated endpoint untouched');
    assert.deepEqual(unmodified.similarPath, playerResponse(), 'Similar endpoint untouched');
    assert.equal(unmodified.malformed, '{broken-json', 'Malformed response fails open');
    const navigationResponses = await contents.executeJavaScript(`Promise.all([
      '/watch?v=fixture-video&fixture=json', '/playlist?list=fixture-list&fixture=json'
    ].map(url => fetch(url).then(response => response.json())))`);
    for (const response of navigationResponses) assertPlayerClean(response, 'SPA watch/playlist JSON response');
    console.log('PASS fetch endpoints, response semantics and scoped pruning');

    const xhrResults = await contents.executeJavaScript(`Promise.all(['', 'json'].map(responseType => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/youtubei/v1/player');
      xhr.responseType = responseType;
      xhr.onload = () => resolve({ type: responseType, status: xhr.status, url: xhr.responseURL,
        header: xhr.getResponseHeader('x-fixture'), player: responseType ? xhr.response : JSON.parse(xhr.responseText),
        responseMatchesText: responseType ? true : xhr.response === xhr.responseText });
      xhr.onerror = () => reject(new Error('Fixture XHR failed'));
      xhr.send('{}');
    })))`);
    for (const result of xhrResults) {
      assertPlayerClean(result.player, `XHR ${result.type || 'text'}`);
      assert.equal(result.status, 200);
      assert.equal(result.url, 'https://www.youtube.com/youtubei/v1/player');
      assert.equal(result.header, 'preserved');
      assert.equal(result.responseMatchesText, true);
    }
    console.log('PASS XHR text and JSON responses');

    const pending = contents.executeJavaScript(`fetch('/youtubei/v1/player?delay').then(r => r.json())`);
    enabled = false;
    await applyYoutubeAdBeta(contents, false);
    assert.deepEqual(await pending, playerResponse(), 'Disabling also preserves responses already in flight');
    for (const frame of contents.mainFrame.framesInSubtree) {
      assert.equal(await frame.executeJavaScript('!!window.__miraYoutubeAdBeta'), false, 'Live disable reaches every player frame');
    }
    const disabled = await contents.executeJavaScript(`fetch('/youtubei/v1/player').then(r => r.json())`);
    assert.deepEqual(disabled, playerResponse(), 'Disabled helper leaves subsequent responses untouched');
    await contents.executeJavaScript(`window.fixtureNativeFetch = window.fetch;
      window.fixtureNativeXhrResponse = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response').get;
      void 0`);
    enabled = true;
    await applyYoutubeAdBeta(contents, true);
    console.log('PASS live settings, embedded frames and in-flight requests');

    await contents.executeJavaScript(`(() => {
      const player = document.getElementById('movie_player');
      const video = player.querySelector('video');
      window.fixtureMedia = { source: 'https://media.example/ad-one', duration: 30, time: 1, seeks: [], clicks: 0 };
      const state = window.fixtureMedia;
      Object.defineProperties(video, {
        currentSrc: { configurable: true, get: () => state.source },
        duration: { configurable: true, get: () => state.duration },
        currentTime: { configurable: true, get: () => state.time, set: value => { state.seeks.push(value); if (!state.ignoreSeek) state.time = value; } },
        readyState: { configurable: true, get: () => 4 },
        paused: { configurable: true, get: () => false },
        seeking: { configurable: true, get: () => false }
      });
      const skip = document.createElement('button');
      skip.className = 'ytp-ad-skip-button';
      skip.textContent = 'Skip ad';
      skip.onclick = () => { state.clicks++; player.classList.remove('ad-showing', 'ad-interrupting'); };
      player.append(skip);
      player.classList.add('ad-showing', 'ad-interrupting');
      video.dispatchEvent(new Event('playing', { bubbles: true }));
    })()`);
    await until(() => contents.executeJavaScript('window.fixtureMedia.clicks === 1'), 'Visible ad skip control is clicked');
    await contents.executeJavaScript(`(() => {
      window.fixtureMedia.source = 'https://media.example/ad-two';
      window.fixtureMedia.time = 1;
      document.getElementById('movie_player').classList.add('ad-showing', 'ad-interrupting');
      document.dispatchEvent(new Event('yt-navigate-finish'));
    })()`);
    await until(() => contents.executeJavaScript('window.fixtureMedia.clicks === 2'), 'Same skip button is reusable for the next ad');
    await contents.executeJavaScript(`(() => {
      const state = window.fixtureMedia;
      state.source = 'https://media.example/content'; state.duration = 600; state.time = 80;
      document.querySelector('video').dispatchEvent(new Event('timeupdate', { bubbles: true }));
    })()`);
    await delay(350);
    const content = await contents.executeJavaScript('window.fixtureMedia');
    assert.deepEqual(content.seeks, [], 'Skip controls take priority and normal content is never seeked');
    assert.equal(content.time, 80, 'Content playback position remains unchanged');
    console.log('PASS repeated ad controls and ordinary video playback safety');

    await contents.executeJavaScript(`(() => {
      const player = document.getElementById('movie_player');
      player.querySelector('button').remove();
      player.classList.add('ad-showing', 'ad-interrupting');
      document.querySelector('video').dispatchEvent(new Event('timeupdate', { bubbles: true }));
    })()`);
    await delay(600);
    assert.deepEqual(await contents.executeJavaScript('window.fixtureMedia.seeks'), [], 'Stale ad classes without visible ad UI never seek content');
    await contents.executeJavaScript(`(() => {
      const state = window.fixtureMedia;
      state.source = 'https://media.example/ad-three'; state.duration = 30; state.time = 1; state.ignoreSeek = true;
      const marker = document.createElement('span'); marker.className = 'ytp-ad-text'; marker.textContent = 'Ad';
      document.getElementById('movie_player').append(marker);
      document.querySelector('video').dispatchEvent(new Event('playing', { bubbles: true }));
    })()`);
    await until(() => contents.executeJavaScript('window.fixtureMedia.seeks.length === 3'), 'Explicit ad media receives bounded seek retries');
    await delay(1200);
    const retries = await contents.executeJavaScript('window.fixtureMedia.seeks');
    assert.equal(retries.length, 3, 'A failed ad seek is retried at most three times');
    assert.ok(retries.every((value: number) => value > 29.8 && value <= 30), 'Only the confirmed ad end is targeted');
    console.log('PASS stale marker safety and bounded ad seek retries');

    await contents.executeJavaScript(`Object.freeze(window.ytplayer.config.args)`);
    enabled = false;
    await applyYoutubeAdBeta(contents, false);
    assert.deepEqual(await contents.executeJavaScript(`({
      installed: !!window.__miraYoutubeAdBeta,
      fetchRestored: window.fetch === window.fixtureNativeFetch,
      xhrRestored: Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response').get === window.fixtureNativeXhrResponse
    })`), { installed: false, fetchRestored: true, xhrRestored: true }, 'Frozen page config does not interrupt network hook cleanup');
    console.log('PASS complete cleanup after page-owned config changes');
    enabled = true;
    const requestsBeforeNavigation = settingRequests.length;
    await contents.loadURL('https://youtube.com.evil.test/embed/fixture-video');
    const lookalike = await contents.executeJavaScript('({ installed: !!window.__miraYoutubeAdBeta, player: window.earlyPlayerSnapshot })');
    assert.equal(lookalike.installed, false, 'Lookalike domains do not receive YouTube hooks');
    assert.deepEqual(lookalike.player, playerResponse(), 'Lookalike domains retain page data unchanged');
    assert.equal(settingRequests.length, requestsBeforeNavigation, 'Lookalike domain preload never requests settings');
    console.log('PASS navigation and lookalike origin isolation');
    assert.deepEqual(preloadErrors, []);
    console.log('YouTube ad blocking integration tests passed');
    win.destroy();
    clearTimeout(deadline);
    try { rmSync(userData, { recursive: true, force: true }); } catch { /* Chromium may still hold temporary files. */ }
    app.exit(0);
  } catch (error) {
    console.error(error);
    win?.destroy();
    clearTimeout(deadline);
    app.exit(1);
  }
}

void run();
