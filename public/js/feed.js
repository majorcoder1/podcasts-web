// RSS 2.0 / iTunes-namespace parsing via DOMParser.

import { stripHtml } from './format.js';

const ITUNES_NS = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/';

/** XML documents index by qualified name; namespace lookup is the fallback. */
function child(parent, name, namespace) {
  const direct = parent.getElementsByTagName(name)[0];
  if (direct) return direct;
  if (namespace) {
    const local = name.includes(':') ? name.split(':')[1] : name;
    return parent.getElementsByTagNameNS(namespace, local)[0];
  }
  return undefined;
}

function text(parent, name, namespace) {
  const node = child(parent, name, namespace);
  return node ? (node.textContent || '').trim() : '';
}

function directChildren(parent, name) {
  return Array.from(parent.children).filter(
    (node) => node.tagName === name || node.localName === name,
  );
}

/** iTunes duration is "SS", "MM:SS" or "HH:MM:SS". */
export function parseDuration(raw) {
  if (!raw) return 0;
  const parts = raw.trim().split(':').map((piece) => Number(piece.trim()));
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 1) return parts[0] * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return 0;
}

export function parseDate(raw) {
  if (!raw) return 0;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function parseFeed(feedUrl, xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('That feed is not valid XML');
  }

  const channel = doc.querySelector('channel') || doc.querySelector('feed');
  if (!channel) throw new Error('That URL is not a podcast feed');

  const channelImage =
    child(channel, 'itunes:image', ITUNES_NS)?.getAttribute('href') ||
    text(child(channel, 'image') || channel, 'url') ||
    null;

  const title = directChildren(channel, 'title')[0]?.textContent?.trim() || '';
  if (!title) throw new Error('That feed has no title');

  const podcast = {
    feedUrl,
    title,
    author: text(channel, 'itunes:author', ITUNES_NS) || text(channel, 'managingEditor'),
    description: stripHtml(
      text(channel, 'description') || text(channel, 'itunes:summary', ITUNES_NS),
    ),
    imageUrl: channelImage,
    link: directChildren(channel, 'link')[0]?.textContent?.trim() || null,
    categories: Array.from(channel.getElementsByTagName('itunes:category'))
      .concat(Array.from(channel.getElementsByTagNameNS(ITUNES_NS, 'category')))
      .map((node) => node.getAttribute('text'))
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index),
  };

  const items = Array.from(doc.getElementsByTagName('item'));
  const episodes = items
    .map((item) => parseItem(item, feedUrl, channelImage))
    .filter(Boolean)
    .sort((a, b) => b.publishedAt - a.publishedAt);

  return { podcast, episodes };
}

function parseItem(item, feedUrl, fallbackImage) {
  const enclosure =
    Array.from(item.getElementsByTagName('enclosure')).find((node) =>
      (node.getAttribute('type') || '').startsWith('audio'),
    ) || item.getElementsByTagName('enclosure')[0];

  const audioUrl = enclosure?.getAttribute('url');
  if (!audioUrl) return null;

  const itemImage =
    child(item, 'itunes:image', ITUNES_NS)?.getAttribute('href') || fallbackImage || null;

  const guidNode = directChildren(item, 'guid')[0];

  return {
    // Feeds without a <guid> are common; the audio URL is the stable fallback.
    guid: guidNode?.textContent?.trim() || audioUrl,
    feedUrl,
    title: directChildren(item, 'title')[0]?.textContent?.trim() || 'Untitled episode',
    description: stripHtml(
      text(item, 'content:encoded', CONTENT_NS) ||
        text(item, 'itunes:summary', ITUNES_NS) ||
        text(item, 'description'),
    ),
    audioUrl,
    imageUrl: itemImage,
    publishedAt: parseDate(text(item, 'pubDate')),
    durationMs: parseDuration(text(item, 'itunes:duration', ITUNES_NS)),
    positionMs: 0,
    isCompleted: false,
    isArchived: false,
    downloadState: 'NOT_DOWNLOADED',
    fileSizeBytes: Number(enclosure?.getAttribute('length')) || 0,
    seasonNumber: Number(text(item, 'itunes:season', ITUNES_NS)) || null,
    episodeNumber: Number(text(item, 'itunes:episode', ITUNES_NS)) || null,
    lastPlayedAt: 0,
  };
}

/** Google Podcasts treated an episode as finished at 95% or with <30s to go. */
export function effectivelyFinished(episode) {
  if (episode.isCompleted) return true;
  if (!episode.durationMs) return false;
  return (
    episode.positionMs >= episode.durationMs - 30000 ||
    episode.positionMs / episode.durationMs >= 0.95
  );
}

export function hasStarted(episode) {
  return episode.positionMs > 0 && !effectivelyFinished(episode);
}

export function progress(episode) {
  if (!episode.durationMs) return 0;
  return Math.min(1, Math.max(0, episode.positionMs / episode.durationMs));
}

export function remainingMs(episode) {
  return Math.max(0, (episode.durationMs || 0) - (episode.positionMs || 0));
}
