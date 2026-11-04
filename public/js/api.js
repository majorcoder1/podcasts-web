// Feeds and audio go through the same-origin proxy (api.php or server.py):
// they send no CORS headers, so the browser cannot fetch them directly.
// Search and charts go through it too, to Podcast Index (Apple as a fallback).

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
 * Ask our own server first: it searches Podcast Index when the host has keys
 * for it. Apple's directory, which browsers can call directly, is only the
 * fallback now - it has begun refusing requests outright.
 */
async function directory(directUrl, proxyPath) {
  try {
    return await getJson(proxyPath);
  } catch (proxyError) {
    try {
      const response = await fetch(directUrl, { headers: { Accept: 'application/json' } });
      if (response.ok) return await response.json();
    } catch {
      // Fall through to the server's own error, which says more.
    }
    throw proxyError;
  }
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

  // Podcast Index answers with shows ready to use; Apple's chart lists only
  // names, each of which costs another search to resolve.
  if (Array.isArray(payload.results)) {
    return dedupe(payload.results.map(toResult).filter(Boolean)).slice(0, limit);
  }

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
