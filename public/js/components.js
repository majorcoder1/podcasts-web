// Shared row/section markup, mirroring the Compose components.

import { art, escapeHtml } from './dom.js';
import { icon } from './icons.js';
import { formatDuration, formatEpisodeDate, formatRemaining } from './format.js';
import { effectivelyFinished, hasStarted, progress, remainingMs } from './feed.js';

function downloadIcon(episode) {
  if (episode.downloadState === 'DOWNLOADED') return { name: 'downloadDone', label: 'Remove download', active: true };
  if (episode.downloadState === 'DOWNLOADING' || episode.downloadState === 'QUEUED') {
    return { name: 'downloading', label: 'Downloading', active: false };
  }
  return { name: 'download', label: 'Download', active: false };
}

/**
 * The episode row from the original app: date, two-line title, then a footer of
 * play button, duration, queue, download and overflow.
 */
export function episodeRow(episode, options = {}) {
  const { playingGuid, showTitle, showArtwork = false, inQueue = false } = options;
  const isPlaying = playingGuid === episode.guid && options.isPlaying;
  const done = effectivelyFinished(episode);
  const started = hasStarted(episode);
  const dl = downloadIcon(episode);

  const meta = done
    ? 'Played'
    : started
      ? formatRemaining(remainingMs(episode))
      : formatDuration(episode.durationMs);

  return `
  <article class="episode" data-guid="${escapeHtml(episode.guid)}">
    <div class="episode-head" data-action="open" data-feed="${escapeHtml(episode.feedUrl)}" data-guid="${escapeHtml(episode.guid)}">
      ${showArtwork ? art(episode.imageUrl, showTitle || episode.title) : ''}
      <div class="episode-main">
        <div class="episode-date">${escapeHtml(formatEpisodeDate(episode.publishedAt))}</div>
        ${showArtwork && showTitle ? `<div class="episode-show truncate">${escapeHtml(showTitle)}</div>` : ''}
        <h3 class="episode-title clamp-2">${escapeHtml(episode.title)}</h3>
        ${!showArtwork && episode.description ? `<p class="episode-description clamp-2">${escapeHtml(episode.description)}</p>` : ''}
      </div>
    </div>
    <div class="episode-actions">
      <button class="icon-button play" data-action="toggle" data-guid="${escapeHtml(episode.guid)}"
              title="${isPlaying ? 'Pause' : 'Play'}" aria-label="${isPlaying ? 'Pause' : 'Play'}">
        ${icon(isPlaying ? 'pause' : 'play')}
      </button>
      <div class="meta">
        <div>${escapeHtml(meta)}</div>
        ${started ? `<div class="track"><div style="width:${(progress(episode) * 100).toFixed(1)}%"></div></div>` : ''}
      </div>
      <button class="icon-button" data-action="${inQueue ? 'dequeue' : 'enqueue'}" data-guid="${escapeHtml(episode.guid)}"
              title="${inQueue ? 'Remove from queue' : 'Add to queue'}" aria-label="${inQueue ? 'Remove from queue' : 'Add to queue'}">
        ${icon(inQueue ? 'remove' : 'queueAdd')}
      </button>
      <button class="icon-button ${dl.active ? 'active' : ''}" data-action="download" data-guid="${escapeHtml(episode.guid)}"
              title="${dl.label}" aria-label="${dl.label}">
        ${icon(dl.name)}
      </button>
      <button class="icon-button ${done ? 'done' : ''}" data-action="played" data-guid="${escapeHtml(episode.guid)}"
              title="${done ? 'Mark unplayed' : 'Mark played'}" aria-label="${done ? 'Mark unplayed' : 'Mark played'}">
        ${icon(done ? 'checkCircle' : 'more')}
      </button>
    </div>
  </article>`;
}

export function sectionHeader(title, trailing) {
  return `<div class="section-header"><h2>${escapeHtml(title)}</h2>${
    trailing ? `<span>${escapeHtml(trailing)}</span>` : ''
  }</div>`;
}

export function showTile(item, { compact = false } = {}) {
  const caption = compact
    ? `<figcaption class="clamp-2">${escapeHtml(item.title)}</figcaption>`
    : `<figcaption>
         <div class="name clamp-2">${escapeHtml(item.title)}</div>
         <div class="author truncate">${escapeHtml(item.author || '')}</div>
       </figcaption>`;
  return `<figure data-action="show" data-feed="${escapeHtml(item.feedUrl)}" tabindex="0">
    ${art(item.imageUrl, item.title)}${caption}
  </figure>`;
}

export function emptyState(headline, actionLabel, action) {
  return `<div class="empty">
    <strong>${escapeHtml(headline)}</strong>
    ${action ? `<button data-action="${action}" style="color:var(--primary);font-weight:500">${escapeHtml(actionLabel)}</button>` : ''}
  </div>`;
}

export function spinner() {
  return '<div class="spinner" role="status" aria-label="Loading"></div>';
}

export function topBar(title, actions = '') {
  return `<header class="topbar">
    ${title ? `<h1>${escapeHtml(title)}</h1>` : '<div class="spacer"></div>'}
    ${actions}
  </header>`;
}

export function iconButton(action, iconName, label, extra = '') {
  return `<button class="icon-button" data-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" ${extra}>${icon(iconName)}</button>`;
}
