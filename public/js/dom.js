// Minimal DOM helpers. The app renders HTML strings and wires events by
// delegation, which keeps every view a plain function of its data.

export function html(strings, ...values) {
  return strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '');
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The glyph shown when a cover is missing or fails to load. */
const ART_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12,2A5,5 0 0,0 7,7V13A5,5 0 0,0 17,13V7A5,5 0 0,0 12,2M12,4A3,3 0 0,1 15,7V13A3,3 0 0,1 9,13V7A3,3 0 0,1 12,4M5,12H3A9,9 0 0,0 11,20.94V23H13V20.94A9,9 0 0,0 21,12H19A7,7 0 0,1 5,12Z"/></svg>';

/**
 * Square art with a glyph fallback, matching the Android ShowArt component.
 *
 * The fallback keeps the same class as the image it stands in for. Sizing is
 * per-context - the mini player wants 40px, a shelf tile 116px - so a fallback
 * that dropped the class would collapse to nothing and drag the layout with it.
 */
export function art(imageUrl, alt, className = 'art') {
  if (!imageUrl) {
    return `<div class="${className} art-fallback" role="img" aria-label="${escapeHtml(alt)}">${ART_GLYPH}</div>`;
  }
  return `<img class="${className}" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />`;
}

/**
 * Swap a broken cover for the fallback.
 *
 * Done with one delegated listener rather than an onerror attribute: the
 * Content-Security-Policy on the deployed site blocks inline handlers, so the
 * attribute version silently never ran. `error` does not bubble, hence capture.
 */
document.addEventListener(
  'error',
  (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('art')) return;
    const fallback = document.createElement('div');
    fallback.className = `${img.className} art-fallback`;
    fallback.setAttribute('role', 'img');
    fallback.setAttribute('aria-label', img.alt || '');
    fallback.innerHTML = ART_GLYPH;
    img.replaceWith(fallback);
  },
  true,
);

let toastTimer = null;

export function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

/** One delegated listener per screen beats hundreds of per-row handlers. */
export function onAction(root, handlers) {
  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || !root.contains(target)) return;
    const handler = handlers[target.dataset.action];
    if (!handler) return;
    event.preventDefault();
    event.stopPropagation();
    handler(target.dataset, target, event);
  });
}
