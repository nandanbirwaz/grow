import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { MemoryStore } from './store/memory.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal .env loader (no dependency). Real environment variables win over the file. */
function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv(resolve(here, '../.env'));
loadDotEnv(resolve(here, '../../.env'));

let config;
try {
  config = loadConfig(process.env);
} catch (e) {
  console.error(e.message);
  console.error('\nCopy .env.example to .env and fill in the required values.');
  process.exit(1);
}

const distDir = resolve(here, '../../client/dist');
if (!config.staticDir && existsSync(distDir)) config.staticDir = distDir;

let store;
if (config.mongoUri) {
  const { createMongoStore } = await import('./store/mongo.js');
  store = await createMongoStore(config.mongoUri);
  console.log('Using MongoDB store');
} else {
  store = new MemoryStore();
  console.warn('MONGODB_URI not set: using the in-memory store. Data is lost on restart (fine for local demo, not for production).');
}

const app = createApp({ config, store });
await app.init();
const port = await app.listen(config.port);
console.log(`Growth Hub listening on http://localhost:${port}  (store=${store.kind}, gemini=${config.gemini.apiKey ? 'configured' : 'not configured -> deterministic fallback'}${config.staticDir ? ', serving client build' : ''})`);
