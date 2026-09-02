// Display formatters, matching the phrasing the Android build uses.

export function formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms / 60000) % 60;
  if (hours > 0 && minutes > 0) return `${hours} hr ${minutes} min`;
  if (hours > 0) return `${hours} hr`;
  if (minutes > 0) return `${minutes} min`;
  return '1 min';
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

export function formatRemaining(ms) {
  const text = formatDuration(ms);
  return text ? `${text} left` : '';
}

const DAY = 86400000;

export function formatEpisodeDate(timestamp, now = Date.now()) {
  if (!timestamp) return '';
  const then = new Date(timestamp);
  const today = new Date(now);
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(today) - midnight(then)) / DAY);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return then.toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = then.getFullYear() === today.getFullYear();
  return then.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

export function formatSpeed(speed) {
  return Number.isInteger(speed) ? `${speed}x` : `${speed.toFixed(1)}x`;
}

/** Feed descriptions arrive as HTML; episode rows want one flat line of text. */
export function stripHtml(raw) {
  if (!raw) return '';
  const doc = new DOMParser().parseFromString(
    raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n'),
    'text/html',
  );
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
