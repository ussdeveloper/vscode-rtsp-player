const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').BuildOptions}
 */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/**
 * Webview bundle: hls.js is bundled in, so the extension ships a single IIFE.
 * @type {import('esbuild').BuildOptions}
 */
const webviewOptions = {
  entryPoints: ['media/player.js'],
  bundle: true,
  outfile: 'media/player.bundle.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(webviewOptions),
    ]);
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    return;
  }
  await Promise.all([esbuild.build(extensionOptions), esbuild.build(webviewOptions)]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
