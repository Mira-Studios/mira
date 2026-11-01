/* eslint-disable @typescript-eslint/no-require-imports */
/* global window, document, navigator, Element, HTMLMediaElement, MediaStreamTrack, EventTarget, Event, module, process, require */
// Used both as a sandboxed session preload and for Chromium's initial empty frames,
// which do not run ordinary preloads. This function exposes no Node or IPC APIs.
function installSuspensionActivity() {
  if (window.__miraSuspensionActivity) return;
  let edited = false;
  let pendingMedia = 0;
  const tracks = new Set();
  const peers = new Set();
  const playedMedia = new Set();
  const unloadListeners = new Map();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const capture = (options) => (typeof options === 'boolean' ? options : options?.capture === true);
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const result = add.call(this, type, listener, options);
    if (this === window && type === 'beforeunload' && listener) {
      const captures = unloadListeners.get(listener) ?? new Set();
      captures.add(capture(options));
      unloadListeners.set(listener, captures);
    }
    return result;
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const result = remove.call(this, type, listener, options);
    if (this === window && type === 'beforeunload') {
      const captures = unloadListeners.get(listener);
      captures?.delete(capture(options));
      if (captures?.size === 0) unloadListeners.delete(listener);
    }
    return result;
  };
  const markEdited = (event) => {
    if (event.isTrusted) edited = true;
  };
  window.addEventListener('input', markEdited, true);
  window.addEventListener('change', markEdited, true);
  const attachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (...args) {
    const root = attachShadow.apply(this, args);
    root.addEventListener('input', markEdited, true);
    root.addEventListener('change', markEdited, true);
    return root;
  };
  const rememberTrack = (track) => {
    tracks.add(track);
    track.addEventListener('ended', () => tracks.delete(track), { once: true });
  };
  for (const method of ['getUserMedia', 'getDisplayMedia']) {
    const original = navigator.mediaDevices?.[method];
    if (!original) continue;
    navigator.mediaDevices[method] = async function (...args) {
      pendingMedia++;
      try {
        const stream = await original.apply(this, args);
        stream.getTracks().forEach(rememberTrack);
        return stream;
      } finally {
        pendingMedia--;
      }
    };
  }
  const cloneTrack = window.MediaStreamTrack?.prototype.clone;
  if (cloneTrack)
    MediaStreamTrack.prototype.clone = function (...args) {
      const track = cloneTrack.apply(this, args);
      rememberTrack(track);
      return track;
    };
  if (window.RTCPeerConnection)
    window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget);
        peers.add(peer);
        const clear = () => {
          if (peer.connectionState === 'closed' || peer.signalingState === 'closed')
            peers.delete(peer);
        };
        peer.addEventListener('connectionstatechange', clear);
        peer.addEventListener('signalingstatechange', clear);
        return peer;
      },
    });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    playedMedia.add(this);
    const clear = () => playedMedia.delete(this);
    this.addEventListener('pause', clear, { once: true });
    this.addEventListener('ended', clear, { once: true });
    return play.apply(this, args);
  };
  const playingIn = (root) => {
    for (const element of root.querySelectorAll('*')) {
      if (element instanceof HTMLMediaElement && !element.paused && !element.ended) return true;
      if (element.shadowRoot && playingIn(element.shadowRoot)) return true;
    }
    return false;
  };
  const wouldPreventUnload = () => {
    if (window.__miraSiteInteractions) return window.__miraSiteInteractions.wouldPreventUnload();
    // Empty documents do not run the usual site-interaction preload. Use the
    // same generic no-dialog probe there, including handlers registered by a parent.
    const handler = window.onbeforeunload;
    if (!handler && unloadListeners.size === 0) return false;
    const event = new Event('beforeunload', { cancelable: true });
    let requested = false;
    Object.defineProperty(event, 'returnValue', {
      get: () => '',
      set: () => {
        requested = true;
      },
    });
    const alert = window.alert;
    const confirm = window.confirm;
    const prompt = window.prompt;
    window.onbeforeunload = null;
    window.alert = () => {};
    window.confirm = () => false;
    window.prompt = () => null;
    try {
      window.dispatchEvent(event);
      const value = handler?.call(window, event);
      return requested || event.defaultPrevented || value != null;
    } finally {
      window.onbeforeunload = handler;
      window.alert = alert;
      window.confirm = confirm;
      window.prompt = prompt;
    }
  };
  Object.defineProperty(window, '__miraSuspensionActivity', {
    value: Object.freeze({
      isBusy: () => {
        for (const track of tracks) if (track.readyState === 'ended') tracks.delete(track);
        for (const peer of peers) if (peer.signalingState === 'closed') peers.delete(peer);
        for (const media of playedMedia) if (media.paused || media.ended) playedMedia.delete(media);
        if (
          edited ||
          pendingMedia > 0 ||
          tracks.size > 0 ||
          peers.size > 0 ||
          playedMedia.size > 0 ||
          playingIn(document)
        )
          return true;
        // A routine beforeunload listener is not itself a draft. Ask whether it
        // actually requests confirmation, without presenting a dialog.
        return wouldPreventUnload();
      },
    }),
  });
}

if (typeof module !== 'undefined') module.exports = { installSuspensionActivity };
if (process.type === 'renderer') {
  const { contextBridge } = require('electron');
  contextBridge.executeInMainWorld({ func: installSuspensionActivity });
}
