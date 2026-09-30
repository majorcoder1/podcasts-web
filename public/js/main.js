// Router and app bootstrap.

import * as store from './store.js';
import * as player from './player.js';
import * as downloads from './downloads.js';
import * as chrome from './chrome.js';
import * as account from './account.js';
import { onAction, toast } from './dom.js';
import { openSheet } from './menu.js';

import * as home from './views/home.js';
import * as explore from './views/explore.js';
import * as activity from './views/activity.js';
import * as show from './views/show.js';
import * as settings from './views/settings.js';

const screen = document.getElementById('screen');

const ctx = {
  navigate,
  back,
  onAction,
  bindEpisodeActions,
  toggleEpisode,
  applyTheme,
};

function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

// ---- routing ----------------------------------------------------------------

/** The app is mounted under /app; '/' is the landing page. */
export const BASE = '/app';

function currentRoute() {
  const path = location.pathname.replace(/^\/app/, '');
  return path === '' || path === '/' ? '/' : path;
}

function navigate(route, replace = false) {
  if (route === currentRoute()) return render();
  const url = route === '/' ? BASE + '/' : BASE + route;
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  render();
}

function back() {
  if (history.length > 1) history.back();
  else navigate('/');
}

window.addEventListener('popstate', () => render());

async function render() {
  const route = currentRoute();
  screen.scrollTop = 0;
  window.scrollTo(0, 0);

  if (route.startsWith('/show/')) {
    chrome.setActiveTab(null);
    const feedUrl = decodeURIComponent(route.slice('/show/'.length));
    return show.render(screen, ctx, feedUrl);
  }

  if (route === '/settings') {
    chrome.setActiveTab(null);
    return settings.render(screen, ctx);
  }

  if (route === '/explore') {
    chrome.setActiveTab('/explore');
    return explore.render(screen, ctx);
  }

  if (route === '/activity') {
    chrome.setActiveTab('/activity');
    return activity.render(screen, ctx);
  }

  chrome.setActiveTab('/');
  return home.render(screen, ctx);
}

// ---- episode actions --------------------------------------------------------

/**
 * Every list of episodes shares the same row controls, so the handlers live
 * here once and each view adds only what is specific to it.
 */
function bindEpisodeActions(root, extra = {}) {
  onAction(root, {
    open: ({ feed }) => navigate(`/show/${encodeURIComponent(feed)}`),
    show: ({ feed }) => navigate(`/show/${encodeURIComponent(feed)}`),
    toggle: ({ guid }) => toggleEpisode(guid),
    enqueue: async ({ guid }) => {
      await store.addToQueue(guid);
      toast('Added to queue');
      render();
    },
    dequeue: async ({ guid }) => {
      await store.removeFromQueue(guid);
      toast('Removed from queue');
      render();
    },
    download: ({ guid }) => handleDownload(guid),
    menu: ({ guid }) => openEpisodeMenu(guid),
    search: () => {
      explore.focusSearch();
      navigate('/explore');
    },
    settings: () => navigate('/settings'),
    ...extra,
  });
}

/**
 * Everything you can do to an episode, in one sheet.
 *
 * The row used to carry these as separate icons, and "mark played" wore a
 * three-dot icon that promised a menu and never opened one - tapping it made
 * the episode vanish from Home, because Home only lists unplayed episodes.
 */
async function openEpisodeMenu(guid) {
  const episode = await store.getEpisode(guid);
  if (!episode) return;

  const [show, queued] = await Promise.all([
    store.getPodcast(episode.feedUrl),
    store.isQueued(guid),
  ]);
  const downloaded = episode.downloadState === 'DOWNLOADED';
  const played = episode.isCompleted;

  const items = [
    {
      icon: 'queueMusic',
      label: 'Play next',
      action: async () => {
        await store.addToQueue(guid, true);
        toast('Playing next');
        render();
      },
    },
    queued
      ? {
          icon: 'remove',
          label: 'Remove from queue',
          action: async () => {
            await store.removeFromQueue(guid);
            toast('Removed from queue');
            render();
          },
        }
      : {
          icon: 'queueAdd',
          label: 'Add to queue',
          action: async () => {
            await store.addToQueue(guid);
            toast('Added to queue');
            render();
          },
        },
    {
      icon: downloaded ? 'downloadDone' : 'download',
      label: downloaded ? 'Remove download' : 'Download',
      action: () => handleDownload(guid),
    },
    {
      icon: played ? 'remove' : 'checkCircle',
      label: played ? 'Mark as unplayed' : 'Mark as played',
      action: async () => {
        await store.markCompleted(guid, !played);
        // Marking played removes it from Home, so say so rather than letting
        // the row silently disappear.
        toast(played ? 'Marked unplayed' : 'Marked as played');
        render();
      },
    },
    {
      icon: 'podcast',
      label: 'Go to show',
      action: () => navigate(`/show/${encodeURIComponent(episode.feedUrl)}`),
    },
    {
      icon: 'delete',
      label: 'Hide this episode',
      danger: true,
      action: async () => {
        await store.archive(guid);
        toast('Episode hidden');
        render();
      },
    },
  ];

  openSheet({ title: episode.title, subtitle: show?.title, items });
}

async function toggleEpisode(guid) {
  const episode = await store.getEpisode(guid);
  if (!episode) return;
  const state = player.getState();
  if (state.episode?.guid === guid) await player.playPause();
  else await player.play(episode);
  render();
}

async function handleDownload(guid) {
  const episode = await store.getEpisode(guid);
  if (!episode) return;

  if (episode.downloadState === 'DOWNLOADED') {
    await downloads.remove(guid);
    toast('Download removed');
    return render();
  }
  if (episode.downloadState === 'DOWNLOADING') return;

  toast('Downloading…');
  render();
  try {
    await downloads.download(guid);
    toast('Downloaded');
  } catch (error) {
    toast(error.message || 'Download failed');
  }
  render();
}

// ---- background upkeep ------------------------------------------------------

const REFRESH_CHECK_MS = 15 * 60 * 1000;
let lastRefreshAt = 0;

async function maybeRefresh() {
  const settings_ = await store.getSettings();
  const dueAt = lastRefreshAt + settings_.refreshIntervalHours * 3600000;
  if (Date.now() < dueAt) return;

  lastRefreshAt = Date.now();
  try {
    const fresh = await store.refreshAllSubscriptions();
    if (fresh.length) {
      toast(`${fresh.length} new episode${fresh.length === 1 ? '' : 's'}`);
      render();
    }
    await downloads.applyRetentionRules();
  } catch (error) {
    console.warn('refresh failed', error);
  }
}

// ---- boot -------------------------------------------------------------------

async function boot() {
  // The app is behind an account. Anyone not signed in belongs on the landing
  // page, which is where signing in happens.
  const session = await account.currentUser();
  if (!session) {
    location.replace('/?next=' + encodeURIComponent(location.pathname));
    return;
  }

  const settings_ = await store.getSettings();
  applyTheme(settings_.theme);

  await player.init();
  chrome.init(ctx);

  // Re-render lists when data changes underneath them.
  store.subscribeToChanges((reason) => {
    if (reason === 'settings') return;
    render();
  });

  await render();

  lastRefreshAt = Date.now();
  setInterval(maybeRefresh, REFRESH_CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeRefresh();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('service worker registration failed', error);
    });
  }
}

boot().catch((error) => {
  console.error(error);
  screen.innerHTML = `<div class="empty"><strong>Something went wrong starting up</strong><span>${error.message}</span></div>`;
});
