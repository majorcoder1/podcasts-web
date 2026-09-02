// The persistent shell: bottom navigation, docked mini player, and the
// full-screen player that slides up from it.

import * as player from './player.js';
import * as store from './store.js';
import { art, escapeHtml, onAction } from './dom.js';
import { icon } from './icons.js';
import { formatClock, formatRemaining, formatSpeed } from './format.js';

const TABS = [
  { route: '/', label: 'Home', icon: 'home' },
  { route: '/explore', label: 'Explore', icon: 'explore' },
  { route: '/activity', label: 'Activity', icon: 'activity' },
];

let ctx = null;
let sheetOpen = false;
let scrubbing = false;

export function init(context) {
  ctx = context;

  const navbar = document.getElementById('navbar');
  navbar.innerHTML = TABS.map(
    (tab) => `
    <button data-action="tab" data-route="${tab.route}" aria-label="${tab.label}">
      <span class="pill">${icon(tab.icon)}</span>
      <span>${tab.label}</span>
    </button>`,
  ).join('');

  onAction(navbar, { tab: ({ route }) => ctx.navigate(route) });

  const mini = document.getElementById('mini-player');
  onAction(mini, {
    expand: () => openSheet(),
    playPause: () => player.playPause(),
    forward: () => player.skipForward(),
  });

  const sheet = document.getElementById('player-sheet');
  onAction(sheet, {
    collapse: () => closeSheet(),
    playPause: () => player.playPause(),
    forward: () => player.skipForward(),
    back: () => player.skipBack(),
    speed: () => openSpeedDialog(),
    sleep: () => openSleepDialog(),
    goToShow: ({ feed }) => {
      closeSheet();
      ctx.navigate(`/show/${encodeURIComponent(feed)}`);
    },
  });

  player.onChange(() => {
    renderMini();
    if (sheetOpen) renderSheet();
  });

  renderMini();
}

