// The one audio element the whole app drives, wrapped so views render from a
// single published state object.

import * as store from './store.js';
import * as downloads from './downloads.js';

export const PLAYBACK_SPEEDS = [0.5, 0.8, 1, 1.2, 1.5, 1.8, 2, 3];
export const SLEEP_TIMER_PRESETS = [5, 10, 15, 30, 45, 60];

const SAVE_INTERVAL_MS = 5000;

const audio = new Audio();
audio.preload = 'metadata';

let state = {
  episode: null,
  show: null,
  isPlaying: false,
  isBuffering: false,
  positionMs: 0,
  durationMs: 0,
  speed: 1,
  sleepTimerEndsAt: null,
  sleepAtEndOfEpisode: false,
  error: null,
};

const listeners = new Set();
let objectUrl = null;
let sleepTimeout = null;
let lastSaved = 0;

export function getState() {
  return state;
}

export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(patch = {}) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (error) {
      console.error('player listener failed', error);
    }
  });
}

export async function init() {
  const settings = await store.getSettings();
  audio.playbackRate = settings.defaultSpeed;
  publish({ speed: settings.defaultSpeed });
  wireMediaSession();
}

// ---- transport --------------------------------------------------------------

export async function play(episode) {
  if (state.episode?.guid === episode.guid) {
    await audio.play().catch(reportError);
    return;
  }

  const settings = await store.getSettings();
  const show = await store.getPodcast(episode.feedUrl);

  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  const source = await downloads.playbackUrl(episode);
  if (source.startsWith('blob:')) objectUrl = source;

  publish({
    episode,
    show,
    positionMs: episode.positionMs || 0,
    durationMs: episode.durationMs || 0,
    error: null,
    isBuffering: true,
  });

  audio.src = source;
  audio.playbackRate = show?.playbackSpeedOverride || settings.defaultSpeed;

  // Seek only once metadata has landed, or the browser clamps it to zero.
  const resumeAt = episode.positionMs && !episodeFinished(episode) ? episode.positionMs / 1000 : 0;
  if (resumeAt > 0) {
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = resumeAt; }, { once: true });
  }

  await audio.play().catch(reportError);
  updateMediaMetadata();
}

export async function toggle(episode) {
  if (episode && state.episode?.guid !== episode.guid) return play(episode);
  return playPause();
}

export async function playPause() {
  if (!state.episode) return;
  if (audio.paused) {
    await audio.play().catch(reportError);
  } else {
    audio.pause();
  }
}

export function seekTo(positionMs) {
  if (!state.episode) return;
  audio.currentTime = Math.max(0, positionMs / 1000);
  publish({ positionMs: audio.currentTime * 1000 });
}

export async function skipForward() {
  const settings = await store.getSettings();
  seekTo((audio.currentTime + settings.skipForwardSeconds) * 1000);
}

export async function skipBack() {
  const settings = await store.getSettings();
  seekTo(Math.max(0, audio.currentTime - settings.skipBackSeconds) * 1000);
}

export async function setSpeed(speed) {
  const clamped = Math.min(PLAYBACK_SPEEDS.at(-1), Math.max(PLAYBACK_SPEEDS[0], speed));
  audio.playbackRate = clamped;
  publish({ speed: clamped });
  await store.setSetting('defaultSpeed', clamped);
}

// ---- sleep timer ------------------------------------------------------------

export function startSleepTimer(minutes) {
  clearTimeout(sleepTimeout);
  if (minutes === null) {
    publish({ sleepAtEndOfEpisode: true, sleepTimerEndsAt: null });
    return;
  }
  const endsAt = Date.now() + minutes * 60000;
  publish({ sleepTimerEndsAt: endsAt, sleepAtEndOfEpisode: false });
  sleepTimeout = setTimeout(() => {
    audio.pause();
    publish({ sleepTimerEndsAt: null });
  }, minutes * 60000);
}

export function cancelSleepTimer() {
  clearTimeout(sleepTimeout);
  publish({ sleepTimerEndsAt: null, sleepAtEndOfEpisode: false });
}

// ---- audio events -----------------------------------------------------------

// Any of these means audio is actually flowing, so clear a stale error banner.
audio.addEventListener('play', () => publish({ isPlaying: true, isBuffering: false, error: null }));
audio.addEventListener('playing', () => publish({ isPlaying: true, isBuffering: false, error: null }));
audio.addEventListener('waiting', () => publish({ isBuffering: true }));

audio.addEventListener('pause', () => {
  publish({ isPlaying: false });
  persistPosition(true);
});

audio.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audio.duration)) {
    publish({ durationMs: audio.duration * 1000 });
  }
});

audio.addEventListener('timeupdate', () => {
  publish({ positionMs: audio.currentTime * 1000 });
  persistPosition(false);
});

audio.addEventListener('error', () => {
  // Swapping src fires a spurious error as the old load is torn down; only a
  // real MediaError on the current source is worth showing.
  if (!audio.error || !audio.currentSrc) return;
  publish({
    isPlaying: false,
    isBuffering: false,
    error: 'That episode could not be played. The publisher may have moved the file.',
  });
});

audio.addEventListener('ended', async () => {
  const finished = state.episode;
  if (!finished) return;

  await store.markCompleted(finished.guid, true);

  if (state.sleepAtEndOfEpisode) {
    cancelSleepTimer();
    publish({ isPlaying: false });
    return;
  }

  const settings = await store.getSettings();
  if (!settings.autoPlayNext) {
    publish({ isPlaying: false });
    return;
  }

  const next = await store.nextInQueue(finished.guid);
  if (next) {
    await play(next);
  } else {
    publish({ isPlaying: false });
  }
});

function persistPosition(force) {
  const episode = state.episode;
  if (!episode || !audio.currentTime) return;
  const now = Date.now();
  if (!force && now - lastSaved < SAVE_INTERVAL_MS) return;
  lastSaved = now;
  store.savePosition(episode.guid, audio.currentTime * 1000).catch(() => {});
}

function episodeFinished(episode) {
  if (episode.isCompleted) return true;
  if (!episode.durationMs) return false;
  return episode.positionMs / episode.durationMs >= 0.95;
}

function reportError(error) {
  // A new load interrupting the previous play() is normal, not a failure.
  if (error?.name === 'AbortError') return;
  console.warn('playback blocked', error);
  publish({
    isPlaying: false,
    isBuffering: false,
    error: error?.name === 'NotAllowedError'
      ? 'Tap play once to let this browser start audio.'
      : 'That episode could not be played.',
  });
}

// ---- OS integration ---------------------------------------------------------

function wireMediaSession() {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.setActionHandler('play', () => playPause());
  navigator.mediaSession.setActionHandler('pause', () => playPause());
  navigator.mediaSession.setActionHandler('seekbackward', () => skipBack());
  navigator.mediaSession.setActionHandler('seekforward', () => skipForward());
  navigator.mediaSession.setActionHandler('seekto', (details) => {
    if (details.seekTime != null) seekTo(details.seekTime * 1000);
  });
  navigator.mediaSession.setActionHandler('nexttrack', async () => {
    const next = await store.nextInQueue(state.episode?.guid);
    if (next) play(next);
  });
}

function updateMediaMetadata() {
  if (!('mediaSession' in navigator) || !state.episode) return;
  const artwork = state.episode.imageUrl
    ? [{ src: state.episode.imageUrl, sizes: '512x512', type: 'image/jpeg' }]
    : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: state.episode.title,
    artist: state.show?.title || '',
    album: state.show?.title || '',
    artwork,
  });
}
