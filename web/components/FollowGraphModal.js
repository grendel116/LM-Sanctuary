import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import {
  fetchCentralizedConnections,
  fetchFollowConnections,
  fetchPendingFollowRequests,
  mergeCentralizedConnectionAccounts,
  removeFollowerAccount,
  respondToFollowRequest,
  toggleFollowAuthor,
} from '../queries/socialClient.js';
import { authStore } from '../state/authStore.js';
import { createClassicModalDialog } from './sanctuary/SanctuaryDialog.js';
import { createLoadingState } from './ui/index.js';

function getAccountMetaByProtocol(accounts = [], protocol = 'mastodon') {
  const list = Array.isArray(accounts) ? accounts : [];
  if (protocol === 'bluesky') return list.find((a) => a?.platform === 'bluesky') || null;
  return list.find((a) => a?.platform === 'fediverse' || a?.platform === 'mastodon') || null;
}

function getRowProtocol(acc, fallbackProtocol = 'mastodon') {
  if (acc?.protocol === 'bluesky' || String(acc?.did || acc?.id || '').startsWith('did:')) {
    return 'bluesky';
  }
  if (acc?.protocol === 'mastodon' || acc?.protocol === 'fediverse') {
    return 'mastodon';
  }
  return fallbackProtocol === 'bluesky' ? 'bluesky' : 'mastodon';
}

function isSameAccount(acc, accProto, ownMasto, ownBsky) {
  if (accProto === 'bluesky') {
    if (!ownBsky) return false;
    const accDid = String(acc?.did || acc?.id || '');
    const ownDid = String(ownBsky.did || '');
    if (accDid && ownDid && accDid === ownDid) return true;
    const accHandle = String(acc?.acct || acc?.handle || '').replace(/^@/, '').toLowerCase();
    const ownHandle = String(ownBsky.handle || ownBsky.acct || '').replace(/^@/, '').toLowerCase();
    return Boolean(accHandle && ownHandle && accHandle === ownHandle);
  }
  if (!ownMasto) return false;
  const accAcct = String(acc?.acct || acc?.username || '').replace(/^@/, '').toLowerCase();
  const ownAcct = String(ownMasto.acct || ownMasto.handle || '').replace(/^@/, '').toLowerCase();
  return Boolean(accAcct && ownAcct && accAcct === ownAcct);
}

/**
 * Interactive Following / Followers / Requests manager modal for Mastodon and Bluesky.
 */