export function setActiveTab(route) {
  document.querySelectorAll('#navbar button').forEach((button) => {
    const isCurrent = button.dataset.route === route;
    if (isCurrent) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

// ---- mini player ------------------------------------------------------------

function renderMini() {
  const node = document.getElementById('mini-player');
  const state = player.getState();

  if (!state.episode) {
    node.classList.add('hidden');
    node.innerHTML = '';
    return;
  }

  const remaining = Math.max(0, state.durationMs - state.positionMs);
  node.classList.remove('hidden');
  node.innerHTML = `
    <div class="mini-progress"><div style="width:${(ratio(state) * 100).toFixed(2)}%"></div></div>
    <div class="mini-body">
      <button class="mini-text" data-action="expand" style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
        ${art(state.episode.imageUrl, state.episode.title, 'art')}
        <span style="flex:1;min-width:0;text-align:left">
          <strong class="truncate">${escapeHtml(state.episode.title)}</strong>
          <span class="truncate" style="display:block">${escapeHtml(formatRemaining(remaining) || formatClock(state.positionMs))}</span>
        </span>
      </button>
      <button class="icon-button" data-action="playPause" aria-label="${state.isPlaying ? 'Pause' : 'Play'}">
        ${icon(state.isPlaying ? 'pause' : 'play')}
      </button>
      <button class="icon-button" data-action="forward" aria-label="Forward 30 seconds">${icon('forward30')}</button>
    </div>`;
}

function ratio(state) {
  return state.durationMs ? Math.min(1, state.positionMs / state.durationMs) : 0;
}

// ---- full player ------------------------------------------------------------

export function openSheet() {
  const state = player.getState();
  if (!state.episode) return;
  sheetOpen = true;
  renderSheet();
  const sheet = document.getElementById('player-sheet');
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
}

export function closeSheet() {
  sheetOpen = false;
  const sheet = document.getElementById('player-sheet');
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
}

export function isSheetOpen() {
  return sheetOpen;
}

async function renderSheet() {
  const sheet = document.getElementById('player-sheet');
  const state = player.getState();
  if (!state.episode) return closeSheet();

  const upNext = await store.nextInQueue(state.episode.guid);
  const position = scrubbing ? currentScrubMs(state) : state.positionMs;

  sheet.innerHTML = `
    <header class="topbar">
      <button class="icon-button" data-action="collapse" aria-label="Collapse">${icon('down')}</button>
      <div class="spacer"></div>
    </header>
    <div class="player-body">
      ${art(state.episode.imageUrl, state.episode.title)}
      <h2 class="player-title clamp-3">${escapeHtml(state.episode.title)}</h2>
      <button class="player-show" data-action="goToShow" data-feed="${escapeHtml(state.episode.feedUrl)}">
        ${escapeHtml(state.show?.title || 'Go to show')}
      </button>

      ${state.error ? `<p style="color:var(--danger);text-align:center">${escapeHtml(state.error)}</p>` : ''}

      <div class="scrubber">
        <input id="scrub" type="range" min="0" max="${Math.max(1, Math.round(state.durationMs))}"
               value="${Math.round(position)}" step="1000" aria-label="Seek" />
        <div class="times">
          <span>${formatClock(position)}</span>
          <span>${formatClock(state.durationMs)}</span>
        </div>
      </div>

      <div class="transport">
        <button class="icon-button speed" data-action="speed" aria-label="Playback speed">${formatSpeed(state.speed)}</button>
        <button class="icon-button" data-action="back" aria-label="Back 10 seconds">${icon('replay10')}</button>
        <button class="play-fab" data-action="playPause" aria-label="${state.isPlaying ? 'Pause' : 'Play'}">
          ${icon(state.isPlaying ? 'pause' : 'play')}
        </button>
        <button class="icon-button" data-action="forward" aria-label="Forward 30 seconds">${icon('forward30')}</button>
        <button class="icon-button ${state.sleepTimerEndsAt || state.sleepAtEndOfEpisode ? 'active' : ''}"
                data-action="sleep" aria-label="Sleep timer">${icon('bedtime')}</button>
      </div>

      <div class="up-next">
        ${icon('queueMusic')}
        <span class="truncate">${upNext ? `Up next: ${escapeHtml(upNext.title)}` : 'Queue is empty'}</span>
      </div>
    </div>`;

  const scrub = sheet.querySelector('#scrub');
  scrub.addEventListener('input', () => { scrubbing = true; });
  scrub.addEventListener('change', () => {
    player.seekTo(Number(scrub.value));
    scrubbing = false;
  });
}

function currentScrubMs(state) {
  const scrub = document.getElementById('scrub');
  return scrub ? Number(scrub.value) : state.positionMs;
}

// ---- dialogs ----------------------------------------------------------------

function dialog(title, rows, onPick) {
  const node = document.createElement('dialog');
  node.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    ${rows
      .map(
        (row, index) =>
          `<button class="option" data-index="${index}">${escapeHtml(row.label)}${row.selected ? icon('check') : ''}</button>`,
      )
      .join('')}
    <button class="close" data-close>Cancel</button>`;

  document.body.appendChild(node);
  node.showModal();
  node.addEventListener('click', (event) => {
    const option = event.target.closest('.option');
    if (option) {
      onPick(rows[Number(option.dataset.index)]);
      node.close();
    } else if (event.target.closest('[data-close]')) {
      node.close();
    }
  });
  node.addEventListener('close', () => node.remove());
}

function openSpeedDialog() {
  const state = player.getState();
  dialog(
    'Playback speed',
    player.PLAYBACK_SPEEDS.map((speed) => ({
      label: formatSpeed(speed),
      value: speed,
      selected: speed === state.speed,
    })),
    (row) => player.setSpeed(row.value),
  );
}

function openSleepDialog() {
  const state = player.getState();
  const rows = player.SLEEP_TIMER_PRESETS.map((minutes) => ({
    label: `${minutes} minutes`,
    value: minutes,
    selected: false,
  }));
  rows.push({ label: 'End of episode', value: null, selected: state.sleepAtEndOfEpisode });
  if (state.sleepTimerEndsAt || state.sleepAtEndOfEpisode) {
    rows.push({ label: 'Turn off timer', value: 'off', selected: false });
  }
  dialog('Sleep timer', rows, (row) => {
    if (row.value === 'off') player.cancelSleepTimer();
    else player.startSleepTimer(row.value);
  });
}
