import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { canonicalizeActorHandle, isUnifiedItemModerated } from '../core/schema/unifiedItem.js';
import {
  cleanMastodonMediaUrl,
  renderProfileLinksAndFields,
  renderSanitizedHtml,
} from '../queries/fediverse.js';
import {
  addAccountToMastodonList,
  deleteUnified,
  fetchAuthorWithRelationship,
  fetchLists,
  fetchOwnStatuses,
  likeUnified,
  removeAccountFromMastodonList,
  repostUnified,
  toggleBlockAuthor,
  toggleFollowAuthor,
  toggleMuteAuthor,
} from '../queries/socialClient.js';
import { authStore } from '../state/authStore.js';
import { removeActivityByActor, updateActivityActorFollowState } from '../state/activityStore.js';
import { prefillReply } from '../state/composeStore.js';
import { feedStore, mutatePostAcrossStreams, removePostAcrossStreams } from '../state/feedStore.js';
import { connectionStore } from '../state/sanctuary/connection.js';
import { getLocalModeratedAccounts } from '../storage/nativeStore.js';
import { openFollowGraphModal } from './FollowGraphModal.js';
import { createPostCard } from './PostCard.js';
import { createClassicModalDialog, showAlert, showConfirm } from './sanctuary/SanctuaryDialog.js';
import { createLoadingState } from './ui/index.js';

/**
 * Native ActivityPub / Bluesky Author sheet dialog: profile preview, bio/metadata fields,
 * Follow/Unfollow, List membership picker, Mute, Block, and recent posts.
 */
