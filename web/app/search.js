import { createPostCard } from '../components/PostCard.js';
import { attachSearchSuggestions } from '../components/SearchSuggestions.js';
import { showConfirm } from '../components/sanctuary/SanctuaryDialog.js';
import { createLoadingState } from '../components/ui/index.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { applyKeywordFilters } from '../core/schema/unifiedItem.js';
import { normalizeBskyActorSummary, searchBskyActors } from '../queries/bluesky.js';
import { searchFediverse } from '../queries/fediverse.js';
import { fetchProgramJournals } from '../queries/sanctuary.js';
import {
  likeUnified,
  repostUnified,
  searchAccountsAndPosts,
  toggleBlockAuthor,
  toggleFollowAuthor,
  toggleMuteAuthor,
} from '../queries/socialClient.js';
import { authStore, getAuthenticatedAccount, updateAccountTokens } from '../state/authStore.js';
import { prefillReply } from '../state/composeStore.js';
import { applyPostInterestFeedback, feedStore, removePostAcrossStreams } from '../state/feedStore.js';
import { connectionStore } from '../state/sanctuary/connection.js';
import { getCachedJournalsAndQuests } from '../storage/nativeStore.js';

/**
 * Search view: unified single-bar search across Mastodon accounts/hashtags/posts,
 * Bluesky actors/posts, and local Sanctuary Program journals.
 */
