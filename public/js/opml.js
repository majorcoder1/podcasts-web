// OPML import and export - the same interchange format Google Podcasts'
// "Export subscriptions" produced, so an old export imports here directly.

export function parseOpml(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file is not valid OPML');

  const seen = new Set();
  return Array.from(doc.getElementsByTagName('outline'))
    .map((node) => ({
      feedUrl: node.getAttribute('xmlUrl'),
      title: node.getAttribute('text') || node.getAttribute('title') || '',
    }))
    .filter((entry) => {
      if (!entry.feedUrl || seen.has(entry.feedUrl)) return false;
      seen.add(entry.feedUrl);
      return true;
    });
}

export function buildOpml(podcasts) {
  const escape = (value) =>
    String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const outlines = podcasts
    .map(
      (podcast) =>
        `    <outline type="rss" text="${escape(podcast.title)}" ` +
        `title="${escape(podcast.title)}" xmlUrl="${escape(podcast.feedUrl)}"` +
        (podcast.link ? ` htmlUrl="${escape(podcast.link)}"` : '') +
        ' />',
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head>
    <title>Podcast subscriptions</title>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}
