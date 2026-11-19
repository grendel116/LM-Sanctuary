import { createOfflineNotice } from '../components/OfflineNotice.js';
import { createPostCard } from '../components/PostCard.js';
import { createLoadingState } from '../components/ui/index.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import {
  fetchUnifiedNotifications,
  likeUnified,
  repostUnified,
  toggleFollowAuthor,
} from '../queries/socialClient.js';
import { authStore, getAuthenticatedAccount } from '../state/authStore.js';
import { prefillReply } from '../state/composeStore.js';
import { connectionStore } from '../state/sanctuary/connection.js';

const NOTIFICATION_LABELS = {
  mention: 'mentioned you',
  reply: 'replied to you',
  quote: 'quoted your post',
  reblog: 'boosted your post',
  repost: 'reposted your post',
  favourite: 'favourited your post',
  like: 'liked your post',
  follow: 'followed you',
  follow_request: 'requested to follow you',
  poll: 'ended a poll',
  status: 'posted',
};

/**
 * Activity view: merged chronological notifications across Mastodon, Bluesky, and Threads.
 */
export function mountActivityScreen(containerEl, {
  onOpenPostThread,
  onAskSanctuary,
  onOpenAccounts,
  onSelectAuthor,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();
  let destroyed = false;

  const root = doc.createElement('section');
  root.className = 'activity-screen';

  const header = doc.createElement('div');
  header.className = 'stage-header';
  const h1 = doc.createElement('h1');
  h1.className = 'stage-title';
  h1.textContent = 'Activity';
  const refreshBtn = doc.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'edit-btn edit-cancel-btn';
  refreshBtn.textContent = 'Refresh';
  header.append(h1, refreshBtn);

  const listEl = doc.createElement('div');
  listEl.className = 'activity-list';
  root.append(header, listEl);
  containerEl.appendChild(root);

  async function loadNotifications() {
    if (destroyed) return;
    listEl.replaceChildren(createLoadingState('Loading notifications…'));

    try {
      const [fedi, bsky, thr] = await Promise.all([
        getAuthenticatedAccount('fediverse'),
        getAuthenticatedAccount('bluesky'),
        getAuthenticatedAccount('threads'),
      ]);
      if (destroyed) return;
      if (!fedi && !bsky && !thr && (authStore.get().accounts || []).length === 0) {
        const notice = createOfflineNotice({
          variant: 'info',
          message: 'Connect Mastodon under Profile → Accounts & Bridges to view notifications.',
          actionLabel: 'Accounts',
          onAction: () => onOpenAccounts?.(),
        });
        listEl.replaceChildren(notice);
        return;
      }

      const { items = [] } = await fetchUnifiedNotifications({ limit: 35 });
      if (destroyed) return;

      if (!items || items.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'No notifications.';
        listEl.replaceChildren(empty);
        return;
      }

      const showSanctuary = connectionStore.get().mode === 'online' || connectionStore.get().programs.length > 0;
      listEl.replaceChildren(
        ...items.map((n) => {
          const notifMeta = n._meta?.notification || {};
          const actor = notifMeta.actor || n.author || {};
          const kind = notifMeta.type || n.type || 'mention';

          const row = doc.createElement('div');
          row.className = 'activity-row';

          const summaryLine = doc.createElement('div');
          summaryLine.className = 'activity-row-header';

          const avatar = doc.createElement('img');
          avatar.className = 'post-avatar';
          avatar.src = actor.avatar_url || actor.avatar || DEFAULT_AVATAR_DATA_URI;
          avatar.alt = actor.name || actor.handle || 'Account';

          const actorBtn = doc.createElement('button');
          actorBtn.type = 'button';
          actorBtn.className = 'activity-actor-btn';
          const who = actor.name || actor.handle || 'User';
          const verb = NOTIFICATION_LABELS[kind] || kind || 'interacted';
          actorBtn.textContent = `${who} ${verb}`;
          actorBtn.addEventListener('click', () => {
            if (actor.id || actor.handle) onSelectAuthor?.(actor, n);
          });

          const protoBadge = doc.createElement('span');
          protoBadge.className = `post-protocol-badge post-protocol-badge--${n.protocol || 'mastodon'}`;
          protoBadge.textContent = n.protocol || 'mastodon';

          summaryLine.append(avatar, actorBtn, protoBadge);

          if ((kind === 'follow' || kind === 'follow_request') && fedi && actor.id && n.protocol === 'mastodon') {
            const followBtn = doc.createElement('button');
            followBtn.type = 'button';
            followBtn.className = 'btn-sleek-pill activity-follow-btn';
            followBtn.textContent = 'Follow Back';
            followBtn.addEventListener('click', async () => {
              followBtn.disabled = true;
              await toggleFollowAuthor(actor.id, false);
              followBtn.textContent = 'Following';
            });
            summaryLine.appendChild(followBtn);
          }

          row.appendChild(summaryLine);

          const hasPostBody = Boolean(n.content_text?.trim() || n._meta?.mastodon?.statusId || n._meta?.bluesky?.uri || n._meta?.threads?.postId);
          if (hasPostBody && kind !== 'follow') {
            row.appendChild(
              createPostCard(n, {
                onOpenThread: onOpenPostThread,
                onReply: (p) => prefillReply(p),
                onToggleLike: (p) => void likeUnified(p),
                onToggleRepost: (p) => void repostUnified(p),
                onSelectAuthor,
                onAskSanctuary,
                showSanctuaryAction: showSanctuary,
              })
            );
          }
          return row;
        })
      );
    } catch (err) {
      if (destroyed) return;
      listEl.replaceChildren(
        createOfflineNotice({ variant: 'error', message: err?.message || 'Unable to load activity.' })
      );
    }
  }

  refreshBtn.addEventListener('click', () => void loadNotifications());

  const buildAuthSig = (s) =>
    `${Boolean(s?.hydrated)}:${s?.activeFediverseId || ''}:${s?.activeBlueskyId || ''}:${s?.activeThreadsId || ''}:${(s?.accounts || []).map((a) => a.id).join(',')}`;
  let prevAuthSig = buildAuthSig(authStore.get());
  const unsubAuth = authStore.subscribe((authState) => {
    if (destroyed) return;
    const sig = buildAuthSig(authState);
    if (sig !== prevAuthSig) {
      prevAuthSig = sig;
      void loadNotifications();
    }
  });

  void loadNotifications();

  return {
    refresh: loadNotifications,
    destroy() {
      destroyed = true;
      unsubAuth();
    },
  };
}
