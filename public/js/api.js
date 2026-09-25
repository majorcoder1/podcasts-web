// Feeds and audio go through the same-origin proxy (api.php or server.py):
// they send no CORS headers, so the browser cannot fetch them directly.
// Apple's directory does, so search and charts go straight to it.

async function getJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Request failed (${response.status})`);
  }
  return response.json();
}

export async function fetchFeed(feedUrl) {
  const response = await fetch(`/api/feed?url=${encodeURIComponent(feedUrl)}`);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Could not load feed (${response.status})`);
  }
  return response.text();
}

export function audioProxyUrl(audioUrl) {
  return `/api/audio?url=${encodeURIComponent(audioUrl)}`;
}

function toResult(entry) {
  if (!entry.feedUrl) return null;
  return {
    feedUrl: entry.feedUrl,
    title: entry.collectionName || '',
    author: entry.artistName || '',
    imageUrl: entry.artworkUrl600 || entry.artworkUrl100 || null,
    trackCount: entry.trackCount || 0,
    genre: entry.primaryGenreName || null,
  };
}

/**
 * A feed URL is the show's identity, so a result list must never carry it
 * twice - the directory does list some shows under more than one collection.
 */
function dedupe(results) {
  const seen = new Set();
  return results.filter((item) => {
    if (!item || seen.has(item.feedUrl)) return false;
    seen.add(item.feedUrl);
    return true;
  });
}

/**
 * Apple's directory answers browsers directly (it sends CORS headers), and it
 * refuses many hosting companies' servers, so ask it from here first and use
 * our own proxy only if the direct call fails.
 */
async function directory(directUrl, proxyPath) {
  try {
    const response = await fetch(directUrl, { headers: { Accept: 'application/json' } });
    if (response.ok) return await response.json();
  } catch {
    // Blocked or offline; the proxy gets a turn.
  }
  return getJson(proxyPath);
}

export async function search(term, limit = 50) {
  if (!term.trim()) return [];
  const query = new URLSearchParams({ term, media: 'podcast', entity: 'podcast', limit: String(limit) });
  const payload = await directory(
    `https://itunes.apple.com/search?${query}`,
    `/api/search?q=${encodeURIComponent(term)}&limit=${limit}`,
  );
  return dedupe((payload.results || []).map(toResult));
}

/**
 * The chart endpoint returns show names rather than feed URLs, so each name is
 * resolved through search. Requests run in parallel and failures drop out.
 */
export async function topShows(genreId, limit = 24) {
  const query = genreId ? `?genre=${genreId}&limit=${limit}` : `?limit=${limit}`;
  const direct = `https://itunes.apple.com/us/rss/toppodcasts/limit=${limit}`
    + (genreId ? `/genre=${genreId}` : '') + '/json';
  const payload = await directory(direct, `/api/charts${query}`);
  const names = (payload.feed?.entry || [])
    .map((entry) => entry['im:name']?.label)
    .filter(Boolean);

  const settled = await Promise.allSettled(
    names.slice(0, limit).map((name) => search(name, 1)),
  );
  return dedupe(
    settled
      .filter((outcome) => outcome.status === 'fulfilled')
      .flatMap((outcome) => outcome.value),
  );
}

export const CATEGORIES = [
  { label: 'Top shows', genreId: null },
  { label: 'News', genreId: 1489 },
  { label: 'Comedy', genreId: 1303 },
  { label: 'True crime', genreId: 1488 },
  { label: 'Sports', genreId: 1545 },
  { label: 'Society & culture', genreId: 1324 },
  { label: 'Business', genreId: 1321 },
  { label: 'Technology', genreId: 1318 },
  { label: 'Health & fitness', genreId: 1512 },
  { label: 'Religion & spirituality', genreId: 1314 },
  { label: 'History', genreId: 1487 },
  { label: 'Education', genreId: 1304 },
];
