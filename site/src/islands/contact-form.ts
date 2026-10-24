/**
 * The contact form's behaviour: enables the form, loads Turnstile, validates
 * on submit, posts JSON to /api/contact and reports the outcome.
 *
 * Accessibility: each field error is text tied to its control with
 * aria-describedby and aria-invalid, focus moves to the first invalid field,
 * and every status change is announced through the role="status" region.
 * On success the form is replaced by a message that takes focus.
 */

import { track } from '../lib/analytics';

type Field = 'name' | 'email' | 'message';
type FieldError = 'required' | 'tooLong' | 'invalid';

interface Messages {
  fields: Record<Field, Record<FieldError, string>>;
  status: Record<
    | 'fix'
    | 'sending'
    | 'challengePending'
    | 'challenge'
    | 'challengeLoad'
    | 'tooMany'
    | 'limited'
    | 'generic',
    string
  >;
}

/** The parts of Turnstile's explicit-rendering API used here. */
interface Turnstile {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

// Must be loaded from this exact URL: Cloudflare forbids proxying or caching
// it. Allowed by the CSP's script-src and frame-src.
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

const FIELDS: Field[] = ['name', 'email', 'message'];

function init(form: HTMLFormElement): void {
  const fieldset = form.querySelector<HTMLFieldSetElement>('[data-fields]');
  const submit = form.querySelector<HTMLButtonElement>('[data-submit]');
  const status = form.querySelector<HTMLElement>('[data-status]');
  const container = form.querySelector<HTMLElement>('[data-turnstile]');
  const success = document.querySelector<HTMLElement>('[data-success]');
  if (!fieldset || !submit || !status || !container || !success) return;

  const messages = JSON.parse(form.dataset.messages ?? '{}') as Messages;
  const control = (field: Field) =>
    form.elements.namedItem(field) as HTMLInputElement | HTMLTextAreaElement;
  const errorFor = (field: Field) => form.querySelector<HTMLElement>(`[data-error-for="${field}"]`);

  // Fill time is measured from when the form became usable.
  const startedAt = performance.now();
  let token: string | null = null;
  let widgetId: string | undefined;
  let busy = false;
  const label = submit.textContent?.trim() ?? '';

  const say = (text: string, tone: 'info' | 'error' = 'info') => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  const setFieldError = (field: Field, error: FieldError | null) => {
    const input = control(field);
    const slot = errorFor(field);
    if (error) {
      input.setAttribute('aria-invalid', 'true');
      if (slot) {
        slot.textContent = messages.fields[field][error];
        slot.hidden = false;
      }
    } else {
      input.removeAttribute('aria-invalid');
      if (slot) {
        slot.textContent = '';
        slot.hidden = true;
      }
    }
  };

  /** The same rules the server applies, minus the ones only it can check. */
  const check = (field: Field): FieldError | null => {
    const input = control(field);
    const value = input.value.trim();
    if (value === '') return 'required';
    if (value.length > input.maxLength && input.maxLength > 0) return 'tooLong';
    if (field === 'email' && input instanceof HTMLInputElement && input.validity.typeMismatch) {
      return 'invalid';
    }
    return null;
  };

  /** Shows errors; returns the first invalid field, or null. */
  const showErrors = (errors: Partial<Record<Field, FieldError>>): Field | null => {
    let first: Field | null = null;
    for (const field of FIELDS) {
      setFieldError(field, errors[field] ?? null);
      if (errors[field] && !first) first = field;
    }
    return first;
  };

  const resetChallenge = () => {
    token = null;
    if (widgetId !== undefined) window.turnstile?.reset(widgetId);
  };

  const setBusy = (value: boolean) => {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    submit.setAttribute('aria-disabled', String(value));
    submit.textContent = value ? messages.status.sending : label;
  };

  // Clear a field's error as soon as it is corrected.
  for (const field of FIELDS) {
    control(field).addEventListener('input', () => {
      if (control(field).getAttribute('aria-invalid') === 'true' && !check(field)) {
        setFieldError(field, null);
      }
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;

    const errors: Partial<Record<Field, FieldError>> = {};
    for (const field of FIELDS) {
      const error = check(field);
      if (error) errors[field] = error;
    }
    const first = showErrors(errors);
    if (first) {
      say(messages.status.fix, 'error');
      control(first).focus();
      return;
    }

    if (!token) {
      say(messages.status.challengePending, 'error');
      return;
    }

    setBusy(true);
    say(messages.status.sending);

    const honeypot = form.elements.namedItem('website') as HTMLInputElement | null;
    let response: Response;
    try {
      response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: control('name').value,
          email: control('email').value,
          message: control('message').value,
          token,
          website: honeypot?.value ?? '',
          elapsedMs: Math.round(performance.now() - startedAt),
        }),
      });
    } catch {
      setBusy(false);
      resetChallenge();
      say(messages.status.generic, 'error');
      return;
    }

    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      fields?: Partial<Record<Field | 'token', FieldError>>;
    } | null;

    if (response.ok && body?.ok) {
      track('contact_success');
      form.hidden = true;
      success.hidden = false;
      success.focus();
      return;
    }

    setBusy(false);
    // A token is single-use, and the server may have spent it.
    resetChallenge();

    if (response.status === 400 && body?.error === 'validation' && body.fields) {
      const { token: tokenError, ...fields } = body.fields;
      const firstInvalid = showErrors(fields);
      if (firstInvalid) {
        say(messages.status.fix, 'error');
        control(firstInvalid).focus();
      } else if (tokenError) {
        say(messages.status.challengePending, 'error');
      } else {
        say(messages.status.generic, 'error');
      }
    } else if (response.status === 403) {
      say(messages.status.challenge, 'error');
    } else if (response.status === 429 && body?.error === 'rateLimited') {
      // The per-visitor limit. A bare 429 is API Gateway's overall throttle.
      const seconds = Number(response.headers.get('retry-after'));
      const minutes = Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : 5;
      say(messages.status.limited.replace('{minutes}', String(minutes)), 'error');
    } else if (response.status === 429) {
      say(messages.status.tooMany, 'error');
    } else {
      say(messages.status.generic, 'error');
    }
  });

  // Typing can start right away; only sending waits for Turnstile.
  fieldset.disabled = false;

  const script = document.createElement('script');
  script.src = TURNSTILE_SRC;
  script.async = true;
  script.addEventListener('load', () => {
    if (!window.turnstile) {
      say(messages.status.challengeLoad, 'error');
      return;
    }
    widgetId = window.turnstile.render(container, {
      sitekey: form.dataset.sitekey,
      theme: 'dark',
      language: form.dataset.lang,
      // The token is sent in the JSON body, not as a form field.
      'response-field': false,
      callback: (value: string) => {
        token = value;
        // Clear a "wait for the check" message once the check is done.
        if (status.textContent === messages.status.challengePending) say('');
      },
      'expired-callback': () => {
        token = null;
      },
      'error-callback': () => {
        token = null;
        say(messages.status.challengeLoad, 'error');
      },
    });
  });
  script.addEventListener('error', () => say(messages.status.challengeLoad, 'error'));
  document.head.append(script);
}

const form = document.querySelector<HTMLFormElement>('form[data-contact-form]');
if (form) init(form);

// A module, so the Window augmentation above applies.
export {};
