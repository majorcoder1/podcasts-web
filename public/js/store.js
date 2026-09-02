// Repository layer over IndexedDB, plus settings and a small change bus so
// views can re-render without a framework.

import * as db from './db.js';
import * as api from './api.js';
import { parseFeed, effectivelyFinished } from './feed.js';

const NEW_WINDOW_MS = 14 * 86400000;
const STALE_MS = 3600000;

const listeners = new Set();

export function subscribeToChanges(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notify(reason = 'data') {
  listeners.forEach((listener) => {
    try {
      listener(reason);
    } catch (error) {
      console.error('listener failed', error);
    }
  });
}

// ---- settings ---------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  defaultSpeed: 1,
  skipForwardSeconds: 30,
  skipBackSeconds: 10,
  autoPlayNext: true,
  autoDownloadEnabled: false,
  autoDownloadLimitPerShow: 3,
  removeDownloadWhenPlayed: true,
  removeDownloadAfterDays: 0,
  refreshIntervalHours: 6,
  notifyNewEpisodes: false,
  theme: 'system',
};

let cachedSettings = null;

export async function getSettings() {
  if (cachedSettings) return cachedSettings;
  const stored = (await db.get('settings', 'app')) || {};
  cachedSettings = { ...DEFAULT_SETTINGS, ...stored };
  return cachedSettings;
}

export async function setSetting(key, value) {
  const settings = await getSettings();
  cachedSettings = { ...settings, [key]: value };
  await db.put('settings', cachedSettings, 'app');
  notify('settings');
  return cachedSettings;
}

// ---- podcasts ---------------------------------------------------------------

export function getPodcast(feedUrl) {
  return db.get('podcasts', feedUrl);
}

export async function subscriptions() {
  const all = await db.getAll('podcasts');
  return all
    .filter((podcast) => podcast.isSubscribed)
    .sort((a, b) => (b.subscribedAt || 0) - (a.subscribedAt || 0));
}

export async function subscribe(feedUrl) {
  let podcast = await getPodcast(feedUrl);
  if (!podcast) {
    await refresh(feedUrl);
    podcast = await getPodcast(feedUrl);
  }
  if (!podcast) throw new Error('Could not load that feed');
  await db.put('podcasts', { ...podcast, isSubscribed: true, subscribedAt: Date.now() });
  notify('subscriptions');
}

export async function unsubscribe(feedUrl) {
  await db.update('podcasts', feedUrl, (podcast) => ({ ...podcast, isSubscribed: false }));
  notify('subscriptions');
}

export async function setPodcastFlag(feedUrl, key, value) {
  await db.update('podcasts', feedUrl, (podcast) => ({ ...podcast, [key]: value }));
  notify('subscriptions');
}

/**
 * Pull the feed and merge. Episode rows already stored keep their playback and
 * download state - only publisher-owned metadata is refreshed - so a show
 * rewriting its feed can never wipe where you were.
 */
export async function refresh(feedUrl) {
  const xml = await api.fetchFeed(feedUrl);
  const { podcast, episodes } = parseFeed(feedUrl, xml);

  const existing = await getPodcast(feedUrl);
  await db.put('podcasts', {
    ...podcast,
    isSubscribed: existing?.isSubscribed ?? false,
    subscribedAt: existing?.subscribedAt ?? 0,
    autoDownload: existing?.autoDownload ?? false,
    notifyNewEpisodes: existing?.notifyNewEpisodes ?? true,
    lastRefreshed: Date.now(),
  });

  const stored = await db.getAllByIndex('episodes', 'feedUrl', feedUrl);
  const byGuid = new Map(stored.map((episode) => [episode.guid, episode]));

  const merged = [];
  const fresh = [];
  episodes.forEach((episode) => {
    const previous = byGuid.get(episode.guid);
    if (previous) {
      merged.push({
        ...previous,
        title: episode.title,
        description: episode.description,
        audioUrl: episode.audioUrl,
        imageUrl: episode.imageUrl,
        publishedAt: episode.publishedAt,
        durationMs: episode.durationMs || previous.durationMs,
      });
    } else {
      merged.push({ ...episode, addedAt: Date.now() });
      fresh.push(episode);
    }
  });

  await db.putMany('episodes', merged);
  notify('episodes');
  return fresh;
}

