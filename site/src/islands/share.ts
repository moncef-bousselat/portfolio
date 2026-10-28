/**
 * The share bar's two script-only buttons. Each stays hidden unless the
 * browser can do what it offers, so a visitor never meets a button that
 * fails: copy link needs the async Clipboard API, the share sheet needs the
 * Web Share API (phones, and some desktop browsers).
 *
 * The platform links need none of this; they are plain links.
 */

import { track } from '../lib/analytics';

/** How long the copy button shows its tick before going back. */
const DONE_MS = 2000;

function init(bar: HTMLElement): void {
  const url = bar.dataset.url;
  const title = bar.dataset.title ?? document.title;
  const status = bar.querySelector<HTMLElement>('[data-share-status]');
  if (!url || !status) return;

  const copyItem = bar.querySelector<HTMLElement>('[data-copy-item]');
  const copy = bar.querySelector<HTMLButtonElement>('[data-copy]');
  if (copyItem && copy && navigator.clipboard?.writeText) {
    copyItem.hidden = false;
    let timer: number | undefined;

    copy.addEventListener('click', async () => {
      // Clear first, so the same message is announced again on a repeat.
      status.textContent = '';
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        status.textContent = bar.dataset.copyFailed ?? '';
        return;
      }
      status.textContent = bar.dataset.copied ?? '';
      copy.dataset.done = '';
      window.clearTimeout(timer);
      timer = window.setTimeout(() => delete copy.dataset.done, DONE_MS);
      track('share', { platform: 'copy' });
    });
  }

  const nativeItem = bar.querySelector<HTMLElement>('[data-native-item]');
  const native = bar.querySelector<HTMLButtonElement>('[data-native]');
  if (nativeItem && native && typeof navigator.share === 'function') {
    nativeItem.hidden = false;

    native.addEventListener('click', async () => {
      try {
        await navigator.share({ title, url });
        track('share', { platform: 'native' });
      } catch {
        // Dismissing the sheet rejects too; there is nothing to report.
      }
    });
  }
}

document.querySelectorAll<HTMLElement>('[data-share]').forEach(init);
