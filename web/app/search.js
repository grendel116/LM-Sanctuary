import { createPostCard } from '../components/PostCard.js';
import { createLoadingState } from '../components/ui/index.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { searchBskyActors, searchBskyPosts } from '../queries/bluesky.js';
import { fetchProgramJournals } from '../queries/sanctuary.js';
import {
  likeUnified,
  repostUnified,
  searchAccountsAndPosts,
  toggleFollowAuthor,
} from '../queries/socialClient.js';
import { authStore, getAuthenticatedAccount, updateAccountTokens } from '../state/authStore.js';
import { prefillReply } from '../state/composeStore.js';
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
    results = { accounts: [], posts: [], hashtags: [], journals: [], error: '' };
    resultsEl.replaceChildren(createLoadingState('Searching Mastodon, Bluesky & journals…'));

    try {
      const bskyAuth = await getAuthenticatedAccount('bluesky').catch(() => null);
      const bskySearchOpts = bskyAuth
        ? {
            query,
            serviceUrl: bskyAuth.meta.serviceUrl,
            accessJwt: bskyAuth.secrets.accessJwt,
            refreshJwt: bskyAuth.secrets.refreshJwt,
            onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok),
          }
        : { query };

      const [fediData, bskyActors, bskyPosts] = await Promise.all([
        searchAccountsAndPosts(query).catch(() => ({ accounts: [], statuses: [], hashtags: [] })),
        searchBskyActors(bskySearchOpts).catch(() => ({ actors: [] })),
        searchBskyPosts({ query }).catch(() => ({ items: [] })),
      ]);

      if (destroyed) return;

      results.accounts.push(...(fediData.accounts || []));
      results.posts.push(...(fediData.statuses || []));
      results.hashtags.push(...(fediData.hashtags || []));

      for (const actor of bskyActors?.actors || []) {
        results.accounts.push({
          id: actor.did,
          acct: actor.handle,
          displayName: actor.displayName || actor.handle,
          avatar: actor.avatar || '',
          url: `https://bsky.app/profile/${actor.handle}`,
          network: 'bluesky',
          viewer: actor.viewer || null,
        });
      }
      results.posts.push(...(bskyPosts?.items || []));

      const conn = connectionStore.get();
      const progs = conn.programs || [];
      const lowerQ = query.toLowerCase();
      for (const prog of progs) {
        let jData = null;
        if (conn.mode === 'online') {
          jData = await fetchProgramJournals(prog.id, 'default').catch(() => null);
        }
        if (!jData) {
          jData = await getCachedJournalsAndQuests(prog.id, 'default');
        }
        if (destroyed) return;
        for (const entry of jData?.journals || []) {
          const text = `${entry.topic || ''} ${entry.content || entry.summary || ''}`;
          if (text.toLowerCase().includes(lowerQ)) {
            results.journals.push({ programName: prog.name || prog.id, ...entry });
          }
        }
      }
    } catch (err) {
      results.error = err?.message || 'Search failed';
    }

    if (!destroyed) renderResults();
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
      for (const post of results.posts) {
        box.appendChild(
          createPostCard(post, {
            onReply: (p) => prefillReply(p),
            onToggleLike: (p) => void likeUnified(p),
            onToggleRepost: (p) => void repostUnified(p),
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

  renderResults();

  return {
    destroy() {
      destroyed = true;
    },
  };
}
