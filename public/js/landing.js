// Landing page: sign in or create an account, and surface the current APK build.

import * as account from './account.js';

const form = document.getElementById('auth-form');
const authPanel = document.getElementById('auth-panel');
const message = document.getElementById('form-message');
const submit = document.getElementById('submit');
const tabSignIn = document.getElementById('tab-signin');
const tabRegister = document.getElementById('tab-register');
const inviteField = document.getElementById('invite-field');
const passwordHint = document.getElementById('password-hint');
const passwordInput = document.getElementById('password');
const card = document.getElementById('account-card');
const navCta = document.getElementById('nav-cta');

let mode = 'signin';

/** Where to land after signing in, when the app bounced us here. */
function nextTarget() {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/app') ? next : '/app/';
}

function setMode(next) {
  mode = next;
  const registering = mode === 'register';

  tabSignIn.setAttribute('aria-selected', String(!registering));
  tabRegister.setAttribute('aria-selected', String(registering));
  // Only the selected tab sits in the Tab order; arrows move between them.
  tabSignIn.tabIndex = registering ? -1 : 0;
  tabRegister.tabIndex = registering ? 0 : -1;
  authPanel.setAttribute('aria-labelledby', registering ? 'tab-register' : 'tab-signin');
  submit.textContent = registering ? 'Create account' : 'Sign in';
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
  passwordHint.hidden = !registering;
  say('');

  // The invite field only appears when the server actually wants one.
  inviteField.hidden = !(registering && serverWantsInvite);
}

function say(text, kind = 'error') {
  message.textContent = text;
  message.className = 'form-message' + (text ? ' ' + kind : '');
}

let serverWantsInvite = true;

async function loadServerConfig() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    serverWantsInvite = health.registration === 'invite';
    if (health.registration === 'closed') {
      tabRegister.hidden = true;
    }
  } catch {
    // Leave the default; the server will reject a missing code anyway.
  }
}

function showSignedIn(user) {
  const initial = (user.displayName || user.username || '?').trim().charAt(0).toUpperCase();
  card.innerHTML = `
    <div class="signed-in">
      <div class="avatar">${initial}</div>
      <h3 style="margin:0 0 4px;font-weight:500">Signed in as ${escapeHtml(user.displayName || user.username)}</h3>
      <p style="margin:0 0 20px;color:var(--on-surface-muted);font-size:15px">
        Your subscriptions and playback position sync to this account.
      </p>
      <a class="btn btn-primary" href="/app/" style="width:100%">Open the web app</a>
      <button class="btn btn-ghost" id="sign-out" style="width:100%;margin-top:10px">Sign out</button>
    </div>`;

  navCta.textContent = 'Open app';
  navCta.setAttribute('href', '/app/');

  document.getElementById('sign-out').addEventListener('click', async () => {
    await account.signOut();
    location.reload();
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = passwordInput.value;
  const invite = document.getElementById('invite').value.trim();

  if (!username || !password) return say('Fill in both fields.');

  submit.disabled = true;
  submit.textContent = mode === 'register' ? 'Creating…' : 'Signing in…';
  say('');

  try {
    const user = mode === 'register'
      ? await account.register(username, password, invite, username)
      : await account.signIn(username, password);
    say('Signed in. Taking you to the app…', 'ok');
    location.href = nextTarget();
    return;
  } catch (error) {
    say(error.message || 'That did not work.');
  } finally {
    submit.disabled = false;
    submit.textContent = mode === 'register' ? 'Create account' : 'Sign in';
  }
});

tabSignIn.addEventListener('click', () => setMode('signin'));
tabRegister.addEventListener('click', () => setMode('register'));

// Keyboard pattern for tabs: Left/Right (and Home/End) switch and move focus.
for (const tab of [tabSignIn, tabRegister]) {
  tab.addEventListener('keydown', (event) => {
    if (tabRegister.hidden) return;
    let target = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      target = tab === tabSignIn ? tabRegister : tabSignIn;
    } else if (event.key === 'Home') {
      target = tabSignIn;
    } else if (event.key === 'End') {
      target = tabRegister;
    }
    if (!target) return;
    event.preventDefault();
    setMode(target === tabRegister ? 'register' : 'signin');
    target.focus();
  });
}

// ---- APK details ------------------------------------------------------------

const BYTES = ['bytes', 'KB', 'MB', 'GB'];

