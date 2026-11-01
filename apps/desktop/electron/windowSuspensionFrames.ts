import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session, WebContents } from 'electron';
import activity from './windowSuspensionActivity.cjs';

const trackedSessions = new WeakSet<Session>();
const trackedContents = new WeakSet<WebContents>();
const installer = `(${activity.installSuspensionActivity.toString()})()`;

export function setupWindowSuspensionFrames(contents: WebContents): void {
  if (trackedContents.has(contents)) return;
  trackedContents.add(contents);
  const ses = contents.session;
  if (!trackedSessions.has(ses)) {
    ses.registerPreloadScript({
      type: 'frame',
      filePath: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'windowSuspensionActivity.cjs',
      ),
    });
    trackedSessions.add(ses);
  }
  contents.on('frame-created', (_event, { frame }) => {
    if (!frame || frame.detached) return;
    // Chromium skips preloads in initial about:blank documents. Install there
    // too, instead of letting an empty helper iframe veto an otherwise idle tab.
    void frame.executeJavaScript(installer).catch(() => undefined);
  });
}
