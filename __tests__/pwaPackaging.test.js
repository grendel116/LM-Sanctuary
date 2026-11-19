import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CACHE_NAME,
  APP_SHELL_ASSETS,
  shouldBypassSwCache,
} from '../web/sw.js';
import { verifyAndroidWebBundle } from '../scripts/buildAndroid.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(REPO_ROOT, 'web');

test('PWA manifest sets standalone relative scope, #121214 theme, valid icon, and Web Share Target', () => {
  const manifestPath = path.join(WEB_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, '#121214');
  assert.equal(manifest.theme_color, '#121214');
  assert.equal(manifest.share_target?.action, './');
  assert.equal(manifest.share_target?.method, 'GET');
  assert.equal(manifest.share_target?.params?.title, 'title');
  assert.equal(manifest.share_target?.params?.text, 'text');
  assert.equal(manifest.share_target?.params?.url, 'url');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  for (const icon of manifest.icons) {
    assert.equal(fs.existsSync(path.resolve(WEB_DIR, icon.src)), true, `Missing icon ${icon.src}`);
  }
});

test('Service Worker APP_SHELL_ASSETS all exist on disk and match modular SPA without legacy monolith', () => {
  assert.equal(CACHE_NAME, 'sanctuary-shell-v42');
  assert.ok(APP_SHELL_ASSETS.includes('./'));
  assert.ok(APP_SHELL_ASSETS.includes('./app/_layout.js'));
  assert.ok(APP_SHELL_ASSETS.includes('./state/activityStore.js'));
  assert.ok(APP_SHELL_ASSETS.includes('./core/feedRanker.js'));
  assert.ok(APP_SHELL_ASSETS.includes('./components/EmbedCard.js'));
  assert.ok(APP_SHELL_ASSETS.includes('./components/EmojiPickerPopover.js'));
  assert.ok(APP_SHELL_ASSETS.includes('./components/FeedTuningModal.js'));
  assert.ok(APP_SHELL_ASSETS.includes('./components/FollowGraphModal.js'));
  assert.ok(APP_SHELL_ASSETS.includes('./components/ThreadsImportModal.js'));
  assert.ok(APP_SHELL_ASSETS.includes('./components/FediverseShareButton.js'));
  assert.equal(
    APP_SHELL_ASSETS.some((item) => item.includes('sanctuary-legacy.js')),
    false
  );

  for (const asset of APP_SHELL_ASSETS) {
    const rel = asset === './' ? 'index.html' : asset;
    const diskPath = path.resolve(WEB_DIR, rel);
    assert.equal(fs.existsSync(diskPath), true, `Missing SW shell asset: ${asset}`);
  }
});

test('shouldBypassSwCache skips non-GET, SSE/NDJSON streams, cross-origin/opaque requests, and dynamic Sanctuary routes', () => {
  const selfOrigin = 'https://app.example.test';

  // Non-GET must bypass
  assert.equal(shouldBypassSwCache('https://app.example.test/chat', 'POST', selfOrigin, 'application/json'), true);
  assert.equal(shouldBypassSwCache('https://app.example.test/api/programs/p1', 'DELETE', selfOrigin), true);

  // Streaming responses must bypass
  assert.equal(shouldBypassSwCache('https://app.example.test/api/events/status', 'GET', selfOrigin, 'text/event-stream'), true);
  assert.equal(shouldBypassSwCache('https://app.example.test/api/portrait/generate', 'GET', selfOrigin, 'application/x-ndjson'), true);

  // Cross-origin & opaque "null" origins must bypass
  assert.equal(shouldBypassSwCache('https://mastodon.social/api/v1/timelines/home', 'GET', selfOrigin), true);
  assert.equal(shouldBypassSwCache('http://100.64.10.5:5000/api/mobile/health', 'GET', selfOrigin), true);
  assert.equal(shouldBypassSwCache('https://app.example.test/index.html', 'GET', 'null'), true);
  assert.equal(shouldBypassSwCache('about:blank', 'GET', selfOrigin), true);

  // Same-origin dynamic Sanctuary endpoints must bypass
  for (const dynPath of [
    '/api/mobile/health',
    '/api/config',
    '/v1/models',
    '/images/sample.png',
    '/programs/alex/sessions/s1.json',
    '/speech_cache/line1.wav',
    '/chat',
    '/edit',
    '/continue',
    '/delete',
    '/reset',
    '/update_message',
    '/history',
    '/approve_tool',
    '/pending_tool_call',
    '/upload_media',
    '/delete_image',
    '/regenerate_image',
    '/list_images',
    '/models',
    '/profile.png',
    '/sparkle.mp3',
    '/sw.js',
  ]) {
    assert.equal(
      shouldBypassSwCache(`${selfOrigin}${dynPath}`, 'GET', selfOrigin, 'application/json'),
      true,
      `Expected dynamic route ${dynPath} to bypass SW cache`
    );
  }

  // Same-origin static shell files stay cacheable
  for (const staticPath of ['/', '/index.html', '/manifest.json', '/app/_layout.js', '/assets/css/shell.css']) {
    assert.equal(
      shouldBypassSwCache(`${selfOrigin}${staticPath}`, 'GET', selfOrigin, 'text/html'),
      false,
      `Expected static shell asset ${staticPath} to be cacheable`
    );
  }
});

test('Android Capacitor packaging checks pass and forbidden AI social dispatch files do not exist', async () => {
  const result = await verifyAndroidWebBundle(REPO_ROOT);
  assert.equal(result.shellAssetCount, APP_SHELL_ASSETS.length);

  const forbiddenPaths = [
    path.join(REPO_ROOT, 'sanctuary', 'tools', 'social_dispatch.py'),
    path.join(REPO_ROOT, 'sanctuary', 'core', 'skills', 'social_dispatch'),
    path.join(REPO_ROOT, 'sanctuary', 'adapters', 'threads_adapter.py'),
    path.join(REPO_ROOT, 'sanctuary', 'adapters', 'fediverse_adapter.py'),
    path.join(REPO_ROOT, 'sanctuary', 'variables', 'social_accounts.json'),
  ];

  for (const forbidden of forbiddenPaths) {
    assert.equal(fs.existsSync(forbidden), false, `Forbidden file present: ${forbidden}`);
  }
});
