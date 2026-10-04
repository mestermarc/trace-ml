// Bundles the extension host (Node/CJS) and the webview (browser/IIFE + CSS) into dist/.
import { copyFileSync, mkdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

// sql.js loads its WebAssembly from dist/ at runtime (passed as bytes; nothing is fetched).
mkdirSync('dist', { recursive: true });
copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'linked',
  logLevel: 'info',
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: { webview: 'src/webview/main.ts' },
    outdir: 'dist',
    platform: 'browser',
    format: 'iife',
    target: 'es2020',
    loader: { '.css': 'css' },
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
