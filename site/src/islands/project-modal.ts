/**
 * Upgrades the project panels from hash-targeted static panels into real
 * modal dialogs.
 *
 * Everything here is an enhancement. With this script absent or broken, the
 * panels still open via :target, close via their link, and deep links still
 * work - see the CSS comment in ProjectPanel.astro.
 */

function panelFor(slug: string): HTMLDialogElement | null {
  const el = document.getElementById(slug);
  return el instanceof HTMLDialogElement ? el : null;
}

/** The card link that opened a panel, so focus can be handed back on close. */
let lastTrigger: HTMLElement | null = null;

function open(slug: string, trigger?: HTMLElement): void {
  const panel = panelFor(slug);
  if (!panel || panel.open) return;

  lastTrigger = trigger ?? null;
  panel.showModal();

  // Reflect the open panel in the URL so it stays shareable and the back
  // button closes it. replaceState rather than pushState on first open keeps
  // one history entry per navigation, not per click.
  if (window.location.hash !== `#${slug}`) {
    history.pushState(null, '', `#${slug}`);
  }
}

function close(panel: HTMLDialogElement): void {
  if (panel.open) panel.close();
}

function init(): void {
  const panels = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog.panel'));
  if (panels.length === 0) return;

  // Open from a card click.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const trigger = target.closest<HTMLElement>('[data-project]');
    if (trigger) {
      const slug = trigger.dataset.project;
      if (slug && panelFor(slug)) {
        event.preventDefault();
        open(slug, trigger);
      }
      return;
    }

    // The close control is a real link for the no-JS case; intercept it.
    const closer = target.closest<HTMLElement>('[data-close]');
    if (closer) {
      const slug = closer.dataset.close;
      const panel = slug ? panelFor(slug) : null;
      if (panel) {
        event.preventDefault();
        close(panel);
      }
    }
  });

  for (const panel of panels) {
    // Switches off the no-JS :target rule for this panel. Without it, a
    // panel opened from a deep link reappears inline after closing: the
    // hash is cleared with history.replaceState, which browsers do not
    // treat as a change of :target.
    panel.dataset.enhanced = '';

    // Clicking the backdrop closes. The backdrop is not a child, so a click
    // landing on the dialog itself rather than its content means the backdrop.
    panel.addEventListener('click', (event) => {
      if (event.target === panel) close(panel);
    });

    // Fires for Esc as well as close(), so URL and focus cleanup live here
    // once rather than at every call site.
    panel.addEventListener('close', () => {
      if (window.location.hash === `#${panel.id}`) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      lastTrigger?.focus();
      lastTrigger = null;
    });
  }

  // A deep link that arrives with the page, and back/forward navigation.
  const syncFromHash = (): void => {
    const slug = window.location.hash.slice(1);
    const panel = slug ? panelFor(slug) : null;

    for (const other of panels) {
      if (other !== panel) close(other);
    }

    if (panel && !panel.open) {
      // Record the card as the return target, but do NOT focus it: showModal
      // moves focus into the dialog, and focusing the trigger afterwards would
      // pull focus straight back out again.
      lastTrigger = document.querySelector<HTMLElement>(`[data-project="${slug}"]`);
      panel.showModal();
    }
  };

  window.addEventListener('popstate', syncFromHash);
  syncFromHash();
}

init();
