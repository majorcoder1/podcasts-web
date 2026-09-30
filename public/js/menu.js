// Bottom-sheet menu.
//
// Built on <dialog> so focus trapping, Escape and the backdrop come from the
// platform rather than being re-implemented badly. No inline handlers, so it
// survives the site's Content-Security-Policy.

import { escapeHtml } from './dom.js';
import { icon } from './icons.js';

/**
 * @param {object} options
 * @param {string} options.title     heading, usually the episode name
 * @param {string} [options.subtitle]
 * @param {Array<{icon: string, label: string, action: function, danger?: boolean}>} options.items
 */
export function openSheet({ title, subtitle, items }) {
  // Only ever one sheet at a time, whatever the caller does.
  document.querySelectorAll('dialog.sheet').forEach((open) => open.close());

  const sheet = document.createElement('dialog');
  sheet.className = 'sheet';
  sheet.setAttribute('aria-label', title);

  sheet.innerHTML = `
    <div class="sheet-grabber" aria-hidden="true"></div>
    <header class="sheet-head">
      <strong class="clamp-2">${escapeHtml(title)}</strong>
      ${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ''}
    </header>
    <ul class="sheet-items">
      ${items
        .map(
          (item, index) => `
        <li>
          <button type="button" data-index="${index}" class="${item.danger ? 'danger' : ''}">
            ${icon(item.icon)}<span>${escapeHtml(item.label)}</span>
          </button>
        </li>`,
        )
        .join('')}
    </ul>`;

  document.body.appendChild(sheet);
  sheet.showModal();

  sheet.addEventListener('click', (event) => {
    // A click on the dialog itself rather than its contents is the backdrop.
    if (event.target === sheet) {
      sheet.close();
      return;
    }
    const button = event.target.closest('button[data-index]');
    if (!button) return;
    const chosen = items[Number(button.dataset.index)];
    sheet.close();
    // Let the sheet finish closing before the action re-renders underneath it.
    // Deliberately a timeout rather than requestAnimationFrame: rAF only runs
    // while the page is painting, so in a background or throttled tab the menu
    // would close and the action would silently never happen.
    setTimeout(() => chosen.action(), 0);
  });

  sheet.addEventListener('close', () => sheet.remove());
  // close() on an already-closed dialog fires nothing, so clear any stragglers
  // rather than trusting every sheet to remove itself.
  document.querySelectorAll('dialog.sheet').forEach((other) => {
    if (other !== sheet && !other.open) other.remove();
  });
  return sheet;
}
