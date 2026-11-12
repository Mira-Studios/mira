/* eslint-disable @typescript-eslint/no-require-imports */
/* global window, document, location, URL, Headers, Response, performance, getComputedStyle, MutationObserver, setTimeout, clearTimeout, module, process, require */
// This original implementation runs in the page's main world. Keep the installer
// self-contained: the same function is used at document start and for live settings.
function installYoutubeAdBeta(enabled) {
  const previous = window.__miraYoutubeAdBeta;
  if (!enabled) {
    previous?.stop();
    delete window.__miraYoutubeAdBeta;
    return;
  }
  const host = location.hostname;
  if (!['http:', 'https:'].includes(location.protocol) ||
      !['youtube.com', 'youtube-nocookie.com'].some(domain => host === domain || host.endsWith(`.${domain}`))) return;
  if (previous) return;

  let active = true;
  let scheduled = 0;
  let navigating = false;
  let adCycles = new WeakMap();
  const restore = [];
  const trapped = new WeakMap();
  const stats = { prunedResponses: 0, seekAttempts: 0, skipClicks: 0 };
  const adKeys = ['playerAds', 'adPlacements', 'adSlots'];
  const isObject = value => value !== null && typeof value === 'object';

  // Only remove player ad instructions. In particular, leave stream URLs,
  // signatures, playability errors, DRM, and ordinary page data intact.
  const prune = (value, forcePlayer = false) => {
    let changed = false;
    const seen = new WeakSet();
    const visit = (entry, force, depth) => {
      if (!isObject(entry) || depth > 24 || seen.has(entry)) return;
      seen.add(entry);
      const player = typeof entry.playabilityStatus?.status === 'string' ||
        typeof entry.videoDetails?.videoId === 'string' || isObject(entry.streamingData);
      if (force || player) {
        for (const key of adKeys) {
          if (Object.prototype.hasOwnProperty.call(entry, key)) {
            try { if (delete entry[key]) changed = true; } catch { /* Frozen data is left alone. */ }
          }
        }
        if (player) return;
      }
      for (const key of Object.keys(entry)) {
        visit(entry[key], key === 'playerResponse' || key === 'player', depth + 1);
      }
    };
    try { if (active) visit(value, forcePlayer, 0); } catch { /* Unusual page-owned objects fail open. */ }
    if (changed) stats.prunedResponses++;
    return changed;
  };
  const cleanText = (value, forcePlayer) => {
    if (!active || typeof value !== 'string') return value;
    try {
      const data = JSON.parse(value);
      return prune(data, forcePlayer) ? JSON.stringify(data) : value;
    } catch { return value; }
  };
  const cleanPlayer = value => {
    if (typeof value === 'string') return cleanText(value, true);
    prune(value, true);
    return value;
  };

  // Trap the initial assignment before YouTube's inline bootstrap reads it, and
  // support the older ytplayer.config.args.player_response representation too.
  const trap = (target, key, transform) => {
    if (!isObject(target)) return;
    let keys = trapped.get(target);
    if (keys?.has(key)) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (descriptor && (!descriptor.configurable || (!descriptor.get && descriptor.writable === false))) return;
    if (!keys) { keys = new Set(); trapped.set(target, keys); }
    keys.add(key);
    let assigned = !!descriptor;
    let value = descriptor?.value;
    const get = function () {
      const current = descriptor?.get ? descriptor.get.call(this) : value;
      const cleaned = active ? transform(current) : current;
      if (!descriptor?.get) value = cleaned;
      return cleaned;
    };
    const set = function (next) {
      assigned = true;
      const cleaned = active ? transform(next) : next;
      if (descriptor?.set) descriptor.set.call(this, cleaned);
      else value = cleaned;
    };
    try {
      Object.defineProperty(target, key, {
        configurable: true, enumerable: descriptor?.enumerable ?? true, get, set,
      });
      restore.push(() => {
        if (Object.getOwnPropertyDescriptor(target, key)?.get !== get) return;
        if (descriptor?.get || descriptor?.set) Object.defineProperty(target, key, descriptor);
        else if (assigned) Object.defineProperty(target, key, {
          configurable: true, enumerable: descriptor?.enumerable ?? true,
          writable: descriptor?.writable ?? true, value,
        });
        else delete target[key];
      });
      get.call(target);
    } catch { /* Non-configurable page properties must keep working. */ }
  };
  trap(window, 'ytInitialPlayerResponse', cleanPlayer);
  trap(window, 'ytInitialData', value => { prune(value); return value; });
  trap(window, 'ytplayer', player => {
    trap(player, 'config', config => {
      trap(config, 'args', args => { trap(args, 'player_response', cleanPlayer); return args; });
      return config;
    });
    return player;
  });

  const endpoint = input => {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      if (!['http:', 'https:'].includes(url.protocol) ||
          !['youtube.com', 'youtube-nocookie.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
      const match = /^\/youtubei\/v1\/(player|next|playlist|get_watch|resolve_url)$/.exec(url.pathname);
      if (match) return { player: match[1] === 'player' };
      if ((url.pathname === '/watch' && (url.searchParams.has('v') || url.searchParams.has('t'))) ||
          (url.pathname === '/playlist' && url.searchParams.has('list'))) return { player: false };
      return null;
    } catch { return null; }
  };
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    const fetch = async function (...args) {
      const target = endpoint(args[0]);
      const response = await Reflect.apply(nativeFetch, this, args);
      if (!active || !target || !response.ok || (response.url && !endpoint(response.url))) return response;
      try {
        const original = await response.clone().text();
        const cleaned = cleanText(original, target.player);
        if (!active || cleaned === original) return response;
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        const replacement = new Response(cleaned, { status: response.status, statusText: response.statusText, headers });
        const decorate = result => {
          for (const key of ['url', 'type', 'redirected']) {
            Object.defineProperty(result, key, { value: response[key] });
          }
          const clone = result.clone;
          Object.defineProperty(result, 'clone', { value: function () {
            return decorate(Reflect.apply(clone, this, []));
          } });
          return result;
        };
        return decorate(replacement);
      } catch { return response; }
    };
    window.fetch = fetch;
    restore.push(() => { if (window.fetch === fetch) window.fetch = nativeFetch; });
  }

  const xhr = window.XMLHttpRequest?.prototype;
  if (xhr) {
    const requests = new WeakMap();
    const open = xhr.open;
    const wrappedOpen = function (method, url, ...args) {
      const result = Reflect.apply(open, this, [method, url, ...args]);
      requests.set(this, { target: endpoint(url), original: undefined, cleaned: undefined });
      return result;
    };
    xhr.open = wrappedOpen;
    restore.push(() => { if (xhr.open === wrappedOpen) xhr.open = open; });
    for (const key of ['response', 'responseText']) {
      const descriptor = Object.getOwnPropertyDescriptor(xhr, key);
      if (!descriptor?.get || !descriptor.configurable) continue;
      const get = function () {
        const value = descriptor.get.call(this);
        const state = requests.get(this);
        if (!active || !state?.target || this.readyState !== 4 ||
            this.status < 200 || this.status >= 300 || (this.responseURL && !endpoint(this.responseURL))) return value;
        if (typeof value === 'string') {
          if (state.original !== value) {
            state.original = value;
            state.cleaned = cleanText(value, state.target.player);
          }
          return state.cleaned;
        }
        if (this.responseType === 'json') prune(value, state.target.player);
        return value;
      };
      Object.defineProperty(xhr, key, { ...descriptor, get });
      restore.push(() => {
        if (Object.getOwnPropertyDescriptor(xhr, key)?.get === get) Object.defineProperty(xhr, key, descriptor);
      });
    }
  }

  // The fallback operates only on an interrupting ad. It never changes playback
  // rate, volume, unload handlers, or an ordinary video's playback position.
  const isAd = player => player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  const visible = element => element && element.getClientRects().length &&
    element.getAttribute('aria-hidden') !== 'true' && getComputedStyle(element).visibility !== 'hidden';
  const check = () => {
    scheduled = 0;
    if (!active || navigating) return;
    for (const player of document.querySelectorAll('.html5-video-player')) {
      if (!isAd(player)) { adCycles.delete(player); continue; }
      schedule(500);
      const media = player.querySelector('video');
      const source = media && (media.currentSrc || media.src);
      let state = adCycles.get(player);
      if (!state || state.media !== media || state.source !== source || state.duration !== media?.duration) {
        state = { media, source, duration: media?.duration, seekAttempts: 0, lastSeek: -Infinity,
          skip: null, skipClicks: 0, lastClick: -Infinity };
        adCycles.set(player, state);
      }
      const now = performance.now();
      const skip = player.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern');
      if (skip !== state.skip) { state.skip = skip; state.skipClicks = 0; }
      if (skip && !skip.disabled && skip.getAttribute('aria-disabled') !== 'true' &&
          visible(skip) && state.skipClicks < 3) {
        if (now - state.lastClick >= 1000 && isAd(player)) {
          state.lastClick = now;
          state.skipClicks++;
          stats.skipClicks++;
          skip.click();
        }
        continue;
      }
      // A lone/stale ad marker is sufficient to try a real skip control, but not
      // to seek media. Require both interrupting-ad markers for that fallback.
      if (!player.classList.contains('ad-showing') || !player.classList.contains('ad-interrupting') ||
          !media || !source || media.readyState < 2 || media.paused || media.seeking ||
          !Number.isFinite(media.duration) || media.duration <= 0 || media.currentTime < 0.05 ||
          media.currentTime >= media.duration - 0.1 || state.seekAttempts >= 3 || now - state.lastSeek < 1000) continue;
      if (![...player.querySelectorAll('.ytp-ad-player-overlay, .ytp-ad-text, .ytp-ad-preview-container, .ytp-ad-simple-ad-badge, .ytp-ad-duration-remaining')].some(visible)) continue;
      // Recheck after inspecting media: YouTube reuses this element for content.
      if (!player.classList.contains('ad-showing') || !player.classList.contains('ad-interrupting') ||
          player.querySelector('video') !== media || (media.currentSrc || media.src) !== source) continue;
      state.seekAttempts++;
      state.lastSeek = now;
      try {
        media.currentTime = Math.max(0, media.duration - 0.05);
        stats.seekAttempts++;
      } catch { /* A failed seek can be retried, but never in an unbounded loop. */ }
    }
  };
  function schedule(delay = 50) {
    // Timers keep the fallback usable in background tabs where rAF is suspended.
    if (active && !scheduled) scheduled = setTimeout(check, typeof delay === 'number' ? delay : 50);
  }
  const navigateStart = () => { navigating = true; adCycles = new WeakMap(); };
  const navigateFinish = () => { navigating = false; adCycles = new WeakMap(); schedule(); };
  const mediaEvents = ['loadedmetadata', 'durationchange', 'loadeddata', 'canplay', 'playing', 'timeupdate', 'emptied'];
  const observer = new MutationObserver(() => schedule());
  // A document-start preload can run before documentElement exists.
  observer.observe(document, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'disabled', 'aria-disabled', 'aria-hidden'] });
  document.addEventListener('yt-navigate-start', navigateStart);
  document.addEventListener('yt-navigate-finish', navigateFinish);
  for (const event of mediaEvents) document.addEventListener(event, schedule, true);
  window.addEventListener('popstate', navigateFinish);
  const pagehide = event => { if (!event.persisted) stop(); };
  window.addEventListener('pagehide', pagehide);
  function stop() {
    if (!active) return;
    active = false;
    observer.disconnect();
    clearTimeout(scheduled);
    document.removeEventListener('yt-navigate-start', navigateStart);
    document.removeEventListener('yt-navigate-finish', navigateFinish);
    for (const event of mediaEvents) document.removeEventListener(event, schedule, true);
    window.removeEventListener('popstate', navigateFinish);
    window.removeEventListener('pagehide', pagehide);
    for (const undo of restore.reverse()) {
      try { undo(); } catch { /* Page changes must not prevent the rest of cleanup. */ }
    }
    if (window.__miraYoutubeAdBeta?.stop === stop) delete window.__miraYoutubeAdBeta;
  }
  window.__miraYoutubeAdBeta = { stop, stats };
  schedule();
}

if (typeof module !== 'undefined') module.exports = { installYoutubeAdBeta };
if (typeof process !== 'undefined' && process.type === 'renderer') {
  const host = location.hostname;
  if (['http:', 'https:'].includes(location.protocol) &&
      ['youtube.com', 'youtube-nocookie.com'].some(domain => host === domain || host.endsWith(`.${domain}`))) {
    const { contextBridge, ipcRenderer } = require('electron');
    const enabled = ipcRenderer.sendSync('youtube-ad-beta-enabled') === true;
    contextBridge.executeInMainWorld({ func: installYoutubeAdBeta, args: [enabled] });
  }
}
