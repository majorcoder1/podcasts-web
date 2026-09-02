# Podcasts — web

A podcast player for the browser, rebuilding the feature set and interaction
model of Google Podcasts, which shut down in 2024. Companion to the Android
build; same app, same layout, same behaviour.

Deployed at **podcast.4thepeople.live**.

This is original code. Google Podcasts was never open source and none of its
code, assets, or branding are used here — it runs on RSS, which is what the
original ran on too.

## What it does

**Shell** — three tabs (Home, Explore, Activity), mini player docked above them,
full player that slides up from it.

**Home** — subscriptions strip, queue, Continue listening, New episodes.

**Explore** — search-as-you-type, category chips, and pasting an RSS URL opens
that feed directly.

**Activity** — Queue, Downloads, History.

**Show page** — art, description, Subscribe, newest/oldest sort, per-show
auto-download.

**Player** — scrubber, back 10 / forward 30, speed 0.5x–3x, sleep timer with the
5/10/15/30/45/60-minute presets plus end-of-episode, and OS-level controls
(lock screen, headset buttons, media keys) through the Media Session API.

**Offline** — episodes download into the Cache API and play from there; the app
shell is served by a service worker, so it opens with no network.

**Data** — everything lives in IndexedDB on the device. OPML import and export,
so an export from the original app imports here directly.

## Why there is a server at all

Podcast feeds do not send CORS headers, so a browser cannot fetch them. A static
site alone therefore cannot read a single feed. Everything network-facing goes
through a small same-origin proxy:

| Route | Purpose |
| --- | --- |
| `/api/feed?url=` | Fetches and caches a feed for 5 minutes |
| `/api/search?q=` | Directory search |
| `/api/charts?genre=` | Category charts |
| `/api/audio?url=` | Only for downloads — streaming plays straight from the publisher |
| `/api/health` | Reports what the host supports; check it first after uploading |

The proxy refuses non-http(s) schemes and any host that resolves to private,
loopback or link-local space, re-checking on every redirect hop. Without that, a
public `?url=` endpoint would let any visitor probe the machine's own network.

## Deploying

The front end is the same everywhere; only the proxy differs. Three backends
ship, in the order you are most likely to want them.

### Shared hosting — what podcast.4thepeople.live runs on

`public/` is the whole site: static files plus `api.php`, the proxy. No daemon,
no root, no Node. Works on any host with PHP and `.htaccess`.

**First, give the subdomain its own document root.** Right now
`podcast.4thepeople.live` is served by wildcard DNS and shows the apex site.
In the hosting control panel add it as a subdomain pointing at a new folder,
e.g. `/public_html/podcast/`.

> Do not upload into the existing web root. The apex serves another site and
> these files would land on top of it.

Then upload the *contents* of `public/` into that folder — `index.html` must sit
at the folder's top level, not inside a nested `public/`.

**Check the host before anything else:**

```bash
curl -s https://podcast.4thepeople.live/api/health
```

That reports the PHP version, whether cURL is available, and whether the feed
cache directory is writable. `"curl": true` is the one that matters; the code
falls back to streams, but only if `allow_url_fopen` is on.

If `.htaccess` is ignored (some hosts run nginx), the rewrites will not fire and
the app will 404 on refresh. Say so and the routes can move to query strings
instead.

### VPS with root

```bash
python3 server.py --port 8080
```

Behind `deploy/Caddyfile` or `deploy/nginx.conf`, running under
`deploy/podcast-web.service`. Zero dependencies, Python 3.9+.

### Cloudflare

`worker.js` answers the same routes and serves `public/` from the assets
binding. Note this moves the domain's DNS to Cloudflare, away from
`serverbyt.net`.

```bash
npx wrangler deploy
```

## Front end

No build step and no framework — ES modules served as-is, so deploying is
copying `public/`.

```
public/
├── index.html, sw.js, manifest.webmanifest, icon.svg
├── api.php, .htaccess   the shared-hosting backend
├── styles/app.css
└── js/
    ├── main.js        router, shared episode actions
    ├── chrome.js      bottom nav, mini player, full player
    ├── store.js       repositories over IndexedDB
    ├── db.js          IndexedDB wrapper
    ├── feed.js        RSS/iTunes parsing
    ├── api.js         proxy client
    ├── player.js      audio element, Media Session, sleep timer
    ├── downloads.js   Cache API offline storage
    ├── opml.js, format.js, dom.js, icons.js, components.js
    └── views/         home, explore, activity, show, settings
```

Assets are served `no-cache` with ETags, so a redeploy reaches everyone on their
next request instead of waiting out a max-age, and the service worker installs
with `cache: 'reload'` for the same reason.

## Differences from the Android build

Not omissions — things the platform decides:

- **Background refresh** happens while the tab is open and when it regains
  focus. Browsers do not grant a web app a true background scheduler.
- **Skip silence** is not here. It needs sample-level analysis, which requires
  routing audio through Web Audio, which taints on cross-origin media. Adding it
  would mean proxying every stream — a lot of bandwidth for one setting.
- **Auto-download** is applied on refresh rather than by a background job.
- **Storage** is subject to browser eviction. Settings shows the quota.

## Licence

Apache 2.0.
