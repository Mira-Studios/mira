import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX, X, PictureInPicture2 } from 'lucide-react';
import { electron } from '../electronBridge';
import { applyTheme } from '../features/themes/applyTheme';
import { getThemeById } from '../features/themes/themeLoader';
import type { PipVideo, PipMode } from '../../electron/pictureInPicturePolicy';
import './PictureInPicture.css';
type State = PipVideo & { mode: PipMode; themeId?: string };
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export default function PictureInPicture() {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const command = (action: string, value?: unknown) =>
    electron?.ipcRenderer.send('pip-command', { action, value });
  useEffect(() => {
    const ipc = electron?.ipcRenderer;
    if (!ipc) return;
    const element = video.current;
    let connection: RTCPeerConnection | null = null;
    let token: string | null = null;
    let ice: RTCIceCandidateInit[] = [];
    let disposed = false;
    const start = (_event: unknown, request: { token: string }) => {
      connection?.close();
      token = request.token;
      ice = [];
      const peer = new RTCPeerConnection({ iceServers: [] });
      connection = peer;
      peer.onicecandidate = (event) => {
        if (event.candidate)
          ipc.send('pip-signal', { token, data: { candidate: event.candidate.toJSON() } });
      };
      peer.ontrack = (event) => {
        if (!video.current || disposed) return;
        video.current.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void video.current.play().catch(() => undefined);
      };
      peer.onconnectionstatechange = () => {
        if (!disposed && peer.connectionState === 'failed')
          setError('The video connection was interrupted.');
      };
    };
    const signal = async (
      _event: unknown,
      request: {
        token: string;
        data: {
          description?: RTCSessionDescriptionInit;
          candidate?: RTCIceCandidateInit;
          error?: string;
        };
      },
    ) => {
      if (!connection || request.token !== token) return;
      const peer = connection;
      try {
        if (request.data.error) {
          setError(request.data.error);
          return;
        }
        if (request.data.description) {
          await peer.setRemoteDescription(request.data.description);
          for (const candidate of ice) await peer.addIceCandidate(candidate);
          ice = [];
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          ipc.send('pip-signal', { token, data: { description: peer.localDescription?.toJSON() } });
        } else if (request.data.candidate) {
          if (peer.remoteDescription) await peer.addIceCandidate(request.data.candidate);
          else ice.push(request.data.candidate);
        }
      } catch {
        if (!disposed && peer.connectionState !== 'closed')
          setError('This video cannot be shown in picture in picture.');
      }
    };
    const update = (_event: unknown, value: State) => {
      setState(value);
      if (value.themeId) applyTheme(getThemeById(value.themeId));
    };
    ipc.on('pip-start', start);
    ipc.on('pip-signal', signal);
    ipc.on('pip-state', update);
    ipc.send('pip-ready');
    return () => {
      disposed = true;
      connection?.close();
      if (element) element.srcObject = null;
      ipc.off('pip-start', start);
      ipc.off('pip-signal', signal);
      ipc.off('pip-state', update);
    };
  }, []);
  return (
    <main
      className="pip-player"
      data-mode={state?.mode}
      data-ready={ready}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        if (event.code === 'Space') {
          event.preventDefault();
          command(state?.playing ? 'pause' : 'play');
        }
        if (event.key === 'ArrowLeft') command('seek', Math.max(0, (state?.currentTime ?? 0) - 10));
        if (event.key === 'ArrowRight') command('seek', (state?.currentTime ?? 0) + 10);
        if (event.key.toLowerCase() === 'm') command('mute', !state?.muted);
        if (event.key === 'Escape') command('close');
      }}
    >
      <header className="pip-titlebar">
        <button
          type="button"
          className="theme-btn theme-btn-nav"
          aria-label="Return to tab"
          title="Return to tab"
          onClick={() => command('return')}
        >
          <PictureInPicture2 size={15} />
        </button>
        <button
          type="button"
          className="theme-btn theme-btn-nav"
          aria-label="Close picture in picture"
          title="Close"
          onClick={() => command('close')}
        >
          <X size={16} />
        </button>
      </header>
      <div className="pip-video">
        <video ref={video} autoPlay muted playsInline onLoadedData={() => setReady(true)} />
        {(!ready || error) && (
          <div className="pip-message" role={error ? 'status' : undefined}>
            {error || 'Loading video…'}
          </div>
        )}
      </div>
      <footer className="pip-controls">
        <input
          type="range"
          className="pip-seek"
          aria-label="Video position"
          min={0}
          max={state?.duration || 1}
          step={0.1}
          value={Math.min(state?.currentTime ?? 0, state?.duration || 1)}
          disabled={!state?.duration}
          onChange={(event) => command('seek', Number(event.target.value))}
        />
        <div className="pip-buttons">
          <button
            type="button"
            className="theme-btn theme-btn-nav"
            aria-label={state?.playing ? 'Pause' : 'Play'}
            onClick={() => command(state?.playing ? 'pause' : 'play')}
          >
            {state?.playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <span className="pip-time">
            {time(state?.currentTime ?? 0)}
            {state?.duration ? ` / ${time(state.duration)}` : ''}
          </span>
          <button
            type="button"
            className="theme-btn theme-btn-nav"
            aria-label={state?.muted ? 'Unmute video' : 'Mute video'}
            onClick={() => command('mute', !state?.muted)}
          >
            {state?.muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
          </button>
          <input
            type="range"
            className="pip-volume"
            aria-label="Video volume"
            min={0}
            max={1}
            step={0.05}
            value={state?.volume ?? 1}
            onChange={(event) => command('volume', Number(event.target.value))}
          />
        </div>
      </footer>
    </main>
  );
}
