import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/assets', { recursive: true });
cpSync('index.html', 'dist/index.html');

const opts = {
  entryPoints: { app: 'src/main.jsx' },
  bundle: true, minify: !watch, sourcemap: watch, format: 'esm', target: 'es2020',
  outdir: 'dist/assets', jsx: 'automatic', loader: { '.css': 'css' },
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};
if (watch) { const ctx = await context(opts); await ctx.watch(); console.log('watching…'); } else { await build(opts); }
