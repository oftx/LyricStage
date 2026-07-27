import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'vite';

const dist = new URL('../dist/', import.meta.url);
await mkdir(dist, { recursive: true });

async function bundle({ entry, fileName, name, format }) {
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      emptyOutDir: false,
      outDir: dist.pathname,
      lib: {
        entry: new URL(entry, import.meta.url).pathname,
        formats: [format],
        name,
        fileName: () => fileName,
      },
      minify: false,
      sourcemap: true,
    },
  });
}

const MUSIC_MATCHES = [
  'http://127.0.0.1/*',
  'http://localhost/*',
  '*://*.youtube.com/*',
  '*://youtu.be/*',
  '*://music.youtube.com/*',
  '*://www.bilibili.com/*',
  '*://m.bilibili.com/*',
  '*://y.qq.com/*',
  '*://*.y.qq.com/*',
  '*://music.163.com/*',
  '*://*.music.163.com/*',
  '*://music.apple.com/*',
  '*://*.music.apple.com/*',
];

const APPLE_MUSIC_MATCHES = [
  '*://music.apple.com/*',
  '*://*.music.apple.com/*',
];

// MAIN-world early hooks: must run before players construct unattached Audio().
await bundle({
  entry: '../src/page-clock/early-hooks.ts',
  fileName: 'page-clock-early.js',
  name: 'LyricStagePageClockEarly',
  format: 'iife',
});
// MAIN-world always-on clock + seek bridge (no SW inject needed).
await bundle({
  entry: '../src/page-clock/main-content-entry.ts',
  fileName: 'page-clock-main.js',
  name: 'LyricStagePageClockMain',
  format: 'iife',
});
// MAIN-world Apple Music MusicKit lyric request bridge.
await bundle({
  entry: '../src/musickit/main-content-entry.ts',
  fileName: 'musickit-request-main.js',
  name: 'LyricStageAppleMusicRequest',
  format: 'iife',
});
// Content + surfaces: classic IIFE content scripts / pages.
await bundle({
  entry: '../src/content/content-runtime.ts',
  fileName: 'content.js',
  name: 'LyricStageExtensionContent',
  format: 'iife',
});
await bundle({
  entry: '../src/surface/surface.ts',
  fileName: 'surface.js',
  name: 'LyricStageExtensionSurface',
  format: 'iife',
});
await bundle({
  entry: '../src/popup/popup.ts',
  fileName: 'popup.js',
  name: 'LyricStageExtensionPopup',
  format: 'iife',
});
// Service worker: single ESM file (Chrome MV3 module worker).
await bundle({
  entry: '../src/background/service-worker.ts',
  fileName: 'service-worker.js',
  name: 'LyricStageExtensionWorker',
  format: 'es',
});

const readStatic = async (name) => (
  await import('node:fs/promises')
).readFile(new URL(`../static/${name}`, import.meta.url));

await writeFile(new URL('../dist/host.html', import.meta.url), await readStatic('host.html'));
await writeFile(new URL('../dist/surface.html', import.meta.url), await readStatic('surface.html'));
await writeFile(new URL('../dist/popup.html', import.meta.url), await readStatic('popup.html'));

await writeFile(new URL('../dist/manifest.json', import.meta.url), JSON.stringify({
  manifest_version: 3,
  name: 'LyricStage Extension Shell',
  version: '0.0.0',
  description: 'Minimal Phase-0-derived MV3 shell; not a store product.',
  background: { service_worker: 'service-worker.js', type: 'module' },
  action: {
    default_title: 'LyricStage',
    default_popup: 'popup.html',
  },
  permissions: [
    'scripting',
    'storage',
    'tabs',
  ],
  host_permissions: [
    'http://127.0.0.1/*',
    'http://localhost/*',
    '*://*.youtube.com/*',
    '*://youtu.be/*',
    '*://music.youtube.com/*',
    '*://www.bilibili.com/*',
    '*://m.bilibili.com/*',
    '*://y.qq.com/*',
    '*://*.y.qq.com/*',
    '*://c.y.qq.com/*',
    '*://u.y.qq.com/*',
    '*://music.163.com/*',
    '*://*.music.163.com/*',
    '*://music.apple.com/*',
    '*://*.music.apple.com/*',
  ],
  web_accessible_resources: [
    {
      resources: ['surface.html', 'surface.js'],
      matches: MUSIC_MATCHES.filter((pattern) => pattern.startsWith('*://')),
    },
  ],
  content_scripts: [
    {
      matches: MUSIC_MATCHES,
      js: ['page-clock-early.js'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: false,
    },
    {
      matches: MUSIC_MATCHES,
      js: ['page-clock-main.js'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: false,
    },
    {
      matches: APPLE_MUSIC_MATCHES,
      js: ['musickit-request-main.js'],
      run_at: 'document_start',
      world: 'MAIN',
      all_frames: false,
    },
    {
      matches: MUSIC_MATCHES,
      js: ['content.js'],
      run_at: 'document_start',
      all_frames: false,
    },
  ],
}, null, 2));
