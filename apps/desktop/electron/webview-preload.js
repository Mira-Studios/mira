/* eslint-disable @typescript-eslint/no-require-imports */
/* global require */
const { contextBridge, ipcRenderer } = require('electron');

// Only these narrowly scoped operations are available to untrusted site scripts.
contextBridge.exposeInMainWorld('__miraInteractionBridge', {
  dialog: (data) => ipcRenderer.sendSync('webview-site-dialog-sync', data),
  passkey: (data) => ipcRenderer.invoke('webview-passkey-request', data),
  cancelPasskey: (id) => ipcRenderer.send('webview-passkey-cancel', id),
});
contextBridge.executeInMainWorld({ func: () => {
  const bridge = window.__miraInteractionBridge;
  const text = (value) => value == null ? '' : String(value);
  window.alert = (message = '') => { bridge.dialog({ type: 'alert', message: text(message) }); };
  window.confirm = (message = '') => bridge.dialog({ type: 'confirm', message: text(message) }) === true;
  window.prompt = (message = '', value = '') => bridge.dialog({ type: 'prompt', message: text(message), defaultValue: text(value) });

  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const prevent = Event.prototype.preventDefault;
  const nativeReturnValue = Object.getOwnPropertyDescriptor(BeforeUnloadEvent.prototype, 'returnValue');
  const onUnload = Object.getOwnPropertyDescriptor(window, 'onbeforeunload');
  const states = new WeakMap();
  let allowNext = false;
  let propertyHandler = null;
  const initialize = (event) => {
    if (event.isTrusted && allowNext) {
      allowNext = false;
      event.stopImmediatePropagation();
      return;
    }
    const state = { requested: false, accepted: true, finished: false, value: '' };
    states.set(event, state);
    Object.defineProperties(event, {
      preventDefault: { value: () => { state.requested = true; } },
      returnValue: { get: () => state.value, set: (value) => { state.value = text(value); state.requested = true; } },
    });
  };
  const finish = (event) => {
    const state = states.get(event);
    if (!state) return;
    state.finished = true;
    if (event.defaultPrevented) state.requested = true;
    if (!state.requested) return;
    state.accepted = bridge.dialog({ type: 'beforeunload', trusted: event.isTrusted }) === true;
    if (!state.accepted) {
      prevent.call(event);
      if (event.isTrusted) nativeReturnValue?.set?.call(event, '');
    }
  };
  const moveFinishLast = () => {
    remove.call(window, 'beforeunload', finish);
    add.call(window, 'beforeunload', finish);
  };
  add.call(window, 'beforeunload', initialize, true);
  moveFinishLast();
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const result = add.call(this, type, listener, options);
    if (this === window && type === 'beforeunload') moveFinishLast();
    return result;
  };
  if (onUnload?.set) {
    Object.defineProperty(window, 'onbeforeunload', {
      configurable: true, enumerable: true,
      get: () => propertyHandler,
      set: (handler) => {
        propertyHandler = typeof handler === 'function' ? handler : null;
        onUnload.set.call(window, propertyHandler ? function (event) {
          const value = propertyHandler?.call(window, event);
          if (value != null) event.returnValue = value;
        } : null);
        moveFinishLast();
      },
    });
  }
  Object.defineProperty(window, '__miraSiteInteractions', { value: Object.freeze({
    checkBeforeUnload: () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      const state = states.get(event);
      if (state && !state.finished) finish(event);
      return state ? state.accepted : !event.defaultPrevented;
    },
    allowNextUnload: () => { allowNext = true; },
  }) });

  const credentials = navigator.credentials;
  if (!credentials) return;
  for (const method of ['get', 'create']) {
    const original = credentials[method].bind(credentials);
    credentials[method] = async (options) => {
      if (!options?.publicKey) return original(options);
      const signal = options.signal;
      if (signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      const clientId = crypto.randomUUID();
      let aborted = false;
      const abort = () => { aborted = true; bridge.cancelPasskey(clientId); };
      signal?.addEventListener('abort', abort, { once: true });
      let approved;
      try { approved = await bridge.passkey({ clientId, intent: method }); }
      finally { signal?.removeEventListener('abort', abort); }
      if (aborted || signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError');
      if (!approved) throw new DOMException('The passkey request was dismissed.', 'NotAllowedError');
      return original(method === 'get' && options.mediation === 'conditional'
        ? { ...options, mediation: 'optional' } : options);
    };
  }
} });

