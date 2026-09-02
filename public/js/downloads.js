// Offline episodes live in the Cache API. The audio has to come through the
// proxy: a cross-origin fetch of the publisher's file would be blocked, and a
// cached opaque response cannot be read back or measured.

import * as db from './db.js';
import * as store from './store.js';
import { audioProxyUrl } from './api.js';

const CACHE_NAME = 'episode-audio-v1';

async function cache() {
  return caches.open(CACHE_NAME);
}

async function setState(guid, downloadState, fileSizeBytes) {
  await db.update('episodes', guid, (episode) => ({
    ...episode,
    downloadState,
    ...(fileSizeBytes === undefined ? {} : { fileSizeBytes }),
  }));
  store.notify('downloads');
}

export async function download(guid) {
  const episode = await store.getEpisode(guid);
  if (!episode) throw new Error('Unknown episode');

  await setState(guid, 'DOWNLOADING');
  try {
    const request = audioProxyUrl(episode.audioUrl);
    const response = await fetch(request);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);

    const blob = await response.blob();
    const store_ = await cache();
    await store_.put(
      cacheKey(episode),
      new Response(blob, {
        headers: {
          'Content-Type': blob.type || 'audio/mpeg',
          'Content-Length': String(blob.size),
        },
      }),
    );
    await setState(guid, 'DOWNLOADED', blob.size);
    return blob.size;
  } catch (error) {
    await setState(guid, 'FAILED', 0);
    throw error;
  }
}

export async function remove(guid) {
  const episode = await store.getEpisode(guid);
  if (!episode) return;
  const store_ = await cache();
  await store_.delete(cacheKey(episode));
  await setState(guid, 'NOT_DOWNLOADED', 0);
}

export async function removeAll() {
  await caches.delete(CACHE_NAME);
  const downloaded = await store.downloads();
  await Promise.all(downloaded.map((episode) => setState(episode.guid, 'NOT_DOWNLOADED', 0)));
}

/** Downloaded episodes play from cache; everything else streams from source. */
export async function playbackUrl(episode) {
  if (episode.downloadState !== 'DOWNLOADED') return episode.audioUrl;
  const store_ = await cache();
  const hit = await store_.match(cacheKey(episode));
  if (!hit) {
    // The cache was evicted under storage pressure; fall back to streaming.
    await setState(episode.guid, 'NOT_DOWNLOADED', 0);
    return episode.audioUrl;
  }
  return URL.createObjectURL(await hit.blob());
}

export async function usedBytes() {
  const downloaded = await store.downloads();
  return downloaded.reduce((total, episode) => total + (episode.fileSizeBytes || 0), 0);
}

/** Applies the "remove when played" and "remove after N days" rules. */
export async function applyRetentionRules() {
  const settings = await store.getSettings();
  const cutoff = settings.removeDownloadAfterDays
    ? Date.now() - settings.removeDownloadAfterDays * 86400000
    : 0;

  const downloaded = await store.downloads();
  const expired = downloaded.filter(
    (episode) =>
      (settings.removeDownloadWhenPlayed && episode.isCompleted) ||
      (cutoff && episode.publishedAt < cutoff),
  );
  await Promise.all(expired.map((episode) => remove(episode.guid)));
  return expired.length;
}

function cacheKey(episode) {
  return audioProxyUrl(episode.audioUrl);
}