/** Loads a show tapped in Explore without subscribing to it. */
export async function loadPreview(feedUrl) {
  const cached = await getPodcast(feedUrl);
  if (cached && Date.now() - (cached.lastRefreshed || 0) < STALE_MS) return cached;
  await refresh(feedUrl);
  return getPodcast(feedUrl);
}

export async function refreshAllSubscriptions() {
  const shows = await subscriptions();
  const settled = await Promise.allSettled(shows.map((show) => refresh(show.feedUrl)));
  return settled
    .filter((outcome) => outcome.status === 'fulfilled')
    .flatMap((outcome) => outcome.value);
}

// ---- episodes ---------------------------------------------------------------

export function getEpisode(guid) {
  return db.get('episodes', guid);
}

export async function episodesFor(feedUrl, newestFirst = true) {
  const all = await db.getAllByIndex('episodes', 'feedUrl', feedUrl);
  const visible = all.filter((episode) => !episode.isArchived);
  visible.sort((a, b) =>
    newestFirst ? b.publishedAt - a.publishedAt : a.publishedAt - b.publishedAt,
  );
  return visible;
}

export async function newEpisodes(limit = 30) {
  const shows = await subscriptions();
  const feeds = new Set(shows.map((show) => show.feedUrl));
  const since = Date.now() - NEW_WINDOW_MS;
  const all = await db.getAll('episodes');
  return all
    .filter(
      (episode) =>
        feeds.has(episode.feedUrl) &&
        !episode.isArchived &&
        !episode.isCompleted &&
        !episode.positionMs &&
        episode.publishedAt >= since,
    )
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit);
}

export async function continueListening(limit = 20) {
  const all = await db.getAll('episodes');
  return all
    .filter((episode) => episode.positionMs > 0 && !episode.isArchived && !effectivelyFinished(episode))
    .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
    .slice(0, limit);
}

export async function history(limit = 100) {
  const all = await db.getAll('episodes');
  return all
    .filter((episode) => episode.isCompleted)
    .sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0))
    .slice(0, limit);
}

export async function downloads() {
  const all = await db.getAllByIndex('episodes', 'downloadState', 'DOWNLOADED');
  return all.sort((a, b) => b.publishedAt - a.publishedAt);
}

export async function savePosition(guid, positionMs) {
  await db.update('episodes', guid, (episode) => ({
    ...episode,
    positionMs,
    lastPlayedAt: Date.now(),
  }));
}

export async function markCompleted(guid, completed = true) {
  const episode = await getEpisode(guid);
  if (!episode) return;
  await db.update('episodes', guid, (current) => ({
    ...current,
    isCompleted: completed,
    positionMs: completed ? current.durationMs : 0,
    lastPlayedAt: Date.now(),
  }));
  if (completed) await removeFromQueue(guid);
  notify('episodes');
}

export async function archive(guid) {
  await db.update('episodes', guid, (episode) => ({ ...episode, isArchived: true }));
  await removeFromQueue(guid);
  notify('episodes');
}

// ---- queue ------------------------------------------------------------------

export async function queue() {
  const rows = (await db.getAll('queue')).sort((a, b) => a.position - b.position);
  const episodes = await Promise.all(rows.map((row) => getEpisode(row.guid)));
  return episodes.filter(Boolean);
}

export async function addToQueue(guid, playNext = false) {
  const rows = await db.getAll('queue');
  const positions = rows.map((row) => row.position);
  const position = playNext
    ? Math.min(0, ...positions) - 1
    : Math.max(0, ...positions, -1) + 1;
  await db.put('queue', { guid, position, addedAt: Date.now() });
  notify('queue');
}

export async function removeFromQueue(guid) {
  await db.remove('queue', guid);
  notify('queue');
}

export async function clearQueue() {
  await db.clear('queue');
  notify('queue');
}

export async function reorderQueue(guids) {
  await db.clear('queue');
  await db.putMany(
    'queue',
    guids.map((guid, index) => ({ guid, position: index, addedAt: Date.now() })),
  );
  notify('queue');
}

export async function isQueued(guid) {
  return Boolean(await db.get('queue', guid));
}

/** The episode playback should advance to when the current one ends. */
export async function nextInQueue(afterGuid) {
  const rows = (await db.getAll('queue')).sort((a, b) => a.position - b.position);
  if (!rows.length) return null;
  const index = rows.findIndex((row) => row.guid === afterGuid);
  const next = index >= 0 ? rows[index + 1] : rows[0];
  return next ? getEpisode(next.guid) : null;
}
