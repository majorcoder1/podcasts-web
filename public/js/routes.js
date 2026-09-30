// Where a show lives in the address bar.
//
// The feed's own web address used to sit in the path percent-encoded, which
// puts %2F in the path - and the host's edge firewall answers 403 to any path
// containing an encoded slash, before the request reaches this app at all.
// Clicking through never noticed, because that only rewrites the address bar;
// a refresh, a bookmark or a shared link got the 403. Base64url has no slashes
// in it, so there is nothing left to block, and the link still carries the feed
// with it - no lookup table, so a link works on a device that has never seen
// the show.

export function showRoute(feedUrl) {
  return `/show/${encodeFeed(feedUrl)}`;
}

export function encodeFeed(feedUrl) {
  const bytes = new TextEncoder().encode(feedUrl);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeFeed(segment) {
  // Links made before this change are percent-encoded. The server rejects those
  // now, but the back button can still reach one from the history of a tab that
  // was already open, and going back never asks the server.
  if (segment.includes('%') || segment.includes(':')) return decodeURIComponent(segment);

  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
