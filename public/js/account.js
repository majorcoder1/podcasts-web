// Account client. The browser authenticates with an HttpOnly cookie the server
// sets at login, so nothing here ever touches a token - which also means an XSS
// cannot read one out of storage.

async function call(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

let cached;

/** @returns the signed-in user, or null. */
export async function currentUser({ force = false } = {}) {
  if (!force && cached !== undefined) return cached;
  try {
    const payload = await call('/api/me');
    cached = payload.user || null;
  } catch {
    cached = null;
  }
  return cached;
}

export async function signIn(username, password) {
  const payload = await call('/api/login', { username, password, device: 'web' });
  cached = payload.user;
  return cached;
}

export async function register(username, password, inviteCode, displayName) {
  const payload = await call('/api/register', {
    username,
    password,
    inviteCode,
    displayName,
    device: 'web',
  });
  cached = payload.user;
  return cached;
}

export async function signOut() {
  await call('/api/logout', {});
  cached = null;
}

export async function changePassword(currentPassword, newPassword) {
  return call('/api/password', { currentPassword, newPassword });
}
