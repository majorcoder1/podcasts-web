import * as store from '../store.js';
import * as player from '../player.js';
import * as downloads from '../downloads.js';
import { episodeRow, topBar, iconButton } from '../components.js';
import { formatBytes } from '../format.js';
import { escapeHtml, toast } from '../dom.js';

const TABS = ['Queue', 'Downloads', 'History'];
let activeTab = 0;

export async function render(root, ctx) {
  const [queue, downloaded, past, subscriptions] = await Promise.all([
    store.queue(),
    store.downloads(),
    store.history(),
    store.subscriptions(),
  ]);

  const shows = new Map(subscriptions.map((show) => [show.feedUrl, show]));
  const lists = [queue, downloaded, past];
  const episodes = lists[activeTab];
  const playerState = player.getState();
  const usedBytes = downloaded.reduce((total, episode) => total + (episode.fileSizeBytes || 0), 0);

  const actions =
    (activeTab === 1 && downloaded.length ? iconButton('clearDownloads', 'delete', 'Remove all downloads') : '') +
    (activeTab === 0 && queue.length ? iconButton('clearQueue', 'delete', 'Clear queue') : '') +
    iconButton('settings', 'account', 'Settings');

  const emptyCopy = [
    'Episodes you add to your queue show up here',
    'Downloaded episodes show up here',
    'Episodes you finish show up here',
  ][activeTab];

  const body = episodes.length
    ? episodes
        .map((episode) =>
          episodeRow(episode, {
            playingGuid: playerState.episode?.guid,
            isPlaying: playerState.isPlaying,
            showArtwork: true,
            showTitle: shows.get(episode.feedUrl)?.title,
            inQueue: activeTab === 0,
          }),
        )
        .join('')
    : `<div class="empty">${escapeHtml(emptyCopy)}</div>`;

  root.innerHTML = `
    ${topBar('Activity', actions)}
    <div class="tabs" role="tablist">
      ${TABS.map(
        (label, index) =>
          `<button role="tab" data-action="tab" data-index="${index}" aria-selected="${index === activeTab}">${label}</button>`,
      ).join('')}
    </div>
    ${activeTab === 1 && usedBytes ? `<div style="padding:8px 16px;font-size:12px;color:var(--on-surface-variant)">${formatBytes(usedBytes)} used</div>` : ''}
    ${body}`;

  ctx.bindEpisodeActions(root, {
    tab: ({ index }) => {
      activeTab = Number(index);
      render(root, ctx);
    },
    clearQueue: async () => {
      await store.clearQueue();
      toast('Queue cleared');
      render(root, ctx);
    },
    clearDownloads: async () => {
      await downloads.removeAll();
      toast('Downloads removed');
      render(root, ctx);
    },
  });
}

export function selectTab(index) {
  activeTab = index;
}
