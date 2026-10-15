import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig, loadEnv } from 'vite-plus';

/**
 * Fills process.env for the dev server from infra/docker/.env (shared with docker compose: JWT_SECRET, OIDC_*) and then apps/web/.env, whose values take precedence for app-only overrides.
 *
 * Variables already set in the real environment are never overwritten, so a shell export or CI setting always beats the files.
 */
function loadServerEnv(mode: string) {
  const shared = loadEnv(mode, fileURLToPath(new URL('../../infra/docker', import.meta.url)), '');
  const local = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');
  for (const [key, value] of Object.entries({ ...shared, ...local })) {
    process.env[key] ??= value;
  }
}

export default defineConfig(({ mode }) => {
  loadServerEnv(mode);
  return {
    resolve: { tsconfigPaths: true },
    server: { port: 5173, strictPort: true },
    plugins: [nitro(), tanstackStart(), viteReact()],
  };
});
