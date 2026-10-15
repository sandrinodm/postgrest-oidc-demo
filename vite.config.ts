import { defineConfig } from 'vite-plus';

/**
 * Paths that hold generated or built files. Neither the formatter nor the linter should touch them.
 */
const generatedPaths = ['**/routeTree.gen.ts', '**/.output/**', '**/.nitro/**', '**/.tanstack/**', '**/dist/**'];

export default defineConfig({
  run: {
    cache: true,
  },
  fmt: {
    ignorePatterns: generatedPaths,
    printWidth: 120,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: true,
    trailingComma: 'es5',
    sortImports: false,
    sortPackageJson: false,
    proseWrap: 'preserve',
  },
  lint: {
    categories: {
      correctness: 'error',
    },
    plugins: ['oxc', 'typescript', 'unicorn'],
    options: {
      denyWarnings: true,
      reportUnusedDisableDirectives: 'error',
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      'eslint/curly': ['error', 'all'],
      'eslint/no-unused-vars': 'error',
      'typescript/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      'typescript/no-non-null-assertion': 'error',
      'vite-plus/prefer-vite-plus-imports': 'error',
    },
    overrides: [
      {
        // The web app is React; docsdown, which this config mirrors, has no JSX.
        files: ['apps/web/**'],
        plugins: ['react'],
      },
    ],
    ignorePatterns: generatedPaths,
    jsPlugins: [
      {
        name: 'vite-plus',
        specifier: 'vite-plus/oxlint-plugin',
      },
    ],
  },
});
