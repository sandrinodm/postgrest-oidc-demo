/**
 * Turns anything thrown into a one-line message for the UI or a redirect: an `Error`'s message, otherwise
 * the value as a string, since server functions and fetch can reject with non-`Error` values.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
