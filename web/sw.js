export const CACHE_NAME = 'sanctuary-shell-v114';

export const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './assets/css/shell.css',
  './assets/css/sanctuary.css',
  './assets/css/github-dark.min.css',
  './assets/css/cropper.min.css',
  './assets/img/app_icon.png',
  './assets/img/app_icon.ico',
  './assets/vendor/marked.min.js',
  './assets/vendor/highlight.min.js',
  './assets/vendor/cropper.min.js',
  './constants/avatars.js',
  './constants/endpoints.js',
  './constants/theme.js',
  './core/feedRanker.js',
  './core/postLanguage.js',
  './core/urlPrivacy.js',
  './core/schema/unifiedItem.js',
  './adapters/base.js',
  './adapters/browserBridge.js',
  './adapters/mastodon/index.js',
  './adapters/bluesky/index.js',
  './adapters/threads/index.js',
  './storage/nativeStore.js',
  './storage/kvStorage.js',
  './queries/fetch/FetchError.js',
  './queries/fetch/fetchWrapper.js',
  './queries/feedHarvester.js',
  './queries/fediverse.js',
  './queries/bluesky.js',
  './queries/threads.js',
  './queries/linkPreview.js',
  './queries/threadsArchive.js',
  './queries/sanctuary.js',
  './queries/socialClient.js',
  './state/store.js',
  './state/activityStore.js',
  './state/authStore.js',
  './state/browserStore.js',
  './state/feedStore.js',
  './state/composeStore.js',
  './state/sanctuary/types.js',
  './state/sanctuary/connection.js',
  './state/sanctuary/outboxModel.js',
  './state/sanctuary/sessionModel.js',
  './components/ui/Button.js',
  './components/ui/Pill.js',
  './components/ui/Card.js',
  './components/ui/ModalShell.js',
  './components/ui/SwipeSheet.js',
  './components/ui/index.js',
  './components/AuthorSheetModal.js',
  './components/EmbedCard.js',
  './components/EmojiPickerPopover.js',
  './components/FeedTuningModal.js',
  './components/FollowGraphModal.js',
  './components/ThreadsImportModal.js',
  './components/FediverseShareButton.js',
  './components/ContentWarning.js',
  './components/MediaAttachment.js',
  './components/OfflineNotice.js',
  './components/PullToRefresh.js',
  './components/SearchInput.js',
  './components/SearchSuggestions.js',
  './components/PostCard.js',
  './components/sanctuary/SanctuaryDialog.js',
  './components/sanctuary/UserModal.js',
  './components/sanctuary/ProgramModals.js',
  './components/sanctuary/SettingsModal.js',
  './components/sanctuary/KnowledgeModal.js',
  './components/sanctuary/QuestModal.js',
  './components/sanctuary/PortraitGrid.js',
  './components/sanctuary/ToolApprovalCard.js',
  './components/sanctuary/MessageRow.js',
  './components/sanctuary/MoodHeart.js',
  './components/sanctuary/VoiceCallOverlay.js',
  './app/_layout.js',
  './app/activity.js',
  './app/browser.js',
  './app/composeModal.js',
  './app/postThread.js',
  './app/profile.js',
  './app/feed.js',
  './app/search.js',
  './app/programThread.js',
  './app/messages.js',
];

const DYNAMIC_PREFIXES = [
  '/api/',
  '/v1/',
  '/images/',
  '/programs/',
  '/speech_cache/',
];

const DYNAMIC_EXACT_PATHS = new Set([
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
]);

/**
 * Determine whether a request must bypass the Service Worker shell cache.
 * Always bypasses non-GET requests, SSE/NDJSON streams, opaque ("null") or
 * cross-origin URLs (Fediverse instances and LAN/Tailscale nodes), and
 * same-origin Sanctuary dynamic endpoints.
 */
export function shouldBypassSwCache(requestUrl, method = 'GET', selfOrigin = '', acceptHeader = '') {
  if (String(method || 'GET').toUpperCase() !== 'GET') {
    return true;
  }

  const accept = String(acceptHeader || '').toLowerCase();
  if (accept.includes('text/event-stream') || accept.includes('application/x-ndjson')) {
    return true;
  }

  if (!selfOrigin || selfOrigin === 'null') {
    return true;
  }

  let parsed;
  try {
    parsed = new URL(String(requestUrl || ''), selfOrigin);
  } catch {
    return true;
  }

  if (parsed.origin === 'null' || parsed.origin !== selfOrigin) {
    return true;
  }

  const pathname = parsed.pathname || '/';
  if (DYNAMIC_EXACT_PATHS.has(pathname)) {
    return true;
  }

  for (const prefix of DYNAMIC_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

if (typeof self !== 'undefined' && typeof self.skipWaiting === 'function') {
  self.addEventListener('install', (event) => {
    event.waitUntil(
      caches.open(CACHE_NAME).then((cache) =>
        Promise.all(
          APP_SHELL_ASSETS.map(async (assetUrl) => {
            const res = await fetch(new Request(assetUrl, { cache: 'reload' }));
            if (!res.ok) throw new Error(`Precache failed for ${assetUrl}: ${res.status}`);
            await cache.put(assetUrl, res);
          })
        )
      )
    );
    self.skipWaiting();
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key !== CACHE_NAME)
              .map((oldKey) => caches.delete(oldKey))
          )
        )
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    const acceptHeader = req.headers ? req.headers.get('accept') || '' : '';

    if (shouldBypassSwCache(req.url, req.method, self.location.origin, acceptHeader)) {
      return;
    }

    const host = self.location?.hostname || '';
    const isLocalHost = host === '127.0.0.1' || host === 'localhost';

    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);

        if (isLocalHost) {
          try {
            const networkResponse = await fetch(
              req.mode === 'navigate' ? req : new Request(req, { cache: 'no-cache' })
            );
            if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
              cache.put(req, networkResponse.clone());
            }
            return networkResponse;
          } catch (err) {
            const cachedFallback = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
            if (cachedFallback) return cachedFallback;
            if (req.mode === 'navigate') {
              const shellFallback = (await cache.match('./index.html')) || (await cache.match('./'));
              if (shellFallback) return shellFallback;
            }
            throw err;
          }
        }

        const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
        if (cached) {
          return cached;
        }

        try {
          const networkResponse = await fetch(req);
          if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
            cache.put(req, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          if (req.mode === 'navigate') {
            const shellFallback = (await cache.match('./index.html')) || (await cache.match('./'));
            if (shellFallback) {
              return shellFallback;
            }
          }
          throw err;
        }
      })()
    );
  });
}
