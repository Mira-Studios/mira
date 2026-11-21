/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, document, performance, crypto, window, setInterval, clearInterval, RTCPeerConnection, MediaStream */
const { contextBridge, ipcRenderer } = require('electron');
// Observe videos in each frame without exposing IPC or media streams to site scripts.
{
  const ids = new WeakMap();
  const lastPlaying = new WeakMap();
  const lastInput = new WeakMap();
  let selected = null;
  let peer = null;
  let token = null;
  let tracks = [];
  let pendingIce = [];
  let lastReport = 0;
  let reportedVideo = false;
  const stop = () => {
    peer?.close();
    peer = null;
    for (const track of tracks) track.stop();
    tracks = [];
    selected = null;
    token = null;
    pendingIce = [];
  };
  const observedDocuments = new WeakSet();
  const observeDocument = (doc) => {
    if (observedDocuments.has(doc)) return;
    observedDocuments.add(doc);
    for (const event of ['pointerdown', 'keydown'])
      doc.addEventListener(
        event,
        (value) => {
          if (value.isTrusted) lastInput.set(doc, performance.now());
        },
        true,
      );
    for (const event of [
      'play',
      'playing',
      'pause',
      'ended',
      'loadeddata',
      'volumechange',
      'seeked',
      'emptied',
    ])
      doc.addEventListener(
        event,
        (value) => {
          const media = value.target;
          if (media?.tagName === 'VIDEO') {
            if (event === 'emptied') {
              ids.delete(media);
              lastPlaying.delete(media);
            }
            if (event === 'playing') {
              lastPlaying.set(media, performance.now());
              lastInput.delete(doc);
            }
            if (
              event === 'pause' &&
              (media === selected || performance.now() - (lastInput.get(doc) ?? -Infinity) < 1200)
            )
              lastPlaying.delete(media);
          }
          report();
        },
        true,
      );
  };
  const videos = () =>
    [...document.querySelectorAll('video')]
      .filter(
        (video) =>
          (video === selected || video.readyState >= 2) &&
          video.videoWidth > 0 &&
          video.videoHeight > 0 &&
          !video.disablePictureInPicture,
      )
      .slice(0, 12);
  const report = () => {
    lastReport = performance.now();
    const list = videos().map((video) => {
      if (!video.paused && !video.ended) lastPlaying.set(video, performance.now());
      if (!ids.has(video)) ids.set(video, crypto.randomUUID());
      const rect = video.getBoundingClientRect();
      return {
        id: ids.get(video),
        playing:
          !video.ended &&
          (!video.paused ||
            (!selected && performance.now() - (lastPlaying.get(video) ?? -Infinity) < 750)),
        ended: video.ended,
        muted: video.muted,
        volume: video.volume,
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        width: video.videoWidth,
        height: video.videoHeight,
        area: Math.max(0, rect.width * rect.height),
      };
    });
    reportedVideo = list.length > 0;
    ipcRenderer.send('mira-pip-videos', list);
  };
  const changed = () => {
    if (performance.now() - lastReport >= 200) report();
  };
  observeDocument(document);
  document.addEventListener('timeupdate', changed, true);
  const reportTimer = setInterval(() => {
    if (selected || reportedVideo || document.querySelector('video')) report();
  }, 750);
  window.addEventListener(
    'pagehide',
    () => {
      clearInterval(reportTimer);
      stop();
      ipcRenderer.send('mira-pip-videos', []);
    },
    { once: true },
  );
  ipcRenderer.on('mira-pip-start', async (_event, request) => {
    stop();
    token = request.token;
    selected = videos().find((video) => ids.get(video) === request.id);
    if (!selected) return;
    try {
      if (selected.paused && !selected.ended) await selected.play();
      const captured = selected.captureStream();
      tracks = captured.getVideoTracks().map((track) => track.clone());
      if (!tracks.length) throw new Error('This video does not support picture in picture.');
      const connection = new RTCPeerConnection({ iceServers: [] });
      peer = connection;
      connection.onicecandidate = (event) => {
        if (event.candidate && peer === connection)
          ipcRenderer.send('pip-signal', { token, data: { candidate: event.candidate.toJSON() } });
      };
      for (const track of tracks) connection.addTrack(track, new MediaStream([track]));
      const offer = await connection.createOffer();
      if (peer !== connection) return;
      await connection.setLocalDescription(offer);
      ipcRenderer.send('pip-signal', {
        token,
        data: { description: connection.localDescription.toJSON() },
      });
    } catch {
      ipcRenderer.send('pip-signal', {
        token,
        data: { error: 'This video cannot be shown in picture in picture.' },
      });
    }
  });
  ipcRenderer.on('mira-pip-signal', async (_event, request) => {
    if (!peer || request.token !== token) return;
    const connection = peer;
    try {
      if (request.data.description) {
        await connection.setRemoteDescription(request.data.description);
        for (const candidate of pendingIce) await connection.addIceCandidate(candidate);
        pendingIce = [];
      } else if (request.data.candidate) {
        if (connection.remoteDescription) await connection.addIceCandidate(request.data.candidate);
        else pendingIce.push(request.data.candidate);
      }
    } catch {
      /* Navigation can end an in-flight negotiation. */
    }
  });
  ipcRenderer.on('mira-pip-stop', (_event, request) => {
    if (request.token === token) stop();
  });
  const control = async (request) => {
    if (!selected || request.token !== token) return;
    try {
      if (request.action === 'play') await selected.play();
      if (request.action === 'pause') selected.pause();
      if (request.action === 'seek' && Number.isFinite(request.value)) {
        const start = selected.seekable.length ? selected.seekable.start(0) : 0;
        const end = Number.isFinite(selected.duration)
          ? selected.duration
          : selected.seekable.length
            ? selected.seekable.end(selected.seekable.length - 1)
            : start;
        selected.currentTime = Math.min(end, Math.max(start, request.value));
      }
      if (request.action === 'mute' && typeof request.value === 'boolean')
        selected.muted = request.value;
      if (request.action === 'volume' && Number.isFinite(request.value)) {
        selected.volume = Math.min(1, Math.max(0, request.value));
        selected.muted = selected.volume === 0;
      }
      report();
    } catch {
      /* Detached or protected media may reject a control operation. */
    }
    return true;
  };
  // Main invokes only these media operations with the user's PiP gesture.
  // No privileged IPC operations are exposed to site scripts.
  contextBridge.exposeInMainWorld('__miraPipMedia', { control });
  ipcRenderer.on('mira-pip-command', (_event, request) => {
    void control(request);
  });
}