export function openFollowGraphModal({
  accountId = '',
  acct = '',
  displayName = '',
  instanceUrl = 'https://mastodon.social',
  protocol = 'mastodon',
  initialTab = 'following',
  isOwnProfile = false,
  onSelectAuthor,
  onCountsChanged,
} = {}) {
  const doc = globalThis.document;
  if (!doc) return null;

  const snap = authStore.get();
  const ownMasto = getAccountMetaByProtocol(snap.accounts, 'mastodon');
  const ownBsky = getAccountMetaByProtocol(snap.accounts, 'bluesky');

  let activeTab = initialTab === 'followers' || initialTab === 'requests' ? initialTab : 'following';
  if (activeTab === 'requests' && (!isOwnProfile || !ownMasto)) {
    activeTab = 'following';
  }

  let filterText = '';
  let statusMessage = '';
  let followRequests = [];
  let closed = false;

  const pageCache = {
    following: { items: [], cursor: '', cursors: {}, hasMore: false, loading: false, loaded: false, error: '' },
    followers: { items: [], cursor: '', cursors: {}, hasMore: false, loading: false, loaded: false, error: '' },
  };

  const normalizedProto = protocol === 'bluesky' ? 'bluesky' : 'mastodon';
  const contextTarget = {
    accountId,
    acct,
    titleName: displayName || acct || 'Account',
    instanceUrl,
    protocol: normalizedProto,
  };

  doc.getElementById('follow-graph-dialog')?.remove?.();

  const modal = createClassicModalDialog({
    id: 'follow-graph-dialog',
    onClose: () => {
      closed = true;
      modal.dialog.remove();
    },
  });
  modal.dialog.classList.add('follow-graph-modal');
  modal.dialog.setAttribute('aria-labelledby', 'follow-graph-title');

  const heading = doc.createElement('h2');
  heading.id = 'follow-graph-title';
  heading.className = 'classic-modal-title';

  const tabBar = doc.createElement('div');
  tabBar.className = 'follow-graph-tabs';
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('focusgroup', 'tablist nomemory');
  tabBar.setAttribute('aria-label', 'Connection lists');

  tabBar.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(tabBar.querySelectorAll('[role="tab"]'));
    if (tabs.length === 0) return;
    const idx = tabs.indexOf(doc.activeElement);
    if (idx === -1) return;
    event.preventDefault();
    const nextIdx = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (idx + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIdx].focus();
  });

  const filterWrap = doc.createElement('div');
  filterWrap.className = 'follow-graph-filter-wrap';
  const filterIn = doc.createElement('input');
  filterIn.type = 'search';
  filterIn.className = 'onboarding-input follow-graph-filter';
  filterIn.placeholder = 'Filter by name or handle...';
  filterIn.setAttribute('aria-label', 'Filter connections');
  filterIn.setAttribute('autocomplete', 'off');
  filterIn.addEventListener('input', () => {
    filterText = filterIn.value.trim().toLowerCase();
    renderList();
  });
  filterWrap.append(filterIn);

  const statusEl = doc.createElement('div');
  statusEl.className = 'classic-inline-status';
  statusEl.hidden = true;
  statusEl.setAttribute('role', 'status');

  const scrollBody = doc.createElement('div');
  scrollBody.className = 'classic-modal-scroll-body follow-graph-list';
  scrollBody.setAttribute('role', 'tabpanel');

  modal.card.append(heading, tabBar, filterWrap, statusEl, scrollBody);

  async function openAuthor(acc, accProto) {
    const cleanAcct = String(acc?.acct || acc?.handle || acc?.username || '').replace(/^@/, '');
    const rowInstanceUrl = accProto === 'bluesky'
      ? 'https://bsky.app'
      : (ownMasto?.instanceUrl || contextTarget.instanceUrl || 'https://mastodon.social');
    const targetAuthor = {
      id: acc?.id || acc?.did || '',
      did: acc?.did || '',
      name: acc?.displayName || cleanAcct,
      handle: cleanAcct,
      acct: cleanAcct,
      avatar: acc?.avatar || '',
      url: acc?.url || '',
      note: acc?.noteText || '',
      protocol: accProto,
      network: accProto,
      relationship: acc?.relationship || null,
      viewer: acc?.viewer || null,
    };
    modal.close();
    if (onSelectAuthor) {
      onSelectAuthor(targetAuthor);
      return;
    }
    const { openAuthorSheetModal } = await import('./AuthorSheetModal.js');
    openAuthorSheetModal({ author: targetAuthor, instanceUrl: rowInstanceUrl });
  }

  function updateHeadingAndControls() {
    if (closed) return;
    heading.textContent = isOwnProfile ? 'Connections' : `${contextTarget.titleName} · Connections`;

    const tabs = [
      ['following', 'Following'],
      ['followers', 'Followers'],
    ];
    if (isOwnProfile && ownMasto && followRequests.length > 0) {
      tabs.push(['requests', `Requests (${followRequests.length})`]);
    }

    tabBar.replaceChildren();
    for (const [id, label] of tabs) {
      const selected = activeTab === id;
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `follow-graph-tab-${id}`;
      btn.className = 'modal-tab-btn';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(selected));
      if (selected) {
        btn.setAttribute('focusgroupstart', '');
      }
      btn.textContent = label;
      btn.addEventListener('click', () => {
        if (activeTab === id) return;
        activeTab = id;
        statusMessage = '';
        updateHeadingAndControls();
        renderList();
        if (id !== 'requests' && !pageCache[id]?.loaded && !pageCache[id]?.loading) {
          void loadTab(id);
        }
      });
      tabBar.append(btn);
    }

    scrollBody.setAttribute('aria-labelledby', `follow-graph-tab-${activeTab}`);
  }

  function renderAccountRow(acc) {
    const accProto = getRowProtocol(acc, isOwnProfile ? 'mastodon' : contextTarget.protocol);
    const rowInstanceUrl = accProto === 'bluesky'
      ? 'https://bsky.app'
      : (ownMasto?.instanceUrl || contextTarget.instanceUrl || 'https://mastodon.social');

    const row = doc.createElement('div');
    row.className = 'search-account-row follow-graph-row';

    const av = doc.createElement('img');
    av.className = 'post-avatar';
    av.src = acc.avatar || DEFAULT_AVATAR_DATA_URI;
    av.alt = '';
    av.loading = 'lazy';
    av.addEventListener('error', () => {
      av.src = DEFAULT_AVATAR_DATA_URI;
    });

    const infoBtn = doc.createElement('button');
    infoBtn.type = 'button';
    infoBtn.className = 'search-account-info';
    infoBtn.addEventListener('click', () => void openAuthor(acc, accProto));

    const nameLine = doc.createElement('span');
    nameLine.className = 'follow-graph-name-line';
    const nameEl = doc.createElement('span');
    nameEl.className = 'search-account-name';
    nameEl.textContent = acc.displayName || acc.acct || acc.handle || 'User';
    nameLine.append(nameEl);

    if (isOwnProfile) {
      const protoBadge = doc.createElement('span');
      protoBadge.className = 'post-protocol-badge follow-graph-proto-pill';
      protoBadge.dataset.protocol = accProto;
      protoBadge.textContent = accProto === 'bluesky' ? 'Bluesky' : 'Fediverse';
      nameLine.append(protoBadge);
    }

    const acctEl = doc.createElement('span');
    acctEl.className = 'search-account-acct';
    const cleanHandle = String(acc.acct || acc.handle || acc.username || '').replace(/^@/, '');
    acctEl.textContent = `@${cleanHandle}`;

    if (activeTab === 'following' && acc.relationship?.followed_by) {
      const mutual = doc.createElement('span');
      mutual.className = 'follow-mutual-pill btn-sleek-pill';
      mutual.textContent = 'Follows you';
      acctEl.append(' ', mutual);
    }

    infoBtn.append(nameLine, acctEl);

    const actionWrap = doc.createElement('div');
    actionWrap.className = 'follow-graph-row-actions';

    if (activeTab === 'requests') {
      const acceptBtn = doc.createElement('button');
      acceptBtn.type = 'button';
      acceptBtn.className = 'edit-btn search-account-follow-btn';
      acceptBtn.textContent = 'Accept';

      const rejectBtn = doc.createElement('button');
      rejectBtn.type = 'button';
      rejectBtn.className = 'btn-sleek-pill search-account-follow-btn';
      rejectBtn.textContent = 'Decline';

      const handleRequest = async (accept) => {
        acceptBtn.disabled = true;
        rejectBtn.disabled = true;
        statusMessage = '';
        try {
          await respondToFollowRequest(acc.id, accept);
          followRequests = followRequests.filter((r) => r.id !== acc.id);
          if (accept) pageCache.followers.loaded = false;
          if (followRequests.length === 0 && activeTab === 'requests') {
            activeTab = 'followers';
          }
          onCountsChanged?.();
          updateHeadingAndControls();
          renderList();
        } catch (err) {
          statusMessage = err?.message || 'Unable to respond to follow request.';
          acceptBtn.disabled = false;
          rejectBtn.disabled = false;
          renderList();
        }
      };

      acceptBtn.addEventListener('click', () => void handleRequest(true));
      rejectBtn.addEventListener('click', () => void handleRequest(false));
      actionWrap.append(acceptBtn, rejectBtn);
    } else {
      const isSelf = isSameAccount(acc, accProto, ownMasto, ownBsky);
      const isOwnFollowingRow = isOwnProfile && activeTab === 'following';
      const hasExplicitViewer = Boolean(
        accProto === 'bluesky'
          ? (acc.viewer && Object.keys(acc.viewer).length > 0) || acc.relationship?.followUri
          : acc.relationship && typeof acc.relationship.following === 'boolean'
      );
      let isFollowing = accProto === 'bluesky'
        ? (hasExplicitViewer
          ? Boolean(acc.relationship?.following || acc.viewer?.following)
          : isOwnFollowingRow)
        : Boolean(acc.relationship?.following ?? isOwnFollowingRow);
      let followUri = acc.relationship?.followUri || acc.viewer?.following || null;

      if (!isSelf) {
        const fBtn = doc.createElement('button');
        fBtn.type = 'button';
        fBtn.className = isFollowing
          ? 'edit-btn search-account-follow-btn is-following'
          : 'btn-sleek-pill search-account-follow-btn';
        fBtn.textContent = isFollowing ? 'Following' : 'Follow';
        fBtn.addEventListener('click', async () => {
          fBtn.disabled = true;
          statusMessage = '';
          try {
            const rel = await toggleFollowAuthor(acc.id || acc.did, isFollowing, {
              protocol: accProto,
              instanceUrl: rowInstanceUrl,
              followUri,
              did: acc.did || '',
            });
            isFollowing = Boolean(rel?.following ?? !isFollowing);
            followUri = rel?.followUri ?? (isFollowing ? followUri : null);
            acc.relationship = { ...(acc.relationship || {}), following: isFollowing, followUri };
            if (accProto === 'bluesky') {
              acc.viewer = { ...(acc.viewer || {}), following: followUri || isFollowing };
            }
            fBtn.textContent = isFollowing ? 'Following' : 'Follow';
            fBtn.className = isFollowing
              ? 'edit-btn search-account-follow-btn is-following'
              : 'btn-sleek-pill search-account-follow-btn';
            onCountsChanged?.();
          } catch (err) {
            statusMessage = err?.message || 'Unable to update follow status.';
            renderList();
          } finally {
            fBtn.disabled = false;
          }
        });
        actionWrap.append(fBtn);
      }

      if (isOwnProfile && activeTab === 'followers' && accProto === 'mastodon' && !isSelf) {
        const remBtn = doc.createElement('button');
        remBtn.type = 'button';
        remBtn.className = 'btn-sleek-pill';
        remBtn.textContent = 'Remove';
        remBtn.title = 'Remove this follower';
        remBtn.addEventListener('click', async () => {
          remBtn.disabled = true;
          statusMessage = '';
          try {
            await removeFollowerAccount(acc.id);
            pageCache.followers.items = pageCache.followers.items.filter((x) => x.id !== acc.id);
            onCountsChanged?.();
            renderList();
          } catch (err) {
            statusMessage = err?.message || 'Unable to remove follower.';
            remBtn.disabled = false;
            renderList();
          }
        });
        actionWrap.append(remBtn);
      }
    }

    row.append(av, infoBtn, actionWrap);
    return row;
  }

  function filterRows(rows) {
    if (!filterText) return rows;
    return rows.filter((acc) => {
      const hay = `${acc.displayName || ''} ${acc.acct || acc.handle || ''} ${acc.username || ''}`.toLowerCase();
      return hay.includes(filterText);
    });
  }

  function renderList() {
    if (closed) return;
    statusEl.textContent = statusMessage;
    statusEl.hidden = !statusMessage;
    scrollBody.replaceChildren();

    if (activeTab === 'requests') {
      const filteredReqs = filterRows(followRequests);
      if (filteredReqs.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'panel-empty';
        empty.textContent = 'No pending follow requests.';
        scrollBody.append(empty);
        return;
      }
      for (const acc of filteredReqs) scrollBody.append(renderAccountRow(acc));
      return;
    }

    const bucket = pageCache[activeTab];
    if (bucket.loading && bucket.items.length === 0) {
      scrollBody.append(createLoadingState(`Loading ${activeTab}...`, { doc, size: 'compact' }));
      return;
    }
    if (bucket.error && bucket.items.length === 0) {
      const err = doc.createElement('p');
      err.className = 'panel-empty';
      err.textContent = bucket.error;
      scrollBody.append(err);
      return;
    }

    const visible = filterRows(bucket.items);
    if (visible.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'panel-empty';
      empty.textContent = filterText
        ? 'No matching accounts.'
        : (activeTab === 'followers' ? 'No followers found.' : 'Not following anyone yet.');
      scrollBody.append(empty);
      return;
    }

    for (const acc of visible) {
      scrollBody.append(renderAccountRow(acc));
    }

    const canLoadMore = isOwnProfile ? bucket.hasMore : Boolean(bucket.cursor);
    if (canLoadMore && !filterText) {
      const moreBtn = doc.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'edit-btn follow-graph-more-btn';
      moreBtn.textContent = bucket.loading ? 'Loading...' : 'Load more';
      moreBtn.disabled = bucket.loading;
      moreBtn.addEventListener('click', () => void loadTab(activeTab, { append: true }));
      scrollBody.append(moreBtn);
    }
  }

  async function loadTab(tab, { append = false } = {}) {
    if (closed || tab === 'requests') return;
    const bucket = pageCache[tab];
    bucket.loading = true;
    bucket.error = '';
    renderList();
    try {
      if (isOwnProfile) {
        const res = await fetchCentralizedConnections({
          kind: tab,
          cursors: append ? bucket.cursors : {},
        });
        if (closed) return;
        bucket.items = append
          ? mergeCentralizedConnectionAccounts(
            bucket.items,
            res?.mastoAccounts || [],
            res?.bskyAccounts || []
          )
          : (Array.isArray(res?.accounts) ? res.accounts : []);
        bucket.cursors = res?.cursors || {};
        bucket.hasMore = Boolean(res?.hasMore);
        bucket.loaded = true;
        if (res?.errors?.length) {
          statusMessage = res.errors
            .map((e) => `${e.protocol === 'bluesky' ? 'Bluesky' : 'Mastodon'}: ${e.message}`)
            .join(' · ');
        }
      } else {
        const res = await fetchFollowConnections(contextTarget.accountId || contextTarget.acct, {
          kind: tab,
          protocol: contextTarget.protocol,
          instanceUrl: contextTarget.instanceUrl,
          acct: contextTarget.acct,
          cursor: append ? bucket.cursor : '',
        });
        if (closed) return;
        const incoming = Array.isArray(res?.accounts) ? res.accounts : [];
        if (append) {
          const seen = new Set(bucket.items.map((a) => `${a.id || a.did || a.acct}`));
          for (const item of incoming) {
            const key = `${item.id || item.did || item.acct}`;
            if (!seen.has(key)) {
              seen.add(key);
              bucket.items.push(item);
            }
          }
        } else {
          bucket.items = incoming;
        }
        bucket.cursor = res?.nextCursor || '';
        bucket.hasMore = Boolean(bucket.cursor);
        bucket.loaded = true;
      }
    } catch (err) {
      if (!closed) {
        bucket.error = err?.message || `Unable to load ${tab}.`;
      }
    } finally {
      bucket.loading = false;
      renderList();
    }
  }

  updateHeadingAndControls();
  renderList();
  modal.open();
  void loadTab(activeTab === 'requests' ? 'followers' : activeTab);

  if (isOwnProfile && ownMasto) {
    void fetchPendingFollowRequests()
      .then((reqs) => {
        if (closed || !Array.isArray(reqs)) return;
        followRequests = reqs;
        if (followRequests.length > 0) updateHeadingAndControls();
      })
      .catch(() => {});
  }

  return {
    dialog: modal.dialog,
    close: modal.close,
    reload: () => loadTab(activeTab),
  };
}
