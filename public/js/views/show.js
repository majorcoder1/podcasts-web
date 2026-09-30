import * as store from '../store.js';
import * as player from '../player.js';
import { episodeRow, spinner, topBar, iconButton } from '../components.js';
import { art, escapeHtml, toast } from '../dom.js';
import { openSheet } from '../menu.js';
import { icon } from '../icons.js';

let newestFirst = true;
let descriptionOpen = false;

export async function render(root, ctx, feedUrl) {
  root.innerHTML = topBar('', iconButton('back', 'back', 'Back')) + spinner();
  ctx.onAction(root, { back: () => ctx.back() });

  let podcast;
  try {
    podcast = await store.loadPreview(feedUrl);
  } catch (error) {
    root.innerHTML =
      topBar('', iconButton('back', 'back', 'Back')) +
      `<div class="empty"><strong>Couldn't load this show</strong><span>${escapeHtml(error.message)}</span></div>`;
    ctx.onAction(root, { back: () => ctx.back() });
    return;
  }

  await paint(root, ctx, podcast.feedUrl);
}

async function paint(root, ctx, feedUrl) {
  const podcast = await store.getPodcast(feedUrl);
  if (!podcast) return;

  const episodes = await store.episodesFor(feedUrl, newestFirst);
  const queued = new Set((await store.queue()).map((episode) => episode.guid));
  const playerState = player.getState();

  root.innerHTML = `
    ${topBar('', iconButton('back', 'back', 'Back') + iconButton('showMenu', 'more', 'More options'))}
    <div class="show-header">
      ${art(podcast.imageUrl, podcast.title)}
      <div>
        <h2>${escapeHtml(podcast.title)}</h2>
        <div class="author clamp-2">${escapeHtml(podcast.author || '')}</div>
      </div>
    </div>
    <div class="show-actions">
      ${
        podcast.isSubscribed
          ? `<button class="button outlined" data-action="unsubscribe">${icon('check')} Subscribed</button>`
          : '<button class="button filled" data-action="subscribe">Subscribe</button>'
      }
    </div>
    ${
      podcast.description
        ? `<p class="show-description ${descriptionOpen ? '' : 'clamp-3'}" data-action="toggleDescription">${escapeHtml(podcast.description)}</p>`
        : ''
    }
    <div class="sort-row">
      <h3>Episodes</h3>
      <button data-action="sort">${icon('sort')} ${newestFirst ? 'Newest first' : 'Oldest first'}</button>
    </div>
    ${
      episodes.length
        ? episodes
            .map((episode) =>
              episodeRow(episode, {
                playingGuid: playerState.episode?.guid,
                isPlaying: playerState.isPlaying,
                showTitle: podcast.title,
                inQueue: queued.has(episode.guid),
              }),
            )
            .join('')
        : '<div class="empty">This feed has no playable episodes.</div>'
    }`;

  ctx.bindEpisodeActions(root, {
    back: () => ctx.back(),
    sort: () => {
      newestFirst = !newestFirst;
      paint(root, ctx, feedUrl);
    },
    toggleDescription: () => {
      descriptionOpen = !descriptionOpen;
      paint(root, ctx, feedUrl);
    },
    subscribe: async () => {
      await store.subscribe(feedUrl);
      toast('Subscribed');
      paint(root, ctx, feedUrl);
    },
    unsubscribe: async () => {
      await store.unsubscribe(feedUrl);
      toast('Unsubscribed');
      paint(root, ctx, feedUrl);
    },
    // A three-dot icon promises a menu, so it opens one. It used to silently
    // toggle auto download, which looked like a dead button.
    showMenu: async () => {
      const current = await store.getPodcast(feedUrl);
      if (!current) return;

      const items = [
        {
          icon: 'downloading',
          label: 'Check for new episodes',
          action: async () => {
            toast('Checking\u2026');
            try {
              await store.refresh(feedUrl);
              toast('Up to date');
            } catch {
              toast("Couldn't reach this feed");
            }
            paint(root, ctx, feedUrl);
          },
        },
        {
          icon: current.autoDownload ? 'downloadDone' : 'download',
          label: current.autoDownload ? 'Turn off auto download' : 'Auto download new episodes',
          action: async () => {
            await store.setPodcastFlag(feedUrl, 'autoDownload', !current.autoDownload);
            toast(current.autoDownload ? 'Auto download off' : 'Auto download on');
            paint(root, ctx, feedUrl);
          },
        },
        {
          icon: 'sort',
          label: newestFirst ? 'Show oldest first' : 'Show newest first',
          action: () => {
            newestFirst = !newestFirst;
            paint(root, ctx, feedUrl);
          },
        },
        {
          icon: 'checkCircle',
          label: 'Mark all as played',
          action: async () => {
            const all = await store.episodesFor(feedUrl);
            const unplayed = all.filter((episode) => !episode.isCompleted);
            for (const episode of unplayed) {
              await store.markCompleted(episode.guid, true);
            }
            toast(`Marked ${unplayed.length} as played`);
            paint(root, ctx, feedUrl);
          },
        },
      ];

      if (current.link) {
        items.push({
          icon: 'rss',
          label: "Open the show's website",
          action: () => window.open(current.link, '_blank', 'noopener'),
        });
      }

      if (current.isSubscribed) {
        items.push({
          icon: 'remove',
          label: 'Unsubscribe',
          danger: true,
          action: async () => {
            await store.unsubscribe(feedUrl);
            toast('Unsubscribed');
            paint(root, ctx, feedUrl);
          },
        });
      }

      openSheet({ title: current.title, subtitle: current.author, items });
    },
    // Tapping a row on the show page plays it, as in the original.
    open: ({ guid }) => ctx.toggleEpisode(guid),
  });
}
