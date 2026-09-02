import * as store from '../store.js';
import * as downloads from '../downloads.js';
import { buildOpml, parseOpml } from '../opml.js';
import { topBar } from '../components.js';
import { escapeHtml, toast } from '../dom.js';
import { formatSpeed } from '../format.js';
import { PLAYBACK_SPEEDS } from '../player.js';

const SKIP_FORWARD = [10, 15, 30, 45, 60];
const SKIP_BACK = [5, 10, 15, 30];
const PER_SHOW = [1, 2, 3, 5, 10];
const EXPIRY_DAYS = [0, 7, 14, 30, 90];
const REFRESH_HOURS = [1, 3, 6, 12, 24];
const THEMES = ['system', 'light', 'dark'];

const cycle = (options, current) => options[(options.indexOf(current) + 1) % options.length];

export async function render(root, ctx) {
  const settings = await store.getSettings();
  const used = await downloads.usedBytes();

  const row = (action, title, subtitle) => `
    <button class="setting" data-action="${action}">
      <span class="label"><strong>${escapeHtml(title)}</strong>${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}</span>
    </button>`;

  const toggle = (action, title, checked, subtitle) => `
    <button class="setting" data-action="${action}">
      <span class="label"><strong>${escapeHtml(title)}</strong>${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}</span>
      <span class="switch" role="switch" aria-checked="${checked}"></span>
    </button>`;

  root.innerHTML = `
    ${topBar('Settings', '')}
    <div class="settings-group">Playback</div>
    ${row('speed', 'Default playback speed', formatSpeed(settings.defaultSpeed))}
    ${row('skipForward', 'Skip forward', `${settings.skipForwardSeconds} seconds`)}
    ${row('skipBack', 'Skip back', `${settings.skipBackSeconds} seconds`)}
    ${toggle('autoPlayNext', 'Continuous playback', settings.autoPlayNext, 'Play the next episode in your queue automatically')}

    <hr />
    <div class="settings-group">Downloads</div>
    ${toggle('autoDownload', 'Auto download new episodes', settings.autoDownloadEnabled)}
    ${row('perShow', 'Keep per show', `${settings.autoDownloadLimitPerShow} episodes`)}
    ${toggle('removeWhenPlayed', 'Remove downloads when played', settings.removeDownloadWhenPlayed)}
    ${row('expiry', 'Remove downloads after', settings.removeDownloadAfterDays ? `${settings.removeDownloadAfterDays} days` : 'Never')}
    ${row('removeAll', 'Remove all downloads', used ? `${(used / 1e6).toFixed(0)} MB stored on this device` : 'Nothing downloaded')}

    <hr />
    <div class="settings-group">Subscriptions</div>
    ${row('refresh', 'Refresh interval', `Every ${settings.refreshIntervalHours} hours`)}
    ${row('refreshNow', 'Refresh now', 'Check every subscription for new episodes')}
    ${row('import', 'Import subscriptions', 'From an OPML file')}
    ${row('export', 'Export subscriptions', 'To an OPML file')}

    <hr />
    <div class="settings-group">Appearance</div>
    ${row('theme', 'Theme', { system: 'System default', light: 'Light', dark: 'Dark' }[settings.theme])}

    <hr />
    <div class="settings-group">About</div>
    <div class="setting"><span class="label">
      <strong>Storage</strong>
      <span id="quota">Checking available space…</span>
    </span></div>
    <input id="opml-input" type="file" accept=".opml,.xml,text/xml,application/xml" hidden />`;

  reportQuota(root);

  ctx.onAction(root, {
    speed: async () => {
      await store.setSetting('defaultSpeed', cycle(PLAYBACK_SPEEDS, settings.defaultSpeed));
      render(root, ctx);
    },
    skipForward: async () => {
      await store.setSetting('skipForwardSeconds', cycle(SKIP_FORWARD, settings.skipForwardSeconds));
      render(root, ctx);
    },
    skipBack: async () => {
      await store.setSetting('skipBackSeconds', cycle(SKIP_BACK, settings.skipBackSeconds));
      render(root, ctx);
    },
    autoPlayNext: async () => {
      await store.setSetting('autoPlayNext', !settings.autoPlayNext);
      render(root, ctx);
    },
    autoDownload: async () => {
      await store.setSetting('autoDownloadEnabled', !settings.autoDownloadEnabled);
      render(root, ctx);
    },
    perShow: async () => {
      await store.setSetting('autoDownloadLimitPerShow', cycle(PER_SHOW, settings.autoDownloadLimitPerShow));
      render(root, ctx);
    },
    removeWhenPlayed: async () => {
      await store.setSetting('removeDownloadWhenPlayed', !settings.removeDownloadWhenPlayed);
      render(root, ctx);
    },
    expiry: async () => {
      await store.setSetting('removeDownloadAfterDays', cycle(EXPIRY_DAYS, settings.removeDownloadAfterDays));
      render(root, ctx);
    },
    removeAll: async () => {
      await downloads.removeAll();
      toast('Downloads removed');
      render(root, ctx);
    },
    refresh: async () => {
      await store.setSetting('refreshIntervalHours', cycle(REFRESH_HOURS, settings.refreshIntervalHours));
      render(root, ctx);
    },
    refreshNow: async () => {
      toast('Refreshing subscriptions…');
      const fresh = await store.refreshAllSubscriptions();
      toast(fresh.length ? `${fresh.length} new episode${fresh.length === 1 ? '' : 's'}` : 'Everything is up to date');
    },
    theme: async () => {
      const next = cycle(THEMES, settings.theme);
      await store.setSetting('theme', next);
      ctx.applyTheme(next);
      render(root, ctx);
    },
    import: () => root.querySelector('#opml-input')?.click(),
    export: async () => {
      const shows = await store.subscriptions();
      if (!shows.length) return toast('No subscriptions to export');
      download('subscriptions.opml', buildOpml(shows), 'text/xml');
      toast(`Exported ${shows.length} subscriptions`);
    },
  });

  root.querySelector('#opml-input')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const entries = parseOpml(await file.text());
      if (!entries.length) return toast('That file had no feeds in it');
      toast(`Importing ${entries.length} shows…`);
      const settled = await Promise.allSettled(entries.map((entry) => store.subscribe(entry.feedUrl)));
      const ok = settled.filter((outcome) => outcome.status === 'fulfilled').length;
      toast(`Imported ${ok} of ${entries.length} shows`);
      render(root, ctx);
    } catch (error) {
      toast(error.message);
    }
  });
}

async function reportQuota(root) {
  const node = root.querySelector('#quota');
  if (!node || !navigator.storage?.estimate) {
    if (node) node.textContent = 'This browser does not report storage limits';
    return;
  }
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  node.textContent = quota
    ? `${(usage / 1e6).toFixed(0)} MB used of ${(quota / 1e9).toFixed(1)} GB available`
    : 'Storage limits unavailable';
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
