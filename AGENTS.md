# postgrest-timeoff

A pnpm monorepo for a time-off API on PostgREST: `apps/web` is a TanStack Start debugger app, `db/` holds the re-runnable SQL (tables, row level security, admin rules), `scripts/` sets up a Postgres database for production, and `infra/docker` runs Postgres, PostgREST and a local OIDC test server for development. See `README.md` for the full picture.

## Validation

Run `pnpm check` and `pnpm build` before committing. `pnpm check` runs `vp check` (Oxfmt formatting and type-aware Oxlint), `jsdoc-lint`, and the TypeScript 7 type check; `pnpm check:fix` applies formatter and lint fixes first. Vite+ (`vp`) owns formatting and linting, configured in the root `vite.config.ts`, and `jsdoc-lint` reads `jsdoc.json`. Do not introduce Biome, ESLint, Prettier, or standalone tool configuration alongside them.

## Comments

`jsdoc-lint` requires a multiline JSDoc block on every top-level function, class, interface, type alias, and `const`, on the fields of interfaces and named object types, and on the direct members of top-level object constants. A single-line `/** … */` counts as missing.

When it fails, write a comment that is worth reading, not one that satisfies the linter:

- Describe behavior, intent, invariants, and the non-obvious why (security assumptions, ordering constraints, how it fits the PostgREST/RLS model). Don't restate the name or the TypeScript types.
- Keep it concise: one sentence is often enough; add a second paragraph only for real constraints or caveats.
- Never write placeholders such as "The foo." or "Handles bar.", and never disable the check.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `<type>[optional scope]: <description>`, with a concise imperative description.
