import * as store from '../store.js';
import * as player from '../player.js';
import { episodeRow, sectionHeader, showTile, emptyState, topBar, iconButton } from '../components.js';

export async function render(root, ctx) {
  const [subscriptions, queue, inProgress, fresh] = await Promise.all([
    store.subscriptions(),
    store.queue(),
    store.continueListening(),
    store.newEpisodes(),
  ]);

  const shows = new Map(subscriptions.map((show) => [show.feedUrl, show]));
  const playerState = player.getState();
  const rowOptions = (episode) => ({
    playingGuid: playerState.episode?.guid,
    isPlaying: playerState.isPlaying,
    showArtwork: true,
    showTitle: shows.get(episode.feedUrl)?.title,
  });

  const header = topBar(
    'Podcasts',
    iconButton('search', 'search', 'Search') + iconButton('settings', 'account', 'Settings'),
  );

  if (!subscriptions.length && !inProgress.length && !fresh.length) {
    root.innerHTML = header + emptyState(
      'Subscribe to a show to see new episodes here',
      'Explore',
      'search',
    );
    return;
  }

  const sections = [];

  if (subscriptions.length) {
    sections.push(
      sectionHeader('Your subscriptions'),
      `<div class="shelf">${subscriptions.map((show) => showTile(show, { compact: true })).join('')}</div>`,
    );
  }

  if (queue.length) {
    sections.push(
      sectionHeader('Your queue', `${queue.length} episode${queue.length === 1 ? '' : 's'}`),
      queue.slice(0, 3).map((episode) => episodeRow(episode, { ...rowOptions(episode), inQueue: true })).join(''),
    );
  }

  if (inProgress.length) {
    sections.push(
      sectionHeader('Continue listening'),
      inProgress.map((episode) => episodeRow(episode, rowOptions(episode))).join(''),
    );
  }

  if (fresh.length) {
    sections.push(
      sectionHeader('New episodes'),
      fresh.map((episode) => episodeRow(episode, rowOptions(episode))).join(''),
    );
  }

  root.innerHTML = header + sections.join('');
  ctx.bindEpisodeActions(root);
}
