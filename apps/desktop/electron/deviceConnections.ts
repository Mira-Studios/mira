import { app, BrowserWindow, ipcMain, session, webContents, type WebContents, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';

type Kind = 'usb' | 'hid' | 'serial' | 'bluetooth';
type Device = { id: string; name: string; kind: Kind };
type Request = {
  id: string; kind: Kind; site: string; devices: Device[];
  pairing?: { kind: string; pin?: string };
};
type State = { source: WebContents; request?: Request; select?: (id: string, pin?: string) => void; connected: Map<string, Device> };
const states = new Map<number, State>();
let resolveHost: (source: WebContents) => BrowserWindow | null;

function hostFor(source: WebContents): BrowserWindow | null {
  let host = resolveHost(source);
  while (host?.getParentWindow()) host = host.getParentWindow();
  return host;
}
function stateFor(source: WebContents): State {
  let state = states.get(source.id);
  if (!state) { state = { source, connected: new Map() }; states.set(source.id, state); }
  return state;
}
function snapshot(hostId: number) {
  return [...states.values()].filter((state) => !state.source.isDestroyed() && hostFor(state.source)?.id === hostId)
    .map((state) => ({ webContentsId: state.source.id, request: state.request, connected: [...state.connected.values()] }));
}
function publish(source: WebContents): void {
  if (source.isDestroyed()) return;
  const host = hostFor(source);
  if (host && !host.isDestroyed()) host.webContents.send('device-connections-changed', snapshot(host.id));
}
function cancel(state: State): void {
  const callback = state.select;
  state.select = undefined; state.request = undefined;
  try { callback?.(''); } catch { /* Requesting frame was destroyed. */ }
}
function request(source: WebContents | undefined, kind: Kind, devices: Device[], callback: State['select'], pairing?: Request['pairing']): void {
  if (!source || source.isDestroyed() || !hostFor(source)) { callback?.(''); return; }
  const state = stateFor(source);
  // Bluetooth discovery emits repeated lists for the same outstanding chooser.
  if (kind === 'bluetooth' && state.request?.kind === kind && !state.request.pairing && !pairing) {
    state.request.devices = devices; state.select = callback; publish(source); return;
  }
  cancel(state);
  let site = 'This site';
  try { site = new URL(source.getURL()).hostname || site; } catch { /* Local page. */ }
  state.request = { id: randomUUID(), kind, site, devices, pairing };
  state.select = callback;
  publish(source);
}
function fromFrame(frame: WebFrameMain | null): WebContents | undefined {
  return frame && !frame.detached ? webContents.fromFrame(frame) : undefined;
}
function updateList(source: WebContents | undefined, kind: Kind, device: Device, remove = false): void {
  if (!source) return;
  const state = states.get(source.id);
  if (state?.request?.kind !== kind || state.request.pairing) return;
  state.request.devices = state.request.devices.filter((item) => item.id !== device.id);
  if (!remove) state.request.devices.push(device);
  publish(source);
}
const usbDevice = (device: Electron.USBDevice): Device => ({ id: device.deviceId, name: device.productName || device.manufacturerName || 'USB device', kind: 'usb' });
const hidDevice = (device: Electron.HIDDevice): Device => ({ id: device.deviceId, name: device.name || 'HID device', kind: 'hid' });
const serialDevice = (device: Electron.SerialPort): Device => ({ id: device.portId, name: device.displayName ? `${device.displayName} (${device.portName})` : device.portName, kind: 'serial' });

export function setupDeviceConnections(getHost: typeof resolveHost): void {
  resolveHost = getHost;
  const ses = session.defaultSession;
  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault(); request(fromFrame(details.frame), 'usb', details.deviceList.map(usbDevice), (id) => callback(id || undefined));
  });
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault(); request(fromFrame(details.frame), 'hid', details.deviceList.map(hidDevice), (id) => callback(id || undefined));
  });
  ses.on('select-serial-port', (event, ports, source, callback) => {
    event.preventDefault(); request(source, 'serial', ports.map(serialDevice), (id) => callback(id));
  });
  ses.on('usb-device-added', (_event, device, source) => updateList(source, 'usb', usbDevice(device)));
  ses.on('usb-device-removed', (_event, device, source) => updateList(source, 'usb', usbDevice(device), true));
  ses.on('hid-device-added', (_event, details) => updateList(fromFrame(details.frame), 'hid', hidDevice(details.device)));
  ses.on('hid-device-removed', (_event, details) => updateList(fromFrame(details.frame), 'hid', hidDevice(details.device), true));
  ses.on('serial-port-added', (_event, port, source) => updateList(source, 'serial', serialDevice(port)));
  ses.on('serial-port-removed', (_event, port, source) => updateList(source, 'serial', serialDevice(port), true));
  ses.setBluetoothPairingHandler((details, callback) => {
    request(fromFrame(details.frame), 'bluetooth', [{ id: details.deviceId, name: 'Bluetooth device', kind: 'bluetooth' }],
      (id, pin) => callback({ confirmed: !!id, pin }), { kind: details.pairingKind, pin: details.pin });
  });
  app.on('web-contents-created', (_event, source) => {
    source.on('select-bluetooth-device', (event, devices, callback) => {
      event.preventDefault(); request(source, 'bluetooth', devices.map((device) => ({ id: device.deviceId, name: device.deviceName || 'Bluetooth device', kind: 'bluetooth' })), (id) => callback(id));
    });
    const clear = () => {
      const state = states.get(source.id);
      if (!state) return;
      cancel(state); state.connected.clear(); publish(source);
    };
    source.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return;
      const state = states.get(source.id);
      if (state?.request) { cancel(state); publish(source); }
    });
    // A cancelled navigation leaves the document and its connections alive.
    source.on('did-navigate', clear);
    source.on('render-process-gone', clear);
    source.once('destroyed', () => {
      const state = states.get(source.id);
      if (state) cancel(state);
      states.delete(source.id);
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('device-connections-changed', snapshot(win.id));
      }
    });
  });
  ipcMain.handle('device-connections-state', (event) => {
    const host = BrowserWindow.fromWebContents(event.sender);
    return host ? snapshot(host.id) : [];
  });
  ipcMain.handle('device-chooser-respond', (event, data: unknown) => {
    if (!data || typeof data !== 'object') return false;
    const payload = data as Record<string, unknown>;
    const state = [...states.values()].find((item) => item.request?.id === payload.requestId);
    if (!state || hostFor(state.source)?.webContents.id !== event.sender.id) return false;
    const device = state.request?.devices.find((item) => item.id === payload.deviceId);
    if (payload.deviceId && !device) return false;
    if (device && state.request?.pairing?.kind === 'providePin' && (typeof payload.pin !== 'string' || !payload.pin.trim())) return false;
    const callback = state.select;
    state.select = undefined; state.request = undefined;
    callback?.(device?.id ?? '', typeof payload.pin === 'string' ? payload.pin.slice(0, 32) : undefined);
    publish(state.source);
    return true;
  });
  ipcMain.on('device-connection-update', (event, data: unknown) => {
    if (!data || typeof data !== 'object' || !hostFor(event.sender)) return;
    const value = data as Record<string, unknown>;
    if (typeof value.id !== 'string' || value.id.length > 100 || !['usb', 'hid', 'serial', 'bluetooth'].includes(String(value.kind))) return;
    const state = stateFor(event.sender);
    if (value.connected === true && state.connected.size < 100) {
      state.connected.set(value.id, { id: value.id, kind: value.kind as Kind, name: typeof value.name === 'string' ? value.name.slice(0, 200) : 'Device' });
    } else state.connected.delete(value.id);
    publish(event.sender);
  });
  ipcMain.handle('device-disconnect', async (event, payload: { webContentsId?: number; deviceId?: string }) => {
    const state = states.get(payload?.webContentsId ?? -1);
    if (!state || hostFor(state.source)?.webContents.id !== event.sender.id || !state.connected.has(payload?.deviceId ?? '')) return false;
    return state.source.executeJavaScript(`window.__miraDevices?.disconnect(${JSON.stringify(payload.deviceId)})`).catch(() => false);
  });
}
