import type { WebContents } from 'electron';

export function hasWindowDownloads(
  windowId: number,
  downloadIds: Iterable<string>,
  owners: ReadonlyMap<string, number>,
): boolean {
  // Unknown ownership protects every window; paused downloads are still resumable work.
  return [...downloadIds].some((id) => !owners.has(id) || owners.get(id) === windowId);
}

export const SUSPENSION_ACTIVITY_CHECK = `(() => {
  // Missing instrumentation (including an unobserved subframe) means we cannot prove it is idle.
  return window.__miraSuspensionActivity?.isBusy() === false;
})()`;

/** Check every live frame, with a deadline. Unload probes never navigate or present dialogs. */
export async function areWindowContentsIdle(
  contents: WebContents[],
  shell?: WebContents,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all([
        shell
          ? shell.executeJavaScript(
              '!document.querySelector(\'[data-mira-prevent-suspension="true"]\')',
            )
          : true,
        ...contents.map(async (content) => {
          if (
            content.isDestroyed() ||
            content.isCrashed() ||
            content.isLoading() ||
            content.isCurrentlyAudible() ||
            content.isBeingCaptured() ||
            content.isDevToolsOpened()
          )
            return false;
          const frames = content.mainFrame.framesInSubtree.filter((frame) => !frame.detached);
          if (!frames.length) return false;
          const idle = await Promise.all(
            frames.map((frame) => frame.executeJavaScript(SUSPENSION_ACTIVITY_CHECK)),
          );
          return idle.every((result) => result === true);
        }),
      ]).then((results) => results.every((result) => result === true)),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
