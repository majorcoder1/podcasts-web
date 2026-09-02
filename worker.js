/**
 * Cloudflare Worker adapter - the serverless equivalent of server.py.
 *
 * Serves the static site from the ASSETS binding and answers the same /api/*
 * routes, so the front end is byte-identical on either backend.
 *
 *   wrangler deploy
 */

const USER_AGENT = 'PodcastsWeb/1.0 (+https://github.com/)';
const ITUNES_SEARCH = 'https://itunes.apple.com/search';
const ITUNES_CHARTS = 'https://itunes.apple.com/us/rss/toppodcasts';
const MAX_FEED_BYTES = 12 * 1024 * 1024;

/**
 * Workers cannot reach RFC1918 space, but a visitor-supplied URL should still
 * never name an internal host or a non-http scheme.
 */
function assertAllowed(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'That is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Only http and https URLs are allowed');
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host === '[::1]' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new HttpError(403, 'That host is not publicly routable');
  return url;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function upstream(url, accept) {
  assertAllowed(url);
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    redirect: 'follow',
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new HttpError(502, `Upstream returned ${response.status}`);
  return response;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function clampInt(raw, low, high, fallback) {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(value) ? fallback : Math.min(high, Math.max(low, value));
}

async function handleApi(url) {
  const params = url.searchParams;

  if (url.pathname === '/api/feed') {
    const feed = params.get('url');
    if (!feed) throw new HttpError(400, 'Missing url');
    const response = await upstream(feed, 'application/rss+xml, application/xml, text/xml, */*');
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_FEED_BYTES) throw new HttpError(502, 'Upstream response too large');
    return new Response(body, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  if (url.pathname === '/api/search') {
    const term = (params.get('q') || '').trim();
    if (!term) return json({ results: [] });
    const limit = clampInt(params.get('limit'), 1, 200, 50);
    const target = `${ITUNES_SEARCH}?${new URLSearchParams({
      term,
      media: 'podcast',
      entity: 'podcast',
      limit: String(limit),
    })}`;
    const response = await upstream(target, 'application/json');
    return new Response(response.body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      },
    });
  }

  if (url.pathname === '/api/charts') {
    const genre = (params.get('genre') || '').trim();
    const limit = clampInt(params.get('limit'), 1, 100, 30);
    let target = `${ITUNES_CHARTS}/limit=${limit}`;
    if (/^\d+$/.test(genre)) target += `/genre=${genre}`;
    target += '/json';
    const response = await upstream(target, 'application/json');
    return new Response(response.body, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  if (url.pathname === '/api/audio') {
    const audio = params.get('url');
    if (!audio) throw new HttpError(400, 'Missing url');
    const response = await upstream(audio, 'audio/*');
    const type = response.headers.get('Content-Type') || '';
    if (!/^(audio|video)\/|application\/octet-stream/.test(type)) {
      throw new HttpError(415, 'That URL is not audio');
    }
    return new Response(response.body, {
      headers: {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  throw new HttpError(404, 'Unknown endpoint');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'Method not allowed' }, 405);
      }
      try {
        return await handleApi(url);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        return json({ error: error.message || 'Internal error' }, status);
      }
    }

    // Everything else is the static site; unknown paths render the SPA shell.
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) {
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    }
    return asset;
  },
};
