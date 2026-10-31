// This function is injected into the page's main world; keep it self-contained.
export function installYoutubeAdBeta(enabled) {
  window.__miraYoutubeAdBeta?.stop();
  delete window.__miraYoutubeAdBeta;
  if (!enabled || window !== window.top || !(location.hostname === 'youtube.com' || location.hostname.endsWith('.youtube.com'))) return;

  let observer;
  let scheduled = 0;
  const soughtMedia = new WeakMap();
  const clickedSkipButtons = new WeakSet();
  const stats = { seekAttempts: 0, skipClicks: 0 };
  const check = () => {
    scheduled = 0;
    const player = document.querySelector('#movie_player.html5-video-player, .html5-video-player');
    if (!player?.classList.contains('ad-showing') || !player.classList.contains('ad-interrupting')) return;
    // Use the skip control when available, otherwise end only the media currently
    // marked as an interrupting ad. Never run the page's unload handlers.
    const skip = player.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button');
    if (skip && !skip.disabled && skip.getAttribute('aria-disabled') !== 'true' && skip.getClientRects().length && !clickedSkipButtons.has(skip)) {
      clickedSkipButtons.add(skip);
      stats.skipClicks++;
      skip.click();
      return;
    }
    const media = player.querySelector('video');
    if (!media || media.readyState < 2 || !Number.isFinite(media.duration) || media.duration <= 0) return;
    // Let the ad player finish starting before moving its playback position.
    if (media.paused || media.seeking || media.currentTime < 0.05) return;
    const source = media.currentSrc || media.src;
    if (!source) return;
    const signature = `${source}:${media.duration}`;
    if (soughtMedia.get(media) === signature || media.currentTime >= media.duration - 0.05) return;
    // Recheck immediately before seeking so a switch to the real video is safe.
    if (!player.classList.contains('ad-showing') || !player.classList.contains('ad-interrupting') || player.querySelector('video') !== media) return;
    soughtMedia.set(media, signature);
    try {
      media.currentTime = Math.max(0, media.duration - 0.1);
      stats.seekAttempts++;
    } catch { /* Leave playback alone if this stream cannot be seeked. */ }
  };
  const schedule = () => {
    if (!scheduled) scheduled = requestAnimationFrame(check);
  };
  const stop = () => {
    observer?.disconnect();
    if (scheduled) cancelAnimationFrame(scheduled);
    document.removeEventListener('yt-navigate-finish', schedule);
    document.removeEventListener('loadedmetadata', schedule, true);
    document.removeEventListener('durationchange', schedule, true);
    document.removeEventListener('loadeddata', schedule, true);
    document.removeEventListener('canplay', schedule, true);
    document.removeEventListener('playing', schedule, true);
    document.removeEventListener('timeupdate', schedule, true);
    window.removeEventListener('popstate', schedule);
    window.removeEventListener('pagehide', stop);
  };
  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('yt-navigate-finish', schedule);
  document.addEventListener('loadedmetadata', schedule, true);
  document.addEventListener('durationchange', schedule, true);
  document.addEventListener('loadeddata', schedule, true);
  document.addEventListener('canplay', schedule, true);
  document.addEventListener('playing', schedule, true);
  document.addEventListener('timeupdate', schedule, true);
  window.addEventListener('popstate', schedule);
  window.addEventListener('pagehide', stop, { once: true });
  window.__miraYoutubeAdBeta = { stop, stats };
  schedule();
}
