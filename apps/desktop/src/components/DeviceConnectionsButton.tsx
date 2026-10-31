import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bluetooth, Check, MonitorSmartphone, Unplug, Usb, X } from 'lucide-react';
import { electron } from '../electronBridge';
import { useTabs } from '../features/tabs/TabsProvider';
import './DeviceConnectionsButton.css';

type Kind = 'usb' | 'hid' | 'serial' | 'bluetooth';
type Device = { id: string; name: string; kind: Kind };
type DeviceRequest = {
  id: string;
  kind: Kind;
  site: string;
  devices: Device[];
  pairing?: { kind: string; pin?: string };
};
type DeviceState = { webContentsId: number; request?: DeviceRequest; connected: Device[] };
const EMPTY_DEVICES: Device[] = [];
type ClosingView = {
  request?: DeviceRequest;
  connected: Device[];
  selectedId: string;
  pin: string;
  error: string;
};
const kindLabels = { usb: 'USB', hid: 'HID', serial: 'Serial', bluetooth: 'Bluetooth' };

export default function DeviceConnectionsButton({
  animationsEnabled,
  onOpen,
  otherMenuOpen,
}: {
  animationsEnabled: boolean;
  onOpen: () => void;
  otherMenuOpen: boolean;
}) {
  const { activeId, getWebContentsIdForTab } = useTabs();
  const [states, setStates] = useState<DeviceState[]>([]);
  const [open, setOpen] = useState(false);
  const [closingView, setClosingView] = useState<ClosingView | null>(null);
  const [menuMaxHeight, setMenuMaxHeight] = useState(420);
  const [selection, setSelection] = useState({ requestId: '', deviceId: '' });
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const slot = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLElement>(null);
  const seenRequest = useRef('');
  const closeTimer = useRef<number | null>(null);
  const sourceId = getWebContentsIdForTab(activeId);
  const current = states.find((state) => state.webContentsId === sourceId);
  const request = current?.request;
  const connected = current?.connected ?? EMPTY_DEVICES;
  const menuVisible = open || !!closingView;
  const visible = menuVisible || !!request || connected.length > 0;
  const selectedId = request?.pairing
    ? (request.devices[0]?.id ?? '')
    : selection.requestId === request?.id &&
        request?.devices.some((device) => device.id === selection.deviceId)
      ? selection.deviceId
      : '';

  const clearCloseTimer = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const show = useCallback(() => {
    clearCloseTimer();
    setClosingView(null);
    onOpen();
    setOpen(true);
  }, [clearCloseTimer, onOpen]);

  const finishClosing = useCallback(() => {
    clearCloseTimer();
    setClosingView(null);
  }, [clearCloseTimer]);

  const close = useCallback(() => {
    if (!open) return;
    clearCloseTimer();
    setOpen(false);
    if (animationsEnabled && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Cancellation arrives immediately; keep the displayed content until it fades out.
      setClosingView({ request, connected, selectedId, pin, error });
      closeTimer.current = window.setTimeout(finishClosing, 250);
    } else setClosingView(null);
    if (request)
      void electron?.ipcRenderer
        .invoke('device-chooser-respond', { requestId: request.id })
        .catch(() => undefined);
    setError('');
  }, [
    open,
    animationsEnabled,
    request,
    connected,
    selectedId,
    pin,
    error,
    clearCloseTimer,
    finishClosing,
  ]);

  useEffect(() => {
    if (!animationsEnabled) finishClosing();
  }, [animationsEnabled, finishClosing]);

  useLayoutEffect(() => {
    if (!menuVisible) return;
    const measure = () => {
      const bottom = slot.current?.getBoundingClientRect().bottom ?? 100;
      setMenuMaxHeight(Math.max(0, Math.min(420, window.innerHeight - bottom - 20)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [menuVisible]);

  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    let live = true;
    let received = false;
    const apply = (next: DeviceState[]) => {
      if (!live || !Array.isArray(next)) return;
      setStates(next);
      const pending = next.find(
        (state) => state.webContentsId === getWebContentsIdForTab(activeId),
      )?.request;
      if (pending && seenRequest.current !== pending.id) {
        seenRequest.current = pending.id;
        show();
        setError('');
        setPin('');
      }
    };
    const receive = (_event: unknown, next: unknown) => {
      received = true;
      apply(next as DeviceState[]);
    };
    ipc.on('device-connections-changed', receive);
    void ipc
      .invoke<DeviceState[]>('device-connections-state')
      .then((next) => {
        if (!received) apply(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      ipc.off('device-connections-changed', receive);
    };
  }, [activeId, getWebContentsIdForTab, show]);

  useEffect(() => {
    if (!open) return;
    (
      menu.current?.querySelector<HTMLElement>('input') ??
      menu.current?.querySelector<HTMLElement>('button')
    )?.focus();
  }, [open, request?.id]);

  useEffect(() => {
    if (otherMenuOpen && open) close();
  }, [otherMenuOpen, open, close]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (slot.current?.contains(event.target as Node)) return;
      close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    // Guest webview clicks move focus out of the browser shell rather than bubbling here.
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', close);
    };
  }, [open, close]);

  const connect = async () => {
    if (!request || !selectedId) return;
    const ok = await electron?.ipcRenderer
      .invoke<boolean>('device-chooser-respond', {
        requestId: request.id,
        deviceId: selectedId,
        pin,
      })
      .catch(() => false);
    if (!ok) setError('Could not select this device.');
  };
  const disconnect = async (device: Device) => {
    const ok = await electron?.ipcRenderer
      .invoke<boolean>('device-disconnect', { webContentsId: sourceId, deviceId: device.id })
      .catch(() => false);
    setError(ok ? '' : 'Device is busy. Close its connection on the site.');
  };
  const displayed = closingView ?? { request, connected, selectedId, pin, error };
  const displayedRequest = displayed.request;
  return (
    <div
      ref={slot}
      className={`device-connection-slot ${visible ? 'device-connection-slot-visible' : ''}`}
      data-animate={animationsEnabled}
      aria-hidden={!visible}
    >
      <button
        type="button"
        className={`theme-btn theme-btn-nav nav-icon-btn device-connection-trigger ${open ? 'device-connection-trigger-open' : ''}`}
        title="Device connections"
        aria-label="Device connections"
        aria-haspopup="dialog"
        aria-expanded={open}
        tabIndex={visible ? 0 : -1}
        disabled={!visible}
        onClick={(event) => {
          event.stopPropagation();
          if (open) close();
          else show();
        }}
      >
        <MonitorSmartphone size={16} strokeWidth={1.9} aria-hidden="true" />
        {connected.length > 0 && <span className="device-connection-dot" />}
      </button>
      {menuVisible && (
        <section
          ref={menu}
          className={`theme-panel device-connection-menu ${closingView ? 'device-connection-menu-closing' : ''}`}
          style={{ maxHeight: menuMaxHeight }}
          role="dialog"
          aria-label="Device connections"
          inert={!open}
          aria-hidden={!open}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === 'device-menu-out')
              finishClosing();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="device-connection-header">
            <strong>
              {displayedRequest?.pairing
                ? 'Pair device'
                : displayedRequest
                  ? 'Connect a device'
                  : 'Device connections'}
            </strong>
            <button
              type="button"
              className="device-connection-close"
              aria-label="Close device connections"
              onClick={close}
            >
              <X size={16} />
            </button>
          </div>
          <div className="device-connection-body">
            {displayedRequest && (
              <>
                <p className="device-connection-site">
                  {displayedRequest.site} · {kindLabels[displayedRequest.kind]}
                </p>
                {displayedRequest.pairing ? (
                  <div className="device-connection-pairing">
                    {displayedRequest.pairing.kind === 'confirmPin' && (
                      <p>
                        Confirm code <strong>{displayedRequest.pairing.pin}</strong>
                      </p>
                    )}
                    {displayedRequest.pairing.kind === 'providePin' && (
                      <input
                        className="theme-input"
                        aria-label="Pairing code"
                        placeholder="Pairing code"
                        value={displayed.pin}
                        onChange={(event) => setPin(event.target.value)}
                        maxLength={32}
                      />
                    )}
                    {displayedRequest.pairing.kind === 'confirm' && <p>Allow Bluetooth pairing?</p>}
                  </div>
                ) : (
                  <div
                    className="device-connection-list"
                    role="radiogroup"
                    aria-label="Available devices"
                  >
                    {displayedRequest.devices.length ? (
                      displayedRequest.devices.map((device) => {
                        const Icon = device.kind === 'bluetooth' ? Bluetooth : Usb;
                        const selected = displayed.selectedId === device.id;
                        return (
                          <label
                            key={device.id}
                            className={`device-connection-option ${selected ? 'device-connection-option-selected' : ''}`}
                          >
                            <input
                              type="radio"
                              name={`device-${displayedRequest.id}`}
                              checked={selected}
                              onChange={() =>
                                setSelection({
                                  requestId: displayedRequest.id,
                                  deviceId: device.id,
                                })
                              }
                            />
                            <Icon size={17} aria-hidden="true" />
                            <span>{device.name}</span>
                            {selected && <Check size={16} aria-hidden="true" />}
                          </label>
                        );
                      })
                    ) : (
                      <p className="device-connection-empty">
                        {displayedRequest.kind === 'bluetooth'
                          ? 'Searching for devices…'
                          : 'No matching devices found.'}
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
            {displayed.connected.length > 0 && (
              <div className="device-connected-list">
                <span className="device-connection-caption">Connected</span>
                {displayed.connected.map((device) => (
                  <div key={device.id} className="device-connected-row">
                    {device.kind === 'bluetooth' ? (
                      <Bluetooth size={17} aria-hidden="true" />
                    ) : (
                      <Usb size={17} aria-hidden="true" />
                    )}
                    <span>
                      <strong>{device.name}</strong>
                      <small>{kindLabels[device.kind]}</small>
                    </span>
                    <button
                      type="button"
                      className="theme-btn theme-btn-nav"
                      title={`Disconnect ${device.name}`}
                      aria-label={`Disconnect ${device.name}`}
                      onClick={() => {
                        void disconnect(device);
                      }}
                    >
                      <Unplug size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!displayedRequest && !displayed.connected.length && (
              <p className="device-connection-empty">No devices connected.</p>
            )}
            {displayed.error && (
              <p className="device-connection-error" role="status">
                {displayed.error}
              </p>
            )}
          </div>
          {displayedRequest && (
            <div className="device-connection-actions">
              <button type="button" className="theme-btn theme-btn-nav" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="theme-btn theme-btn-go"
                disabled={
                  !displayed.selectedId ||
                  (displayedRequest.pairing?.kind === 'providePin' && !displayed.pin.trim())
                }
                onClick={() => {
                  void connect();
                }}
              >
                Connect
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