export function openAuthorSheetModal({
  author,
  instanceUrl = 'https://mastodon.social',
  item = null,
  onRelationshipChanged,
  onReply,
  onMessageAuthor,
  onOpenPostThread,
  onAskSanctuary,
  onEditPost,
} = {}) {
  const doc = globalThis.document;
  if (!author?.id && !author?.handle && !author?.acct) return null;

  const rawAcct = String(author.handle || author.acct || '').trim().replace(/^@/, '');
  const isBridgyBluesky = rawAcct.toLowerCase().endsWith('@bsky.brid.gy');
  const isThreads = Boolean(
    !isBridgyBluesky
    && (
      author?.protocol === 'threads'
      || author?.network === 'threads'
      || item?.protocol === 'threads'
      || String(author?.url || '').includes('threads.net')
    )
  );
  const nativeAcct = isBridgyBluesky ? rawAcct.slice(0, -'@bsky.brid.gy'.length) : rawAcct;

  const protocol = isThreads
    ? 'threads'
    : (
        isBridgyBluesky
        || author?.protocol === 'bluesky'
        || author?.network === 'bluesky'
        || item?.protocol === 'bluesky'
        || String(author?.id || '').startsWith('did:')
        || String(author?.url || '').includes('bsky.app')
      )
      ? 'bluesky'
      : 'mastodon';

  let profile = {
    id: isBridgyBluesky && !String(author.id || '').startsWith('did:') ? '' : String(author.id || ''),
    displayName: author.name || author.displayName || nativeAcct,
    acct: nativeAcct,
    avatar: cleanMastodonMediaUrl(author.avatar_url || author.avatar) || DEFAULT_AVATAR_DATA_URI,
    header: cleanMastodonMediaUrl(author.header_url || author.header),
    url: author.url || (
      protocol === 'bluesky' && nativeAcct
        ? `https://bsky.app/profile/${nativeAcct}`
        : (protocol === 'threads' && nativeAcct ? `https://www.threads.net/@${nativeAcct}` : '')
    ),
    note: '',
    fields: [],
    emojis: [],
    locked: false,
    bot: false,
    followersCount: 0,
    followingCount: 0,
    statusesCount: 0,
    threadsLimited: false,
    federatedMastodonId: '',
  };
  let statsLoaded = Boolean(author.followersCount || author.followingCount || author.statusesCount);
  let rel = author.viewer
    ? {
        following: Boolean(author.viewer.following),
        followUri: author.viewer.following || null,
        followed_by: Boolean(author.viewer.followedBy),
        muting: Boolean(author.viewer.muted),
        blocking: Boolean(author.viewer.blocking),
        blockUri: author.viewer.blocking || null,
      }
    : null;
  let lists = [];
  let memberListIds = new Set();
  let recentPosts = [];
  let localModState = { blocks: [], mutes: [] };
  let loadingDetails = true;
  let actionError = '';
  let closed = false;
  let busy = false;

  const modal = createClassicModalDialog({
    id: 'author-sheet-dialog',
    maxWidth: '580px',
    onClose: () => {
      closed = true;
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.textContent = profile.displayName || `@${profile.acct}`;

  const body = doc.createElement('div');
  body.className = 'classic-modal-scroll-body author-sheet-body';
  modal.card.append(heading, body);

  async function runGraphAction(fn, fallbackMsg) {
    busy = true;
    actionError = '';
    render();
    try {
      const nextRel = await fn();
      rel = { ...(rel || {}), ...(nextRel || {}) };
      onRelationshipChanged?.(rel);
    } catch (err) {
      actionError = err?.message || fallbackMsg;
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    if (closed) return;
    body.replaceChildren();

    const hero = doc.createElement('div');
    hero.className = 'profile-hero-card is-compact';
    if (profile.header) {
      const banner = doc.createElement('img');
      banner.className = 'profile-banner-img';
      banner.src = profile.header;
      banner.alt = `${profile.displayName} banner`;
      hero.appendChild(banner);
    }

    const topRow = doc.createElement('div');
    topRow.className = 'profile-hero-top';
    const av = doc.createElement('img');
    av.className = 'profile-hero-avatar';
    av.src = profile.avatar || DEFAULT_AVATAR_DATA_URI;
    av.alt = profile.displayName || 'Author';
    const idMeta = doc.createElement('div');
    idMeta.className = 'profile-hero-names';
    const titleLine = doc.createElement('div');
    titleLine.className = 'profile-hero-title-line';
    const dn = doc.createElement('strong');
    dn.className = 'profile-display-name';
    dn.textContent = profile.displayName || profile.acct;
    const protoBadge = doc.createElement('span');
    protoBadge.className = `post-protocol-badge post-protocol-badge--${protocol}`;
    protoBadge.textContent = protocol === 'threads' ? 'Threads' : (protocol === 'bluesky' ? 'Bluesky' : 'Mastodon');
    titleLine.append(dn, protoBadge);

    const hdl = doc.createElement('span');
    hdl.className = 'post-author-handle';
    hdl.textContent = profile.acct ? `@${profile.acct}` : '';
    idMeta.append(titleLine, hdl);
    topRow.append(av, idMeta);

    if (profile.url && String(profile.url).startsWith('https://')) {
      const extLink = doc.createElement('a');
      extLink.className = 'edit-btn author-ext-link';
      extLink.setAttribute('href', profile.url);
      extLink.setAttribute('target', '_blank');
      extLink.setAttribute('rel', 'noopener noreferrer');
      extLink.textContent = 'Open ↗';
      topRow.appendChild(extLink);
    }
    hero.appendChild(topRow);

    const isAuthorModeratedInList = (listKey) => {
      const cleanAcct = String(profile.acct || '').trim().replace(/^@/, '').toLowerCase();
      const cleanId = String(profile.id || '').trim().toLowerCase();
      const canon = cleanAcct ? canonicalizeActorHandle(cleanAcct, protocol) : '';
      const rows = Array.isArray(localModState?.[listKey]) ? localModState[listKey] : [];
      if (rows.some((r) => {
        const rp = r?.protocol === 'fediverse' ? 'mastodon' : String(r?.protocol || 'threads').toLowerCase();
        if (rp !== protocol) return false;
        const rc = String(r?.canonicalActor || '').toLowerCase();
        const ra = String(r?.acct || '').replace(/^@/, '').toLowerCase();
        const ri = String(r?.id || '').toLowerCase();
        return Boolean((canon && rc === canon) || (cleanAcct && ra === cleanAcct) || (cleanId && ri === cleanId));
      })) {
        return true;
      }
      if (listKey === 'mutes') {
        const modSet = new Set((feedStore.get().moderatedActors || []).map((x) => String(x || '').toLowerCase()));
        return Boolean((canon && modSet.has(canon)) || (cleanId && (modSet.has(cleanId) || modSet.has(`${protocol}:${cleanId}`))));
      }
      return false;
    };
    const isMutedNow = Boolean(rel?.muting || isAuthorModeratedInList('mutes'));
    const isBlockedNow = Boolean(rel?.blocking || isAuthorModeratedInList('blocks'));

    const badges = doc.createElement('div');
    badges.className = 'profile-badges-row';
    if (profile.locked) {
      const b = doc.createElement('span');
      b.className = 'status-badge';
      b.textContent = 'Locked';
      badges.appendChild(b);
    }
    if (profile.bot) {
      const b = doc.createElement('span');
      b.className = 'status-badge';
      b.textContent = 'Bot';
      badges.appendChild(b);
    }
    if (rel?.followed_by) {
      const b = doc.createElement('span');
      b.className = 'status-badge status-online';
      b.textContent = 'Follows you';
      badges.appendChild(b);
    }
    if (isMutedNow) {
      const b = doc.createElement('span');
      b.className = 'status-badge status-offline';
      b.textContent = 'Muted';
      badges.appendChild(b);
    }
    if (isBlockedNow) {
      const b = doc.createElement('span');
      b.className = 'status-badge status-offline';
      b.textContent = 'Blocked';
      badges.appendChild(b);
    }
    if (badges.childNodes.length > 0) hero.appendChild(badges);

    if (profile.note) {
      const noteEl = doc.createElement('div');
      noteEl.className = 'profile-bio-html';
      renderSanitizedHtml(noteEl, profile.note, profile.emojis || []);
      hero.appendChild(noteEl);
    }

    if (Array.isArray(profile.fields) && profile.fields.length > 0) {
      const linksRow = doc.createElement('div');
      linksRow.className = 'profile-links-row';
      renderProfileLinksAndFields(linksRow, profile.fields, profile.emojis || []);
      if (linksRow.childNodes.length > 0) {
        hero.appendChild(linksRow);
      }
    }

    if (statsLoaded || !loadingDetails) {
      const stats = doc.createElement('div');
      stats.className = 'profile-stats-row';
      if (protocol === 'threads') {
        if (Number(profile.statusesCount || 0) > 0) {
          const postsLbl = doc.createElement('span');
          postsLbl.textContent = `${Number(profile.statusesCount).toLocaleString()} Posts`;
          stats.appendChild(postsLbl);
        }
        if (Number(profile.followersCount || 0) > 0) {
          const followersLbl = doc.createElement('span');
          followersLbl.textContent = `${Number(profile.followersCount).toLocaleString()} Followers`;
          stats.appendChild(followersLbl);
        } else {
          const protoLbl = doc.createElement('span');
          protoLbl.textContent = profile.federatedMastodonId ? 'Federated Threads account' : 'Threads account';
          stats.appendChild(protoLbl);
        }
      } else {
        const postsLbl = doc.createElement('span');
        postsLbl.textContent = `${Number(profile.statusesCount ?? 0).toLocaleString()} Posts`;
        const followingBtn = doc.createElement('button');
        followingBtn.type = 'button';
        followingBtn.className = 'profile-stat-btn';
        followingBtn.textContent = `${Number(profile.followingCount ?? 0).toLocaleString()} Following`;
        followingBtn.addEventListener('click', () => {
          openFollowGraphModal({
            accountId: profile.id || profile.acct,
            acct: profile.acct,
            displayName: profile.displayName || profile.acct,
            instanceUrl: protocol === 'mastodon' ? instanceUrl : 'https://bsky.app',
            protocol,
            initialTab: 'following',
            onSelectAuthor: (nextAuthor) => openAuthorSheetModal({
              author: nextAuthor,
              instanceUrl,
              onReply,
              onMessageAuthor,
              onOpenPostThread,
              onAskSanctuary,
            }),
          });
        });

        const followersBtn = doc.createElement('button');
        followersBtn.type = 'button';
        followersBtn.className = 'profile-stat-btn';
        followersBtn.textContent = `${Number(profile.followersCount ?? 0).toLocaleString()} Followers`;
        followersBtn.addEventListener('click', () => {
          openFollowGraphModal({
            accountId: profile.id || profile.acct,
            acct: profile.acct,
            displayName: profile.displayName || profile.acct,
            instanceUrl: protocol === 'mastodon' ? instanceUrl : 'https://bsky.app',
            protocol,
            initialTab: 'followers',
            onSelectAuthor: (nextAuthor) => openAuthorSheetModal({
              author: nextAuthor,
              instanceUrl,
              onReply,
              onMessageAuthor,
              onOpenPostThread,
              onAskSanctuary,
            }),
          });
        });

        stats.append(postsLbl, followingBtn, followersBtn);
      }
      hero.appendChild(stats);
    }

    const authSnapshot = authStore.get();
    const cleanThrHandle = String(profile.acct || profile.username || '').trim().replace(/^@/, '').split('@')[0].toLowerCase();
    const isThrMuted = protocol === 'threads' && Boolean(
      rel?.muting || (localModState.mutes || []).some((r) => String(r?.username || '').toLowerCase() === cleanThrHandle)
    );
    const isThrBlocked = protocol === 'threads' && Boolean(
      rel?.blocking || (localModState.blocks || []).some((r) => String(r?.username || '').toLowerCase() === cleanThrHandle)
    );
    const canInteract = protocol === 'bluesky'
      ? Boolean(authSnapshot.isBlueskyConnected)
      : (protocol === 'threads'
        ? Boolean(cleanThrHandle || (authSnapshot.isMastodonConnected && profile.federatedMastodonId))
        : Boolean(authSnapshot.isMastodonConnected));

    const actionsRow = doc.createElement('div');
    actionsRow.className = 'author-sheet-actions';

    const actionTargetId = protocol === 'threads' && profile.federatedMastodonId
      ? profile.federatedMastodonId
      : (profile.id || profile.acct);
    const canModerateRemote = Boolean(actionTargetId || profile.acct);

    const buildFollowButton = (targetId, opts) => {
      const followBtn = doc.createElement('button');
      followBtn.type = 'button';
      followBtn.className = `btn-sleek-pill ${rel?.following ? 'is-active' : ''}`;
      followBtn.disabled = busy;
      followBtn.textContent = rel?.following ? 'Following' : (rel?.requested ? 'Requested' : 'Follow');
      followBtn.addEventListener('click', () =>
        void runGraphAction(
          async () => {
            const wasFollowing = Boolean(rel?.following);
            const res = await toggleFollowAuthor(targetId, wasFollowing, opts);
            const nextRequested = Boolean(res?.requested && !res?.following);
            const nextFollowing = typeof res?.following === 'boolean' ? res.following : (!wasFollowing && !nextRequested);
            updateActivityActorFollowState(
              { id: targetId, handle: profile.acct || '' },
              opts.protocol,
              { following: nextFollowing, requested: nextRequested, followUri: String(res?.followUri || '') }
            );
            return res;
          },
          'Unable to update follow status.'
        )
      );
      return followBtn;
    };

    const extractHost = (rawUrl) => {
      try {
        return rawUrl ? new URL(String(rawUrl)).host.toLowerCase() : '';
      } catch {
        return '';
      }
    };
    const buildDmRecipient = () => {
      if (protocol === 'bluesky') {
        const handle = String(profile.acct || nativeAcct || '').trim().replace(/^@/, '');
        const did = String(profile.id || '').startsWith('did:') ? String(profile.id) : '';
        return {
          protocol: 'bluesky',
          handle,
          did,
          displayName: profile.displayName || handle,
          avatar: profile.avatar || '',
        };
      }
      let handle = protocol === 'threads'
        ? (String(profile.acct || '').includes('@') ? String(profile.acct).replace(/^@/, '') : (cleanThrHandle ? `${cleanThrHandle}@threads.net` : ''))
        : String(profile.acct || '').trim().replace(/^@/, '');
      if (protocol === 'mastodon' && handle && !handle.includes('@')) {
        const ownFedi = (authSnapshot.accounts || []).find((a) => a.platform === 'fediverse');
        const ownHost = extractHost(ownFedi?.instanceUrl);
        const profileHost = extractHost(profile.url) || extractHost(instanceUrl);
        if (profileHost && (!ownHost || profileHost !== ownHost)) {
          handle = `${handle}@${profileHost}`;
        }
      }
      return {
        protocol: 'mastodon',
        handle,
        did: '',
        displayName: profile.displayName || (handle ? `@${handle}` : ''),
        avatar: profile.avatar || '',
      };
    };
    const buildMessageButton = () => {
      const msgBtn = doc.createElement('button');
      msgBtn.type = 'button';
      msgBtn.className = 'edit-btn edit-save-btn author-dm-btn';
      msgBtn.disabled = busy;
      msgBtn.textContent = 'Message';
      msgBtn.addEventListener('click', () => {
        const target = buildDmRecipient();
        if (!target?.handle && !target?.did) return;
        modal.close();
        if (typeof onMessageAuthor === 'function') {
          onMessageAuthor(target);
        } else {
          doc.dispatchEvent?.(new CustomEvent('sanctuary:open-dm', { detail: target }));
        }
      });
      return msgBtn;
    };

    if (canInteract && protocol === 'threads') {
      if (authSnapshot.isMastodonConnected && profile.federatedMastodonId) {
        actionsRow.appendChild(buildFollowButton(profile.federatedMastodonId, { protocol: 'mastodon' }));
        actionsRow.appendChild(buildMessageButton());
      }
      const muteBtn = doc.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'edit-btn edit-cancel-btn';
      muteBtn.disabled = busy;
      muteBtn.textContent = isThrMuted ? 'Unmute' : 'Mute';
      muteBtn.addEventListener('click', () =>
        void runGraphAction(
          async () => {
            const res = await toggleMuteAuthor(cleanThrHandle || profile.id, isThrMuted, {
              protocol: 'threads',
              acct: cleanThrHandle,
              displayName: profile.displayName || cleanThrHandle,
            });
            localModState = await getLocalModeratedAccounts().catch(() => localModState);
            if (!isThrMuted) {
              removeActivityByActor(profile, 'threads');
              removePostAcrossStreams((it) => isUnifiedItemModerated(it, feedStore.get().moderatedActors) || it?.author?.handle === profile.acct || it?.author?.id === profile.id);
            }
            return res;
          },
          'Unable to update mute status.'
        )
      );
      const blockBtn = doc.createElement('button');
      blockBtn.type = 'button';
      blockBtn.className = 'edit-btn edit-cancel-btn';
      blockBtn.disabled = busy;
      blockBtn.textContent = isThrBlocked ? 'Unblock' : 'Block';
      blockBtn.addEventListener('click', () =>
        void runGraphAction(
          async () => {
            const res = await toggleBlockAuthor(cleanThrHandle || profile.id, isThrBlocked, {
              protocol: 'threads',
              acct: cleanThrHandle,
              displayName: profile.displayName || cleanThrHandle,
            });
            localModState = await getLocalModeratedAccounts().catch(() => localModState);
            if (!isThrBlocked) {
              removeActivityByActor(profile, 'threads');
              removePostAcrossStreams((it) => isUnifiedItemModerated(it, feedStore.get().moderatedActors) || it?.author?.handle === profile.acct || it?.author?.id === profile.id);
            }
            return res;
          },
          'Unable to update block status.'
        )
      );
      actionsRow.append(muteBtn, blockBtn);
      if (!(authSnapshot.isMastodonConnected && profile.federatedMastodonId)) {
        const hint = doc.createElement('span');
        hint.className = 'classic-card-subtext';
        hint.textContent = 'Follows are managed on Threads.';
        actionsRow.appendChild(hint);
      }
    } else if (canInteract || canModerateRemote) {
      const actionOpts = {
        protocol: protocol === 'threads' ? 'mastodon' : protocol,
        acct: profile.acct || '',
        displayName: profile.displayName || profile.acct || '',
        instanceUrl,
        followUri: rel?.followUri || null,
        blockUri: rel?.blockUri || null,
      };
      if (canInteract) {
        actionsRow.appendChild(buildFollowButton(actionTargetId, actionOpts));
        actionsRow.appendChild(buildMessageButton());
      }

      const muteBtn = doc.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'edit-btn edit-cancel-btn';
      muteBtn.disabled = busy;
      muteBtn.textContent = isMutedNow ? 'Unmute' : 'Mute';
      muteBtn.addEventListener('click', () =>
        void runGraphAction(
          async () => {
            const wasMuted = isMutedNow;
            const res = await toggleMuteAuthor(actionTargetId, wasMuted, actionOpts);
            localModState = await getLocalModeratedAccounts().catch(() => localModState);
            if (!wasMuted) {
              removeActivityByActor(profile, actionOpts.protocol);
              removePostAcrossStreams(
                (it) =>
                  isUnifiedItemModerated(it, feedStore.get().moderatedActors)
                  || it?.author?.handle === profile.acct
                  || (profile.id && it?.author?.id === profile.id)
              );
            }
            return res;
          },
          'Unable to update mute status.'
        )
      );

      const blockBtn = doc.createElement('button');
      blockBtn.type = 'button';
      blockBtn.className = 'edit-btn edit-cancel-btn';
      blockBtn.disabled = busy;
      blockBtn.textContent = isBlockedNow ? 'Unblock' : 'Block';
      blockBtn.addEventListener('click', () =>
        void runGraphAction(
          async () => {
            const wasBlocked = isBlockedNow;
            const res = await toggleBlockAuthor(actionTargetId, wasBlocked, actionOpts);
            localModState = await getLocalModeratedAccounts().catch(() => localModState);
            if (!wasBlocked) {
              removeActivityByActor(profile, actionOpts.protocol);
              removePostAcrossStreams(
                (it) =>
                  isUnifiedItemModerated(it, feedStore.get().moderatedActors)
                  || it?.author?.handle === profile.acct
                  || (profile.id && it?.author?.id === profile.id)
              );
            }
            return res;
          },
          'Unable to update block status.'
        )
      );

      actionsRow.append(muteBtn, blockBtn);
      if (!canInteract) {
        const hint = doc.createElement('span');
        hint.className = 'classic-card-subtext';
        hint.textContent = protocol === 'threads'
          ? 'Follows are managed on Threads.'
          : `Connect ${protocol === 'bluesky' ? 'Bluesky' : 'Mastodon'} under Profile → Accounts & Bridges to follow (Mute/Block saved locally).`;
        actionsRow.appendChild(hint);
      }
    } else {
      const hint = doc.createElement('span');
      hint.className = 'classic-card-subtext';
      hint.textContent = protocol === 'threads'
        ? 'Follow and moderation for Threads accounts are managed on Threads — use Open ↗.'
        : `Connect ${protocol === 'bluesky' ? 'Bluesky' : 'Mastodon'} under Profile → Accounts & Bridges to follow, mute, or block.`;
      actionsRow.appendChild(hint);
    }
    hero.appendChild(actionsRow);

    if (actionError) {
      const errEl = doc.createElement('p');
      errEl.className = 'classic-modal-status author-action-error';
      errEl.setAttribute('role', 'alert');
      errEl.textContent = actionError;
      hero.appendChild(errEl);
    }

    if (protocol === 'mastodon' && lists.length > 0 && rel?.following) {
      const listsBox = doc.createElement('div');
      listsBox.className = 'author-lists-row';
      const lbl = doc.createElement('span');
      lbl.className = 'classic-card-subtext';
      lbl.textContent = 'Lists:';
      listsBox.appendChild(lbl);
      for (const lst of lists) {
        const chip = doc.createElement('button');
        chip.type = 'button';
        const inList = memberListIds.has(String(lst.id));
        chip.className = `btn-sleek-pill${inList ? ' is-active' : ''}`;
        chip.textContent = inList ? `✓ ${lst.title}` : `+ ${lst.title}`;
        chip.addEventListener('click', async () => {
          if (inList) {
            await removeAccountFromMastodonList(lst.id, profile.id);
            memberListIds.delete(String(lst.id));
          } else {
            await addAccountToMastodonList(lst.id, profile.id);
            memberListIds.add(String(lst.id));
          }
          render();
        });
        listsBox.appendChild(chip);
      }
      hero.appendChild(listsBox);
    }

    body.appendChild(hero);

    const recentSection = doc.createElement('div');
    recentSection.className = 'author-recent-section';
    const secHeader = doc.createElement('div');
    secHeader.className = 'author-recent-header';
    secHeader.textContent = 'Recent Posts';
    recentSection.appendChild(secHeader);

    if (loadingDetails && recentPosts.length === 0) {
      recentSection.appendChild(createLoadingState('Loading profile & recent posts…', { doc, compact: true }));
    } else if (recentPosts.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = protocol === 'threads' && profile.threadsLimited
        ? 'Threads does not expose other users’ timelines via the API — use Open ↗ to view their posts on Threads.'
        : 'No public posts yet.';
      recentSection.appendChild(empty);
    } else {
      const connState = connectionStore.get();
      const showSanctuary = connState.mode === 'online' || connState.programs.length > 0;
      for (const p of recentPosts) {
        recentSection.appendChild(
          createPostCard(p, {
            onReply: (target) => {
              modal.close();
              if (onReply) onReply(target);
              else prefillReply(target);
            },
            onOpenThread: (target) => {
              modal.close();
              if (onOpenPostThread) onOpenPostThread(target);
              else doc.dispatchEvent(new CustomEvent('sanctuary:open-post', { detail: target }));
            },
            onToggleLike: async (target) => {
              const updated = await likeUnified(target);
              if (updated) {
                recentPosts = recentPosts.map((x) => (x === target || (x.id && x.id === target.id) ? updated : x));
                render();
              }
            },
            onToggleRepost: async (target) => {
              const updated = await repostUnified(target);
              if (updated) {
                recentPosts = recentPosts.map((x) => (x === target || (x.id && x.id === target.id) ? updated : x));
                render();
              }
            },
            onAskSanctuary: onAskSanctuary
              ? (target) => {
                  modal.close();
                  onAskSanctuary(target);
                }
              : null,
            onEditPost: onEditPost
              ? (target) => {
                  onEditPost(target, (updated) => {
                    if (!updated) return;
                    recentPosts = recentPosts.map((x) => (x === target || (x.id && x.id === updated.id) ? updated : x));
                    mutatePostAcrossStreams(updated.id, () => updated);
                    render();
                  });
                }
              : null,
            onDeletePost: (target) => {
              showConfirm(
                'Delete Post',
                target?._meta?.linkedIds?.blueskyUri || target?._meta?.linkedIds?.threadsPostId
                  ? 'Delete this post from Mastodon and all linked bridges?'
                  : 'Delete this post?',
                async () => {
                  const res = await deleteUnified(target);
                  recentPosts = recentPosts.filter((x) => x !== target && (!target?.id || x.id !== target.id));
                  removePostAcrossStreams(target?.id || target?.key);
                  render();
                  if (res?.warnings?.length > 0) {
                    showAlert('Bridge Delete Warning', res.warnings.join('\n\n'));
                  }
                }
              );
            },
            showSanctuaryAction: showSanctuary,
          })
        );
      }
    }
    body.appendChild(recentSection);
  }

  render();
  modal.open();

  void (async () => {
    let fetchErrorMsg = '';
    try {
      let detail = null;
      try {
        detail = await fetchAuthorWithRelationship(profile.id || profile.acct, instanceUrl, {
          protocol,
          acct: profile.acct,
        });
      } catch (err) {
        fetchErrorMsg = err?.message || 'Unable to load full profile.';
      }
      if (closed) return;
      if (detail?.profile) {
        profile = {
          ...profile,
          ...detail.profile,
          id: String(detail.profile.id || profile.id || ''),
          displayName: detail.profile.display_name || detail.profile.displayName || profile.displayName,
          acct: String(detail.profile.acct || profile.acct || '').replace(/^@/, ''),
          avatar: cleanMastodonMediaUrl(detail.profile.avatar_url || detail.profile.avatar) || profile.avatar,
          header: cleanMastodonMediaUrl(detail.profile.header_url || detail.profile.header),
          url: detail.profile.url || profile.url || '',
          note: detail.profile.note_html || detail.profile.note || '',
          fields: Array.isArray(detail.profile.fields) ? detail.profile.fields : profile.fields,
          emojis: Array.isArray(detail.profile.emojis) ? detail.profile.emojis : profile.emojis,
          locked: Boolean(detail.profile.locked),
          bot: Boolean(detail.profile.bot),
          followersCount: detail.profile.followers_count ?? detail.profile.followersCount ?? 0,
          followingCount: detail.profile.following_count ?? detail.profile.followingCount ?? 0,
          statusesCount: detail.profile.statuses_count ?? detail.profile.statusesCount ?? 0,
          threadsLimited: Boolean(detail.profile.threadsLimited),
          federatedMastodonId: String(detail.profile.federatedMastodonId || profile.federatedMastodonId || ''),
        };
        statsLoaded = true;
      }
      rel = detail?.relationship || rel;
      heading.textContent = profile.displayName || `@${profile.acct}`;

      const statusInstanceUrl = detail?.resolvedInstanceUrl || (protocol === 'mastodon' ? instanceUrl : (protocol === 'threads' ? 'https://www.threads.net' : 'https://bsky.app'));
      const [statuses, userLists, freshLocalMod] = await Promise.all([
        fetchOwnStatuses(profile.id || profile.acct, {
          tab: 'posts',
          instanceUrl: statusInstanceUrl,
          protocol,
          acct: profile.acct,
          federatedMastodonId: profile.federatedMastodonId || '',
        }).catch(() => []),
        protocol === 'mastodon' && authStore.get().isMastodonConnected
          ? fetchLists().catch(() => [])
          : Promise.resolve([]),
        getLocalModeratedAccounts().catch(() => ({ blocks: [], mutes: [] })),
      ]);
      if (closed) return;
      lists = Array.isArray(userLists) ? userLists : [];
      recentPosts = Array.isArray(statuses) ? statuses.slice(0, 10) : [];
      localModState = freshLocalMod;
      if (!detail?.profile && recentPosts.length === 0 && fetchErrorMsg) {
        actionError = fetchErrorMsg;
      }
      statsLoaded = true;
    } catch (err) {
      if (!actionError && err?.message) actionError = err.message;
      statsLoaded = true;
    } finally {
      loadingDetails = false;
      render();
    }
  })();

  return modal;
}
