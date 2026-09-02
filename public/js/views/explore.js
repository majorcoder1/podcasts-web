import * as api from '../api.js';
import { showTile, spinner, topBar, iconButton } from '../components.js';
import { escapeHtml } from '../dom.js';
import { icon } from '../icons.js';

const state = { query: '', categoryIndex: 0, results: [], loading: false, error: null };
let debounce = null;
let requestId = 0;

function isFeedUrl(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

export async function render(root, ctx) {
  root.innerHTML = shell();
  wire(root, ctx);
  paint(root, ctx);

  if (!state.results.length && !state.loading) await loadCategory(root, ctx);
}

function shell() {
  return `
  ${topBar('', `
    <div class="search-row" style="flex:1">
      <label class="search-field">
        ${icon('search')}
        <input id="explore-input" type="search" placeholder="Search for a show or topic"
               autocomplete="off" spellcheck="false" value="${escapeHtml(state.query)}" />
      </label>
      ${state.query ? iconButton('clear', 'close', 'Clear') : ''}
    </div>
    ${iconButton('settings', 'account', 'Settings')}
  `)}
  <div id="explore-body"></div>`;
}

function paint(root, ctx) {
  const body = root.querySelector('#explore-body');
  if (!body) return;

  const parts = [];

  if (isFeedUrl(state.query)) {
    parts.push(`
      <button class="setting" data-action="show" data-feed="${escapeHtml(state.query.trim())}">
        ${icon('rss')}
        <span class="label">
          <strong>Open this RSS feed</strong>
          <span class="truncate">${escapeHtml(state.query.trim())}</span>
        </span>
      </button>`);
  }

  if (!state.query.trim()) {
    parts.push(`<div class="chips">${api.CATEGORIES.map(
      (category, index) =>
        `<button class="chip" data-action="category" data-index="${index}" aria-pressed="${index === state.categoryIndex}">${escapeHtml(category.label)}</button>`,
    ).join('')}</div>`);
  }

  if (state.loading && !state.results.length) {
    parts.push(spinner());
  } else if (state.error && !state.results.length) {
    parts.push(`<div class="empty"><strong>${escapeHtml(state.error)}</strong></div>`);
  } else if (!state.results.length) {
    parts.push('<div class="empty">No shows matched that search.</div>');
  } else {
    parts.push(`<div class="grid">${state.results.map((item) => showTile(item)).join('')}</div>`);
  }

  body.innerHTML = parts.join('');
}

function wire(root, ctx) {
  const input = root.querySelector('#explore-input');
  if (input) {
    input.addEventListener('input', () => {
      state.query = input.value;
      const body = root.querySelector('#explore-body');
      if (body) paint(root, ctx);
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (state.query.trim() && !isFeedUrl(state.query)) runSearch(root, ctx);
        else if (!state.query.trim()) loadCategory(root, ctx);
      }, 300);
    });
  }

  ctx.onAction(root, {
    clear: () => {
      state.query = '';
      render(root, ctx);
    },
    category: ({ index }) => {
      state.categoryIndex = Number(index);
      loadCategory(root, ctx);
      paint(root, ctx);
    },
    show: ({ feed }) => ctx.navigate(`/show/${encodeURIComponent(feed)}`),
    settings: () => ctx.navigate('/settings'),
  });
}

async function runSearch(root, ctx) {
  const id = ++requestId;
  state.loading = true;
  state.error = null;
  paint(root, ctx);
  try {
    const results = await api.search(state.query.trim());
    if (id !== requestId) return;
    state.results = results;
  } catch (error) {
    if (id !== requestId) return;
    state.error = "Couldn't search. Check your connection.";
    state.results = [];
  } finally {
    if (id === requestId) {
      state.loading = false;
      paint(root, ctx);
    }
  }
}

async function loadCategory(root, ctx) {
  const id = ++requestId;
  state.loading = true;
  state.error = null;
  paint(root, ctx);
  try {
    const category = api.CATEGORIES[state.categoryIndex];
    const results = await api.topShows(category.genreId);
    if (id !== requestId) return;
    state.results = results;
  } catch (error) {
    if (id !== requestId) return;
    state.error = "Couldn't load shows. Check your connection.";
    state.results = [];
  } finally {
    if (id === requestId) {
      state.loading = false;
      paint(root, ctx);
    }
  }
}

export function focusSearch() {
  state.query = '';
  requestAnimationFrame(() => document.getElementById('explore-input')?.focus());
}
