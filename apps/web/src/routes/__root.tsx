import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import appCss from '../styles.css?url';

/**
 * The root route, which sets the page metadata and stylesheet shared by every page.
 */
export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'PostgREST debugger · Time off' },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
});

/**
 * Renders the HTML shell around every page, where TanStack Start injects head tags and its client scripts.
 */
function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