// Observe page-owned device connections without opening or granting a device ourselves.
contextBridge.exposeInMainWorld('__miraDeviceBridge', {
  update: (data) => ipcRenderer.send('device-connection-update', data),
});
contextBridge.executeInMainWorld({ func: () => {
  const bridge = window.__miraDeviceBridge;
  const ids = new WeakMap();
  const connected = new Map();
  const nameFor = (device, kind) => {
    if (device.productName || device.name || device.device?.name) return device.productName || device.name || device.device.name;
    if (kind === 'serial') {
      const info = device.getInfo?.() ?? {};
      const vendor = info.usbVendorId?.toString(16).padStart(4, '0');
      const product = info.usbProductId?.toString(16).padStart(4, '0');
      return vendor ? `Serial device (${vendor}:${product ?? '0000'})` : 'Serial device';
    }
    return kind === 'bluetooth' ? 'Bluetooth device' : kind === 'hid' ? 'HID device' : 'USB device';
  };
  const report = (device, kind, active) => {
    let id = ids.get(device);
    if (!id) { if (!active) return; id = crypto.randomUUID(); ids.set(device, id); }
    if (active) connected.set(id, { device, kind });
    else connected.delete(id);
    bridge.update({ id, kind, name: nameFor(device, kind), connected: active });
  };
  const wrap = (prototype, method, kind, active, sync = false) => {
    const original = prototype?.[method];
    if (typeof original !== 'function') return;
    prototype[method] = sync ? function (...args) {
      const result = original.apply(this, args);
      report(this, kind, active);
      return result;
    } : async function (...args) {
      const result = await original.apply(this, args);
      report(this, kind, active);
      if (kind === 'bluetooth' && active) {
        this.device?.addEventListener('gattserverdisconnected', () => report(this, kind, false), { once: true });
      }
      return result;
    };
  };
  for (const [type, kind] of [['USBDevice', 'usb'], ['HIDDevice', 'hid'], ['SerialPort', 'serial']]) {
    const prototype = window[type]?.prototype;
    wrap(prototype, 'open', kind, true);
    wrap(prototype, 'close', kind, false);
    wrap(prototype, 'forget', kind, false);
  }
  wrap(window.BluetoothRemoteGATTServer?.prototype, 'connect', 'bluetooth', true);
  wrap(window.BluetoothRemoteGATTServer?.prototype, 'disconnect', 'bluetooth', false, true);
  for (const kind of ['usb', 'hid', 'serial']) {
    navigator[kind]?.addEventListener('disconnect', (event) => report(event.device ?? event.port ?? event.target, kind, false));
  }
  Object.defineProperty(window, '__miraDevices', { value: Object.freeze({
    disconnect: async (id) => {
      const entry = connected.get(id);
      if (!entry) return false;
      try {
        if (entry.kind === 'bluetooth') entry.device.disconnect();
        else await entry.device.close();
        return true;
      } catch { return false; }
    },
  }) });
} });

// Consume Ctrl+wheel before Chromium's default page/UI zoom handling.
let zoomWheelDelta = 0;
let lastZoomWheelAt = 0;
window.addEventListener('wheel', (event) => {
  if (!event.ctrlKey || !event.isTrusted || !event.deltaY) return;
  event.preventDefault();
  const now = performance.now();
  const delta = event.deltaY * (event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 120 : 1);
  if (now - lastZoomWheelAt > 200 || Math.sign(zoomWheelDelta) !== Math.sign(delta)) zoomWheelDelta = 0;
  lastZoomWheelAt = now;
  zoomWheelDelta += delta;
  if (Math.abs(zoomWheelDelta) < 40) return;
  ipcRenderer.send('page-zoom-wheel', zoomWheelDelta < 0 ? 'in' : 'out');
  zoomWheelDelta = 0;
}, { capture: true, passive: false });
window.addEventListener('pointerdown', (event) => {
  if (event.isTrusted) ipcRenderer.send('page-zoom-dismiss');
}, { capture: true });
