import { memo, type ReactNode } from 'react';

/**
 * Matches the JSON tokens worth coloring: strings (capturing a trailing colon when the string is an object key), `true`/`false`/`null`, and numbers.
 */
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/**
 * Splits text into plain strings and colored spans for keys, strings, keywords, and numbers.
 *
 * It is a scanner, not a parser, so it is enough to make payloads and claims scannable and degrades to plain text for anything that is not JSON.
 */
function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const index = m.index ?? 0;
    if (index > last) {
      out.push(text.slice(last, index));
    }
    // Every alternative of TOKEN captures exactly one of these; `colon` only follows a string.
    const [whole, str, colon, keyword, num] = m;
    const className = str ? (colon ? 'j-key' : 'j-str') : keyword ? 'j-kw' : 'j-num';
    out.push(
      <span key={index} className={className}>
        {str ?? keyword ?? num}
      </span>
    );
    if (colon) {
      out.push(colon);
    }
    last = index + whole.length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out;
}

/**
 * Pretty-prints a value as highlighted JSON; strings are shown as-is so raw response bodies and env snippets keep their own formatting.
 *
 * Memoized because logged calls never change identity, while the debugger re-renders on every log append, and highlighting a large response body builds thousands of spans.
 */
export const Json = memo(function Json({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <pre className="json">{highlight(text ?? 'undefined')}</pre>;
});
