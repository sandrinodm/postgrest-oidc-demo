import { useState } from 'react';
import { errorMessage } from './errors';

/**
 * Tracks one user-triggered server call: `busy` while it runs and the `error` to show next to the form.
 *
 * The action reports an expected failure by returning its message (as the time-off functions do with PostgREST
 * errors) and an unexpected one by throwing; both end up in `error`, and the next `run` clears it.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Runs the action, keeping `busy` set until it settles even when it throws.
   */
  async function run(action: () => Promise<string | null | void>) {
    setBusy(true);
    setError(null);
    try {
      const failure = await action();
      if (failure) {
        setError(failure);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}

/**
 * Copies text to the clipboard and remembers which button did it, so that button can read "Copied".
 *
 * Keys let several copy buttons share one hook; a denied clipboard clears the mark instead of throwing.
 */
export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);

  /**
   * Writes `text` to the clipboard and marks `key` as the last successful copy.
   */
  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  }

  return { copied, copy };
}