function formatBytes(bytes) {
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1000 && unit < BYTES.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(unit >= 2 ? 1 : 0)} ${BYTES[unit]}`;
}

/**
 * A bare YYYY-MM-DD parses as UTC midnight, which renders as the previous day
 * anywhere west of Greenwich. Build it as a local date instead.
 */
function formatDate(iso, month = 'short') {
  const [year, monthIndex, day] = iso.split('-').map(Number);
  return new Date(year, monthIndex - 1, day).toLocaleDateString(undefined, {
    year: 'numeric', month, day: 'numeric',
  });
}

/**
 * The release date doubles as the way into the update history. Clicking it
 * drops down a short list of update dates; picking one opens a pop-up with
 * everything that changed that day. With no history file it stays plain text.
 */
async function releaseDate(iso) {
  let history = [];
  try {
    const response = await fetch('/download/changelog.json', { cache: 'no-cache' });
    if (response.ok) history = await response.json();
  } catch {
    // No history to show; the date still reads fine on its own.
  }
  history = Array.isArray(history)
    ? history.filter((entry) => entry && entry.date && Array.isArray(entry.sections))
    : [];
  if (history.length === 0) {
    return formatDate(iso);
  }

  const wrapper = document.createElement('span');
  wrapper.className = 'date-menu';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'date-toggle';
  toggle.textContent = formatDate(iso);
  toggle.setAttribute('aria-label', `${toggle.textContent}, see the update history`);
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'update-menu');

  const menu = document.createElement('div');
  menu.id = 'update-menu';
  menu.className = 'update-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Updates');
  menu.hidden = true;

  const dialog = buildUpdateDialog();
  const items = history.map((entry) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    item.textContent = formatDate(entry.date);
    if (entry.version) {
      const version = document.createElement('span');
      version.className = 'update-version';
      version.textContent = entry.version;
      item.append(' ', version);
    }
    item.addEventListener('click', () => {
      closeMenu(false);
      showUpdate(dialog, entry, toggle);
    });
    menu.appendChild(item);
    return item;
  });

  function openMenu() {
    menu.hidden = false;
    menu.classList.remove('align-right');
    // On a narrow phone the date sits far right; open leftwards instead of off-screen.
    if (menu.getBoundingClientRect().right > document.documentElement.clientWidth - 16) {
      menu.classList.add('align-right');
    }
    toggle.setAttribute('aria-expanded', 'true');
    items[0].focus();
    document.addEventListener('pointerdown', outside, true);
  }
  function closeMenu(returnFocus = true) {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (returnFocus) toggle.focus();
  }
  function outside(event) {
    if (!wrapper.contains(event.target)) closeMenu(false);
  }

  toggle.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  toggle.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && menu.hidden) {
      event.preventDefault();
      openMenu();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const index = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      closeMenu(event.key === 'Escape');
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });

  wrapper.append(toggle, menu);
  return wrapper;
}

/** One pop-up, reused for whichever update is picked. */
function buildUpdateDialog() {
  const dialog = document.createElement('dialog');
  dialog.className = 'update-dialog';
  dialog.setAttribute('aria-labelledby', 'update-title');
  dialog.innerHTML = `
    <div class="update-head">
      <div>
        <p class="update-date" id="update-date"></p>
        <h2 id="update-title"></h2>
      </div>
      <button type="button" class="update-close" aria-label="Close">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/></svg>
      </button>
    </div>
    <div class="update-body" id="update-body"></div>`;
  dialog.querySelector('.update-close').addEventListener('click', () => dialog.close());
  // A click on the dimmed backdrop lands on the dialog element itself.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.appendChild(dialog);
  return dialog;
}

function showUpdate(dialog, entry, returnTo) {
  dialog.querySelector('#update-date').textContent = formatDate(entry.date, 'long')
    + (entry.version ? ` · Version ${entry.version}` : '');
  dialog.querySelector('#update-title').textContent = entry.title || 'What changed';

  const body = dialog.querySelector('#update-body');
  body.textContent = '';
  for (const section of entry.sections) {
    if (!section || !Array.isArray(section.items)) continue;
    const heading = document.createElement('h3');
    heading.textContent = section.heading || '';
    const list = document.createElement('ul');
    for (const text of section.items) {
      const item = document.createElement('li');
      item.textContent = String(text);
      list.appendChild(item);
    }
    body.append(heading, list);
  }

  dialog.addEventListener('close', () => returnTo.focus(), { once: true });
  dialog.showModal();
  body.scrollTop = 0;
}

async function loadRelease() {
  const meta = document.getElementById('apk-meta');
  const link = document.getElementById('apk-link');
  try {
    const response = await fetch('/download/release.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('missing');
    const release = await response.json();

    if (release.file) link.setAttribute('href', `/download/${release.file}`);

    const parts = [];
    if (release.version) parts.push(`Version ${release.version}`);
    if (release.size) parts.push(formatBytes(release.size));

    meta.textContent = '';
    const summary = document.createElement('div');
    summary.textContent = parts.join(' · ');
    meta.appendChild(summary);

    if (release.released) {
      if (parts.length) summary.append(' · ');
      summary.append(await releaseDate(release.released));
    }
  } catch {
    meta.textContent = 'Build details unavailable — the download link still works.';
  }
}

// ---- boot -------------------------------------------------------------------

(async function boot() {
  await loadServerConfig();
  setMode('signin');
  loadRelease();

  const user = await account.currentUser();
  if (user) showSignedIn(user);
})();
