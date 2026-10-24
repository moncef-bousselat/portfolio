/**
 * Analytics events.
 *
 * Pageviews need nothing here: the provider's script (components/
 * Analytics.astro) counts them itself. This forwards the few events worth
 * counting that a click attribute cannot express, such as a contact message
 * actually sent. With no provider configured, or the script blocked by the
 * visitor, it does nothing.
 *
 * Plain clicks, the CV download for one, are tracked by the provider from a
 * data-umami-event attribute instead, with no JavaScript of ours.
 */

export type TrackEvent = 'cv_download' | 'contact_success';

declare global {
  interface Window {
    umami?: { track(event: string, data?: Record<string, string>): void };
  }
}

export function track(event: TrackEvent, properties?: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  window.umami?.track(event, properties);
}
