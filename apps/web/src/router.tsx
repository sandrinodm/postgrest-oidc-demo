import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

/**
 * Creates the app's router, which TanStack Start calls once per server request and once in the browser.
 *
 * Links preload on hover or focus, and preloaded data is always treated as stale so the debugger never shows an outdated view of what PostgREST returns.
 */
export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  });

  return router;
}

declare module '@tanstack/react-router' {
  /**
   * Registers this app's router type with TanStack Router so links, search params, and loader data are type-checked against the route tree.
   */
  interface Register {
    /**
     * The router instance type that `Link`, `useNavigate`, and route hooks infer their types from.
     */
    router: ReturnType<typeof getRouter>;
  }
}
