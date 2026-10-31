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
