# Podcasts — web

A podcast player for the browser, rebuilding the feature set and interaction
model of Google Podcasts, which shut down in 2024. Companion to the Android
build; same app, same layout, same behaviour.

Deployed at **podcast.4thpeople.live**.

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

The proxy refuses non-http(s) schemes and any host that resolves to private,
loopback or link-local space, re-checking on every redirect hop. Without that, a
public `?url=` endpoint would let any visitor probe the machine's own network.

## Deploying

Two backends, same front end. Pick one.

### Self-hosted (Python 3.9+, no dependencies)

```bash
python3 server.py --port 8080
```

Then put it behind TLS — `deploy/Caddyfile` or `deploy/nginx.conf` — and run it
under `deploy/podcast-web.service`:

```bash
sudo cp -r . /srv/podcast-web && sudo cp deploy/podcast-web.service /etc/systemd/system/ && sudo systemctl enable --now podcast-web
```

### Cloudflare

`worker.js` answers the same routes and serves `public/` from the assets
binding. Point the custom domain at it in `wrangler.toml`, then:

```bash
npx wrangler deploy
```

DNS either way: an `A`/`AAAA` record for `podcast` at `4thpeople.live` pointing
at the host, or the custom-domain binding if you go the Cloudflare route.

## Front end

No build step and no framework — ES modules served as-is, so deploying is
copying `public/`.

```
public/
├── index.html, sw.js, manifest.webmanifest, icon.svg
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
