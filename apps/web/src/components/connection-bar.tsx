import { useState } from 'react';

/**
 * Pinned to the top of the page: which PostgREST the app is talking to (`POSTGREST_BASE_URI`) and whether it
 * answered, so it's always clear which environment the data on screen comes from.
 *
 * `reachable` reflects the page's last load, so it turns false on any error that load reported, including one
 * from PostgREST itself rather than the network; the error banner below says which.
 */
export function ConnectionBar({ url, reachable }: { url: string; reachable: boolean }) {
  const [copied, setCopied] = useState(false);

  /**
   * Copies the URI, for pasting into curl or the console, and confirms it on the button.
   */
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={reachable ? 'connection-bar' : 'connection-bar bad'} role="status">
      <span className="connection-state">{reachable ? 'Connected to' : 'Problem reaching'}</span>
      <span className="connection-label">PostgREST</span>
      <code className="connection-url">{url}</code>
      <button type="button" className="btn small" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