export function mountSearchScreen(containerEl, {
  onOpenPostThread,
  onAskSanctuary,
  onSelectAuthor,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();

  let destroyed = false;
  let lastQuery = '';
  let searchEpoch = 0;
  let results = { accounts: [], posts: [], hashtags: [], journals: [], error: '' };

  const root = doc.createElement('section');
  root.className = 'search-screen';

  const stageHeader = doc.createElement('div');
  stageHeader.className = 'stage-header search-stage-header';

  const searchLandmark = doc.createElement('search');
  searchLandmark.className = 'search-landmark';

  const searchForm = doc.createElement('form');
  searchForm.className = 'search-bar-form';

  const input = doc.createElement('input');
  input.type = 'search';
  input.id = 'global-search-input';
  input.className = 'onboarding-input search-bar-input';
  input.placeholder = 'Search users, posts, tags, or journals...';
  input.setAttribute('aria-label', 'Search');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('spellcheck', 'false');

  const submitBtn = doc.createElement('button');
  submitBtn.type = 'submit';
  submitBtn.className = 'edit-btn edit-save-btn';
  submitBtn.textContent = 'Search';

  searchForm.append(input, submitBtn);
  searchLandmark.appendChild(searchForm);
  stageHeader.appendChild(searchLandmark);

  const stripLeadingAt = (raw) => {
    let s = String(raw || '').trim();
    while (s.startsWith('@')) s = s.slice(1);
    return s;
  };
  const stripLeadingHash = (raw) => {
    let s = String(raw || '').trim();
    while (s.startsWith('#')) s = s.slice(1);
    return s;
  };

  const searchSuggest = attachSearchSuggestions(input, {
    anchorEl: searchForm,
    debounceMs: 160,
    minChars: 1,
    getLocalSuggestions: (rawQ) => {
      const q = String(rawQ || '').trim();
      if (!q) return [];
      const lowQ = stripLeadingAt(stripLeadingHash(q)).toLowerCase();
      const localItems = [];
      const seenHandles = new Set();

      const pushAccount = (acc, protoHint = '') => {
        if (localItems.length >= 3) return;
        const handle = stripLeadingAt(acc?.acct || acc?.handle || acc?.username || '');
        const name = String(acc?.displayName || acc?.name || acc?.username || handle || '').trim();
        if (!handle && !name) return;
        const hay = `${handle} ${name}`.toLowerCase();
        if (lowQ && !hay.includes(lowQ)) return;
        const dedupeKey = (handle || name).toLowerCase();
        if (seenHandles.has(dedupeKey)) return;
        seenHandles.add(dedupeKey);
        const isBsky = protoHint === 'bluesky' || acc?.platform === 'bluesky' || acc?.protocol === 'bluesky' || acc?.network === 'bluesky';
        localItems.push({
          kind: 'account',
          label: name || `@${handle}`,
          sublabel: `@${handle || name} · ${isBsky ? 'Bluesky' : 'Mastodon'}`,
          value: `@${handle || name}`,
          account: { ...acc, protocol: isBsky ? 'bluesky' : 'mastodon' },
        });
      };

      for (const acc of authStore.get().accounts || []) {
        pushAccount(acc, acc?.platform);
      }
      const streams = feedStore.get().streams || {};
      for (const sName of ['feed', 'following', 'photos', 'video']) {
        for (const item of streams[sName]?.items || []) {
          if (localItems.length >= 3) break;
          if (item?.author) pushAccount(item.author, item.network);
        }
      }

      if (!q.includes(' ')) {
        const cleanTag = stripLeadingHash(q);
        if (cleanTag.length >= 2) {
          localItems.push({
            kind: 'hashtag',
            label: `#${cleanTag}`,
            sublabel: 'Search #hashtag',
            value: `#${cleanTag}`,
          });
        }
      }

      localItems.push({
        kind: 'search',
        label: `Search "${q}"`,
        sublabel: 'Posts, @handles, #tags & journals',
        value: q,
      });
      return localItems;
    },
    fetchRemoteSuggestions: async (rawQ) => {
      const q = String(rawQ || '').trim();
      if (q.length < 2) return [];
      const cleanActor = stripLeadingAt(q);
      const [bskyAuth, fediAuth] = await Promise.all([
        getAuthenticatedAccount('bluesky').catch(() => null),
        getAuthenticatedAccount('fediverse').catch(() => null),
      ]);
      const bskyOpts = bskyAuth?.meta?.serviceUrl && bskyAuth?.secrets?.accessJwt
        ? {
            serviceUrl: bskyAuth.meta.serviceUrl,
            accessJwt: bskyAuth.secrets.accessJwt,
            refreshJwt: bskyAuth.secrets.refreshJwt,
            onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok),
          }
        : {};
      const [bskyRes, fediRes] = await Promise.allSettled([
        cleanActor ? searchBskyActors({ ...bskyOpts, query: cleanActor, limit: 5 }) : Promise.resolve({ actors: [] }),
        fediAuth?.secrets?.accessToken
          ? searchFediverse({
              instanceUrl: fediAuth.meta.instanceUrl || 'https://mastodon.social',
              accessToken: fediAuth.secrets.accessToken,
              query: q,
              resolve: false,
              limit: 5,
              timeoutMs: 3500,
            })
          : Promise.resolve({ accounts: [], hashtags: [] }),
      ]);

      const items = [];
      if (fediRes.status === 'fulfilled') {
        for (const acc of (fediRes.value?.accounts || []).slice(0, 3)) {
          const handle = stripLeadingAt(acc?.acct || acc?.handle || '');
          if (!handle) continue;
          items.push({
            kind: 'account',
            label: acc.displayName || acc.name || acc.username || handle,
            sublabel: `@${handle} · Mastodon`,
            value: `@${handle}`,
            account: { ...acc, protocol: 'mastodon', network: 'fediverse' },
          });
        }
        for (const tag of (fediRes.value?.hashtags || []).slice(0, 2)) {
          const name = stripLeadingHash(tag?.name || tag || '');
          if (!name) continue;
          items.push({
            kind: 'hashtag',
            label: `#${name}`,
            sublabel: 'Hashtag',
            value: `#${name}`,
          });
        }
      }
      if (bskyRes.status === 'fulfilled') {
        for (const rawActor of (bskyRes.value?.actors || []).slice(0, 4)) {
          const acc = normalizeBskyActorSummary(rawActor);
          const handle = stripLeadingAt(acc?.acct || acc?.handle || '');
          if (!handle) continue;
          items.push({
            kind: 'account',
            label: acc.displayName || acc.username || handle,
            sublabel: `@${handle} · Bluesky`,
            value: `@${handle}`,
            account: { ...acc, protocol: 'bluesky', network: 'bluesky' },
          });
        }
      }
      return items;
    },
    mergeSuggestions: (localItems, remoteItems) => [...remoteItems, ...localItems],
    onSelect: (item) => {
      if (item.kind === 'account' && item.account && onSelectAuthor) {
        const acc = item.account;
        const isBsky = acc.protocol === 'bluesky' || acc.network === 'bluesky';
        onSelectAuthor({
          id: acc.id || acc.did || '',
          name: acc.displayName || acc.name || acc.username || acc.acct || acc.handle || '',
          handle: acc.acct || acc.handle || acc.username || '',
          avatar_url: acc.avatar || acc.avatar_url || '',
          url: acc.url || '',
          protocol: isBsky ? 'bluesky' : 'mastodon',
          network: acc.network || (isBsky ? 'bluesky' : 'fediverse'),
          viewer: acc.viewer || null,
        });
        return;
      }
      input.value = item.value;
      lastQuery = item.value;
      void runSearch(item.value);
    },
  });

  const resultsEl = doc.createElement('div');
  resultsEl.className = 'search-results-list';

  root.append(stageHeader, resultsEl);
  containerEl.appendChild(root);

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    lastQuery = q;
    void runSearch(q);
  });

  async function runSearch(query) {
    if (destroyed) return;
    const epoch = ++searchEpoch;
    results = { accounts: [], posts: [], hashtags: [], journals: [], error: '' };
    resultsEl.replaceChildren(createLoadingState('Searching Mastodon, Bluesky & journals…'));

    try {
      const conn = connectionStore.get();
      const progs = conn.programs || [];
      const lowerQ = query.toLowerCase();

      const [socialData, journalChunks] = await Promise.all([
        searchAccountsAndPosts(query).catch(() => ({ accounts: [], statuses: [], hashtags: [] })),
        Promise.all(
          progs.map(async (prog) => {
            let jData = null;
            if (conn.mode === 'online') {
              jData = await fetchProgramJournals(prog.id, 'default').catch(() => null);
            }
            if (!jData) {
              jData = await getCachedJournalsAndQuests(prog.id, 'default');
            }
            const hits = [];
            for (const entry of jData?.journals || []) {
              const text = `${entry.topic || ''} ${entry.content || entry.summary || ''}`;
              if (text.toLowerCase().includes(lowerQ)) {
                hits.push({ programName: prog.name || prog.id, ...entry });
              }
            }
            return hits;
          })
        ),
      ]);

      if (destroyed || epoch !== searchEpoch) return;

      const feedModState = feedStore.get();
      const moderatedStatuses = applyKeywordFilters(
        socialData.statuses || [],
        feedModState.filters || [],
        feedModState.moderatedActors || []
      );
      results.accounts.push(...(socialData.accounts || []));
      results.posts.push(...moderatedStatuses);
      results.hashtags.push(...(socialData.hashtags || []));
      results.journals.push(...journalChunks.flat());
    } catch (err) {
      if (destroyed || epoch !== searchEpoch) return;
      results.error = err?.message || 'Search failed';
    }

    if (!destroyed && epoch === searchEpoch) renderResults();
  }

  function renderResults() {
    if (destroyed) return;
    resultsEl.replaceChildren();
    if (!lastQuery) {
      const hint = doc.createElement('p');
      hint.className = 'empty-state';
      hint.textContent = 'Search @user@instance, Bluesky handles, #tags, or Program journals.';
      resultsEl.appendChild(hint);
      return;
    }

    if (results.error) {
      const errEl = doc.createElement('p');
      errEl.className = 'empty-state';
      errEl.textContent = results.error;
      resultsEl.appendChild(errEl);
      return;
    }

    const total =
      results.accounts.length +
      results.posts.length +
      results.hashtags.length +
      results.journals.length;

    if (total === 0) {
      const none = doc.createElement('p');
      none.className = 'empty-state';
      none.textContent = 'No matching results.';
      resultsEl.appendChild(none);
      return;
    }

    if (results.accounts.length > 0) {
      const box = doc.createElement('div');
      box.className = 'search-section';
      const h2 = doc.createElement('h2');
      h2.className = 'search-section-title';
      h2.textContent = 'Accounts';
      box.appendChild(h2);
      const hasMastodon = authStore.get().isMastodonConnected;
      const hasBluesky = authStore.get().isBlueskyConnected;
      for (const acc of results.accounts) {
        const isBsky = acc.network === 'bluesky' || acc.protocol === 'bluesky';
        const card = doc.createElement('div');
        card.className = 'search-account-row';
        const img = doc.createElement('img');
        img.className = 'post-avatar';
        img.src = acc.avatar || DEFAULT_AVATAR_DATA_URI;
        img.alt = acc.displayName || acc.acct || 'Account';
        const metaBtn = doc.createElement('button');
        metaBtn.type = 'button';
        metaBtn.className = 'search-account-meta-btn';
        const meta = doc.createElement('div');
        meta.className = 'search-account-meta';
        const titleRow = doc.createElement('div');
        titleRow.className = 'search-account-title-row';
        const name = doc.createElement('strong');
        name.className = 'search-account-name';
        name.textContent = acc.displayName || acc.username || acc.acct || '';
        const protoBadge = doc.createElement('span');
        protoBadge.className = 'post-protocol-badge';
        protoBadge.textContent = isBsky ? 'Bluesky' : 'Mastodon';
        titleRow.append(name, protoBadge);

        const acct = doc.createElement('span');
        acct.className = 'post-author-handle';
        acct.textContent = acc.acct ? `@${String(acc.acct).replace(/^@/, '')}` : '';
        meta.append(titleRow, acct);
        metaBtn.appendChild(meta);
        metaBtn.addEventListener('click', () => {
          onSelectAuthor?.({
            id: acc.id,
            name: acc.displayName || acc.username || acc.acct,
            handle: acc.acct || acc.username,
            avatar_url: acc.avatar || '',
            url: acc.url || '',
            protocol: isBsky ? 'bluesky' : 'mastodon',
            network: acc.network || (isBsky ? 'bluesky' : 'fediverse'),
            viewer: acc.viewer || null,
          });
        });
        card.append(img, metaBtn);
        const canFollow = (isBsky ? hasBluesky : hasMastodon) && acc.id;
        if (canFollow) {
          let isFollowing = isBsky
            ? Boolean(acc.viewer?.following)
            : Boolean(acc.relationship?.following);
          let followUri = acc.viewer?.following || null;
          const fBtn = doc.createElement('button');
          fBtn.type = 'button';
          fBtn.className = isFollowing
            ? 'edit-btn search-account-follow-btn is-following'
            : 'btn-sleek-pill search-account-follow-btn';
          fBtn.textContent = isFollowing ? 'Following' : 'Follow';
          fBtn.addEventListener('click', async () => {
            fBtn.disabled = true;
            try {
              const rel = await toggleFollowAuthor(acc.id, isFollowing, {
                protocol: isBsky ? 'bluesky' : 'mastodon',
                followUri,
              });
              isFollowing = Boolean(rel?.following ?? !isFollowing);
              if (rel && 'followUri' in rel) followUri = rel.followUri || null;
              fBtn.textContent = isFollowing ? 'Following' : 'Follow';
              fBtn.className = isFollowing
                ? 'edit-btn search-account-follow-btn is-following'
                : 'btn-sleek-pill search-account-follow-btn';
            } finally {
              fBtn.disabled = false;
            }
          });
          card.appendChild(fBtn);
        }
        box.appendChild(card);
      }
      resultsEl.appendChild(box);
    }

    if (results.hashtags.length > 0) {
      const box = doc.createElement('div');
      box.className = 'search-section';
      const h2 = doc.createElement('h2');
      h2.className = 'search-section-title';
      h2.textContent = 'Hashtags';
      box.appendChild(h2);
      const wrap = doc.createElement('div');
      wrap.className = 'search-hashtags-wrap';
      for (const tag of results.hashtags) {
        const span = doc.createElement('span');
        span.className = 'search-hashtag-chip';
        span.textContent = `#${tag.name}`;
        wrap.appendChild(span);
      }
      box.appendChild(wrap);
      resultsEl.appendChild(box);
    }

    if (results.posts.length > 0) {
      const box = doc.createElement('div');
      box.className = 'search-section';
      const h2 = doc.createElement('h2');
      h2.className = 'search-section-title';
      h2.textContent = 'Posts';
      box.appendChild(h2);
      const showSanctuary = connectionStore.get().mode === 'online' || connectionStore.get().programs.length > 0;
      const matchPost = (it, target, updated) =>
        it === target || (it?.id && (it.id === target?.id || it.id === updated?.id));
      const canModSearchPost = (p) => Boolean(p?.author?.id || p?.author?.handle);
      const promptSearchModeration = (kind, u) => {
        const cleanH = String(u?.author?.handle || '').replace(/^@/, '');
        if (!u?.author?.id && !cleanH) return;
        const isBlock = kind === 'block';
        showConfirm(isBlock ? 'Block Account' : 'Mute Account', `${isBlock ? 'Block' : 'Mute'} @${cleanH || u.author.id}?`, async () => {
          try {
            const fn = isBlock ? toggleBlockAuthor : toggleMuteAuthor;
            await fn(u.author.id || cleanH, false, {
              protocol: u.protocol,
              acct: cleanH,
              displayName: u.author.name || cleanH,
              instanceUrl: u._meta?.mastodon?.instanceUrl || '',
            });
            removePostAcrossStreams((item) => item?.author?.handle === u.author.handle || (u.author.id && item?.author?.id === u.author.id));
            if (!destroyed) {
              results.posts = results.posts.filter((it) => it?.author?.handle !== u.author.handle && (!u.author.id || it?.author?.id !== u.author.id));
              renderResults();
            }
          } catch (err) {
            showAlert('Moderation Error', err?.message || `Unable to ${isBlock ? 'block' : 'mute'} account.`);
          }
        });
      };
      for (const post of results.posts) {
        const canMod = canModSearchPost(post);
        box.appendChild(
          createPostCard(post, {
            onReply: (p) => prefillReply(p),
            onToggleLike: async (p) => {
              const updated = await likeUnified(p);
              if (updated && !destroyed) {
                results.posts = results.posts.map((it) => (matchPost(it, p, updated) ? updated : it));
                renderResults();
              }
            },
            onToggleRepost: async (p) => {
              const updated = await repostUnified(p);
              if (updated && !destroyed) {
                results.posts = results.posts.map((it) => (matchPost(it, p, updated) ? updated : it));
                renderResults();
              }
            },
            onInterested: async (p) => {
              const updated = await applyPostInterestFeedback(p, 'interested');
              if (updated && !destroyed) {
                results.posts = results.posts.map((it) => (matchPost(it, p, updated) ? updated : it));
                renderResults();
              }
            },
            onNotInterested: async (p) => {
              await applyPostInterestFeedback(p, 'not_interested');
              if (!destroyed) {
                results.posts = results.posts.filter((it) => !matchPost(it, p, null));
                renderResults();
              }
            },
            onMuteAuthor: canMod ? (_raw, u) => promptSearchModeration('mute', u) : null,
            onBlockAuthor: canMod ? (_raw, u) => promptSearchModeration('block', u) : null,
            onSelectAuthor,
            onOpenThread: onOpenPostThread,
            onAskSanctuary,
            showSanctuaryAction: showSanctuary,
          })
        );
      }
      resultsEl.appendChild(box);
    }

    if (results.journals.length > 0) {
      const box = doc.createElement('div');
      box.className = 'search-section';
      const h2 = doc.createElement('h2');
      h2.className = 'search-section-title';
      h2.textContent = 'Journals';
      box.appendChild(h2);
      for (const j of results.journals) {
        const card = doc.createElement('div');
        card.className = 'classic-select-card search-journal-card';
        const title = doc.createElement('strong');
        title.textContent = `${j.programName}: ${j.topic || j.title || 'Note'}`;
        const p = doc.createElement('p');
        p.className = 'classic-card-subtext';
        p.textContent = j.content || j.summary || '';
        card.append(title, p);
        box.appendChild(card);
      }
      resultsEl.appendChild(box);
    }
  }

  const unsubAuth = authStore.subscribe(() => {
    if (!destroyed) renderResults();
  });

  renderResults();

  return {
    destroy() {
      destroyed = true;
      searchSuggest?.destroy?.();
      unsubAuth();
    },
  };
}
