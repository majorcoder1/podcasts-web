// Landing page: sign in or create an account, and surface the current APK build.

import * as account from './account.js';

const form = document.getElementById('auth-form');
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
    if (release.released) {
      // A bare YYYY-MM-DD parses as UTC midnight, which renders as the previous
      // day anywhere west of Greenwich. Build it as a local date instead.
      const [year, month, day] = release.released.split('-').map(Number);
      parts.push(new Date(year, month - 1, day).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
      }));
    }
    meta.textContent = '';
    const summary = document.createElement('div');
    summary.textContent = parts.join(' · ');
    meta.appendChild(summary);

    if (release.sha256) {
      const line = document.createElement('div');
      line.style.cssText = 'margin-top:6px;word-break:break-all;font-size:11px;opacity:.75';
      line.textContent = `SHA-256 ${release.sha256}`;
      meta.appendChild(line);
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
