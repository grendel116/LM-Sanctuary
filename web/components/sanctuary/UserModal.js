import { createUserIconSvg, DEFAULT_AVATAR_DATA_URI } from '../../constants/avatars.js';
import { createBskySession, getBskyProfile } from '../../queries/bluesky.js';
import {
  buildOAuthAuthorizeUrl,
  registerOAuthApp,
  verifyCredentials,
} from '../../queries/fediverse.js';
import { dismissBridgeRetry, runBridgeRetry } from '../../queries/socialClient.js';
import { verifyThreadsCredentials } from '../../queries/threads.js';
import {
  authStore,
  removeSocialAccount,
  upsertSocialAccount,
} from '../../state/authStore.js';
import { kvSet } from '../../storage/nativeStore.js';
import { createClassicModalDialog } from './SanctuaryDialog.js';

function extractFediverseInstance(rawInput) {
  let clean = String(rawInput || '').trim() || 'mastodon.social';
  if (clean.includes('@') && !clean.includes('://')) {
    const parts = clean.split('@').filter(Boolean);
    clean = parts[parts.length - 1] || 'mastodon.social';
  }
  return clean.replace(/\/+$/, '').trim();
}

const ACCOUNTS_SVG = createUserIconSvg({ size: 18, stroke: 'var(--primary-accent)', strokeWidth: 2.2 });

/**
 * Streamlined Accounts & Bridges modal (Mastodon primary OAuth2/token + auto-active Bluesky & Threads bridges).
 * Separate Sanctuary personas are removed so Programs identify the user directly from Mastodon.
 */
export function openUserModal({
  onAccountsUpdated,
} = {}) {
  const doc = globalThis.document;
  let closed = false;

  const modal = createClassicModalDialog({
    id: 'user-accounts-dialog',
    maxWidth: '580px',
    onClose: () => {
      closed = true;
      unsubAuth();
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${ACCOUNTS_SVG}<span>Accounts & Bridges</span>`;

  const feedbackEl = doc.createElement('p');
  feedbackEl.className = 'classic-modal-status user-modal-feedback';
  feedbackEl.setAttribute('role', 'status');
  feedbackEl.setAttribute('aria-live', 'polite');
  feedbackEl.hidden = true;

  const bodyHost = doc.createElement('div');
  bodyHost.className = 'classic-modal-scroll-body';

  modal.card.append(heading, feedbackEl, bodyHost);

  function setStatus(msg) {
    const clean = String(msg || '').trim();
    feedbackEl.textContent = clean;
    feedbackEl.hidden = !clean;
  }

  function renderBody() {
    if (closed) return;
    const s = authStore.get();
    const accounts = s.accounts || [];
    const retryQueue = s.retryQueue || [];

    const desc = doc.createElement('p');
    desc.className = 'classic-modal-desc';
    desc.textContent = 'Mastodon is your primary social home and identifies you to Sanctuary Programs. Connected Bluesky and Threads bridges activate automatically.';

    const wrap = doc.createElement('div');
    wrap.className = 'classic-cards-stack';

    if (accounts.length > 0) {
      const connectedBox = doc.createElement('div');
      connectedBox.className = 'form-card-container';
      const ch4 = doc.createElement('div');
      ch4.className = 'modal-section-header';
      const ch4Title = doc.createElement('span');
      ch4Title.textContent = 'Connected Accounts';
      ch4.appendChild(ch4Title);
      connectedBox.appendChild(ch4);

      for (const acc of accounts) {
        const row = doc.createElement('div');
        row.className = 'account-connected-row';

        const metaWrap = doc.createElement('div');
        metaWrap.className = 'account-connected-meta';
        const avatar = doc.createElement('img');
        avatar.className = 'account-connected-avatar';
        avatar.src = acc.avatar || DEFAULT_AVATAR_DATA_URI;
        avatar.alt = '';

        const info = doc.createElement('div');
        info.className = 'account-connected-text';
        const titleRow = doc.createElement('div');
        titleRow.className = 'account-connected-title-row';
        const name = doc.createElement('strong');
        name.className = 'account-connected-name';
        name.textContent = acc.displayName || acc.handle || acc.acct;
        const protoBadge = doc.createElement('span');
        protoBadge.className = 'post-protocol-badge';
        protoBadge.textContent = acc.platform === 'fediverse' ? 'Mastodon · Primary' : `${acc.platform === 'bluesky' ? 'Bluesky' : 'Threads'} · Connected`;
        titleRow.append(name, protoBadge);

        const sub = doc.createElement('span');
        sub.className = 'classic-card-subtext';
        sub.textContent = `@${String(acc.acct || acc.handle || '').replace(/^@/, '')}`;
        info.append(titleRow, sub);
        metaWrap.append(avatar, info);

        const discBtn = doc.createElement('button');
        discBtn.type = 'button';
        discBtn.className = 'edit-btn edit-cancel-btn';
        discBtn.textContent = 'Disconnect';
        discBtn.addEventListener('click', async () => {
          await removeSocialAccount(acc.id);
          setStatus(`Disconnected ${acc.acct || acc.handle}.`);
          await onAccountsUpdated?.();
          renderBody();
        });
        row.append(metaWrap, discBtn);
        connectedBox.appendChild(row);
      }
      wrap.appendChild(connectedBox);
    }

    if (retryQueue.length > 0) {
      const retryBox = doc.createElement('div');
      retryBox.className = 'form-card-container';
      const rh4 = doc.createElement('div');
      rh4.className = 'modal-section-header';
      const rh4Title = doc.createElement('span');
      rh4Title.textContent = 'Pending Bridge Retries';
      rh4.appendChild(rh4Title);
      retryBox.appendChild(rh4);

      for (const r of retryQueue) {
        const row = doc.createElement('div');
        row.className = 'account-connected-row';
        const metaWrap = doc.createElement('div');
        metaWrap.className = 'account-connected-meta';
        const info = doc.createElement('div');
        info.className = 'account-connected-text';
        const title = doc.createElement('strong');
        title.className = 'account-connected-name';
        title.textContent = `${r.protocol} ${r.operation}`;
        const sub = doc.createElement('span');
        sub.className = 'classic-card-subtext';
        sub.textContent = r.lastError || 'Temporary rate limit';
        info.append(title, sub);
        metaWrap.appendChild(info);

        const acts = doc.createElement('div');
        acts.className = 'classic-card-actions';
        const rBtn = doc.createElement('button');
        rBtn.type = 'button';
        rBtn.className = 'btn-sleek-pill';
        rBtn.textContent = 'Retry';
        rBtn.addEventListener('click', async () => {
          try {
            await runBridgeRetry(r.id);
            setStatus(`Retried ${r.protocol} ${r.operation}.`);
          } catch (err) {
            setStatus(err?.message || 'Retry failed.');
          }
          renderBody();
        });
        const dBtn = doc.createElement('button');
        dBtn.type = 'button';
        dBtn.className = 'edit-btn edit-cancel-btn';
        dBtn.textContent = 'Dismiss';
        dBtn.addEventListener('click', async () => {
          await dismissBridgeRetry(r.id);
          renderBody();
        });
        acts.append(rBtn, dBtn);
        row.append(metaWrap, acts);
        retryBox.appendChild(row);
      }
      wrap.appendChild(retryBox);
    }

    // 1. Mastodon (Primary Home)
    const fediForm = doc.createElement('form');
    fediForm.className = 'form-card-container account-login-card';
    const fediHead = doc.createElement('div');
    fediHead.className = 'option-header';
    const fediH = doc.createElement('h4');
    fediH.style.margin = '0';
    fediH.textContent = 'Mastodon (Primary Home)';
    const fediBadge = doc.createElement('span');
    fediBadge.className = `status-badge ${s.isMastodonConnected ? 'status-online' : 'status-offline'}`;
    fediBadge.textContent = s.isMastodonConnected ? 'Connected' : 'Required';
    fediHead.append(fediH, fediBadge);

    const fediHint = doc.createElement('p');
    fediHint.className = 'account-card-hint';
    fediHint.textContent = 'Defaults to mastodon.social. Scopes: read write follow push.';

    const fediFields = doc.createElement('div');
    fediFields.className = 'classic-two-col';

    const fediInstGroup = doc.createElement('div');
    fediInstGroup.className = 'input-group';
    const fediInstLbl = doc.createElement('label');
    fediInstLbl.setAttribute('for', 'user-fedi-instance');
    fediInstLbl.textContent = 'Instance';
    const fediInstIn = doc.createElement('input');
    fediInstIn.type = 'text';
    fediInstIn.id = 'user-fedi-instance';
    fediInstIn.className = 'onboarding-input';
    fediInstIn.placeholder = 'https://mastodon.social';
    fediInstIn.value = 'https://mastodon.social';
    fediInstIn.setAttribute('autocorrect', 'off');
    fediInstIn.setAttribute('autocapitalize', 'none');
    fediInstIn.setAttribute('spellcheck', 'false');
    fediInstGroup.append(fediInstLbl, fediInstIn);

    const tokGroup = doc.createElement('div');
    tokGroup.className = 'input-group';
    const tokLbl = doc.createElement('label');
    tokLbl.setAttribute('for', 'user-fedi-token');
    tokLbl.textContent = 'Access Token (optional)';
    const tokIn = doc.createElement('input');
    tokIn.type = 'password';
    tokIn.id = 'user-fedi-token';
    tokIn.className = 'onboarding-input';
    tokIn.placeholder = 'Paste token or leave blank for OAuth2';
    tokGroup.append(tokLbl, tokIn);

    fediFields.append(fediInstGroup, tokGroup);

    const fediBtn = doc.createElement('button');
    fediBtn.type = 'submit';
    fediBtn.className = 'onboarding-btn';
    fediBtn.textContent = s.isMastodonConnected ? 'Reconnect Mastodon' : 'Connect Mastodon';

    fediForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const inst = extractFediverseInstance(fediInstIn.value);
      const tok = tokIn.value.trim();
      fediBtn.disabled = true;
      try {
        if (tok) {
          const profile = await verifyCredentials({ instanceUrl: inst, accessToken: tok });
          const originHost = new URL(inst.includes('://') ? inst : `https://${inst}`).host;
          await upsertSocialAccount(
            {
              id: `fediverse:${profile.acct}`,
              platform: 'fediverse',
              instanceUrl: `https://${originHost}`,
              handle: profile.username,
              acct: profile.acct,
              displayName: profile.displayName || profile.username,
              avatar: profile.avatar || '',
              header: profile.header || '',
              url: profile.url || '',
              note: profile.note || '',
              noteText: profile.noteText || '',
              fields: profile.fields || [],
              locked: profile.locked,
              bot: profile.bot,
              discoverable: profile.discoverable,
              indexable: profile.indexable,
              hideCollections: profile.hideCollections,
              defaultVisibility: profile.defaultVisibility,
              defaultSensitive: profile.defaultSensitive,
              defaultLanguage: profile.defaultLanguage,
              attributionDomains: profile.attributionDomains || [],
              emojis: profile.emojis || [],
              followersCount: profile.followersCount,
              followingCount: profile.followingCount,
              statusesCount: profile.statusesCount,
              userId: profile.id,
            },
            { accessToken: tok }
          );
          tokIn.value = '';
          setStatus(`Connected @${profile.acct}`);
          await onAccountsUpdated?.();
          renderBody();
        } else {
          const redirectUri = `${globalThis.location.origin}${globalThis.location.pathname}`;
          const safeWebsite = /^https:\/\//i.test(redirectUri) && !/^https:\/\/localhost\b/i.test(redirectUri)
            ? redirectUri
            : undefined;
          const app = await registerOAuthApp({
            instanceUrl: inst,
            redirectUri,
            scopes: 'read write follow push',
            website: safeWebsite,
          });
          await kvSet('pending_oauth_app', {
            instanceUrl: inst,
            clientId: app.client_id,
            clientSecret: app.client_secret,
            redirectUri,
          });
          const authUrl = buildOAuthAuthorizeUrl({
            instanceUrl: inst,
            clientId: app.client_id,
            redirectUri,
            scope: 'read write follow push',
          });
          globalThis.location.assign(authUrl);
        }
      } catch (err) {
        setStatus(err?.message || 'Mastodon connection failed.');
      } finally {
        fediBtn.disabled = false;
      }
    });
    fediForm.append(fediHead, fediHint, fediFields, fediBtn);
    wrap.appendChild(fediForm);

    // 2. Bluesky Bridge (Auto-Active)
    const bskyForm = doc.createElement('form');
    bskyForm.className = 'form-card-container account-login-card';
    const bskyHead = doc.createElement('div');
    bskyHead.className = 'option-header';
    const bskyH = doc.createElement('h4');
    bskyH.style.margin = '0';
    bskyH.textContent = 'Bluesky Bridge';
    const bskyBadge = doc.createElement('span');
    bskyBadge.className = `status-badge ${s.isBlueskyConnected ? 'status-online' : ''}`;
    bskyBadge.textContent = s.isBlueskyConnected ? 'Connected' : 'Optional';
    bskyHead.append(bskyH, bskyBadge);

    const bskyHint = doc.createElement('p');
    bskyHint.className = 'account-card-hint';
    bskyHint.textContent = 'Automatically fans out posts, syncs deletions, and merges Bluesky notifications.';

    const bskyFields = doc.createElement('div');
    bskyFields.className = 'classic-two-col';

    const bskyHandleGroup = doc.createElement('div');
    bskyHandleGroup.className = 'input-group';
    const bskyHandleLbl = doc.createElement('label');
    bskyHandleLbl.setAttribute('for', 'user-bsky-handle');
    bskyHandleLbl.textContent = 'Handle';
    const bskyHandleIn = doc.createElement('input');
    bskyHandleIn.type = 'text';
    bskyHandleIn.id = 'user-bsky-handle';
    bskyHandleIn.className = 'onboarding-input';
    bskyHandleIn.placeholder = 'you.bsky.social';
    bskyHandleIn.setAttribute('autocorrect', 'off');
    bskyHandleIn.setAttribute('autocapitalize', 'none');
    bskyHandleIn.setAttribute('spellcheck', 'false');
    bskyHandleGroup.append(bskyHandleLbl, bskyHandleIn);

    const bskyPassGroup = doc.createElement('div');
    bskyPassGroup.className = 'input-group';
    const bskyPassLbl = doc.createElement('label');
    bskyPassLbl.setAttribute('for', 'user-bsky-pass');
    bskyPassLbl.textContent = 'App Password';
    const bskyPassIn = doc.createElement('input');
    bskyPassIn.type = 'password';
    bskyPassIn.id = 'user-bsky-pass';
    bskyPassIn.className = 'onboarding-input';
    bskyPassIn.placeholder = 'xxxx-xxxx-xxxx-xxxx';
    bskyPassGroup.append(bskyPassLbl, bskyPassIn);

    bskyFields.append(bskyHandleGroup, bskyPassGroup);

    const bskyBtn = doc.createElement('button');
    bskyBtn.type = 'submit';
    bskyBtn.className = 'onboarding-btn';
    bskyBtn.textContent = s.isBlueskyConnected ? 'Update Bluesky Bridge' : 'Connect Bluesky Bridge';
    bskyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const handle = bskyHandleIn.value.trim().replace(/^@/, '');
      const pass = bskyPassIn.value.trim();
      if (!handle || !pass) {
        setStatus('Enter handle and app password.');
        return;
      }
      bskyBtn.disabled = true;
      try {
        const session = await createBskySession({
          serviceUrl: 'https://bsky.social',
          identifier: handle,
          password: pass,
        });
        const profile = await getBskyProfile({
          serviceUrl: 'https://bsky.social',
          actor: session.did,
          accessJwt: session.accessJwt,
        }).catch(() => null);
        await upsertSocialAccount(
          {
            id: `bluesky:${session.did}`,
            platform: 'bluesky',
            serviceUrl: 'https://bsky.social',
            handle: session.handle,
            acct: session.handle,
            displayName: profile?.displayName || session.handle,
            avatar: profile?.avatar || '',
            header: profile?.banner || '',
            url: `https://bsky.app/profile/${session.handle}`,
            noteText: profile?.description || '',
            followersCount: Number(profile?.followersCount ?? 0),
            followingCount: Number(profile?.followsCount ?? 0),
            statusesCount: Number(profile?.postsCount ?? 0),
            did: session.did,
          },
          { accessJwt: session.accessJwt, refreshJwt: session.refreshJwt }
        );
        bskyPassIn.value = '';
        setStatus(`Connected @${session.handle}`);
        await onAccountsUpdated?.();
        renderBody();
      } catch (err) {
        setStatus(err?.message || 'Bluesky sign-in failed.');
      } finally {
        bskyBtn.disabled = false;
      }
    });
    bskyForm.append(bskyHead, bskyHint, bskyFields, bskyBtn);
    wrap.appendChild(bskyForm);

    // 3. Threads Bridge (Auto-Active)
    const threadsForm = doc.createElement('form');
    threadsForm.className = 'form-card-container account-login-card';
    const threadsHead = doc.createElement('div');
    threadsHead.className = 'option-header';
    const threadsH = doc.createElement('h4');
    threadsH.style.margin = '0';
    threadsH.textContent = 'Threads Bridge';
    const threadsBadge = doc.createElement('span');
    threadsBadge.className = `status-badge ${s.isThreadsConnected ? 'status-online' : ''}`;
    threadsBadge.textContent = s.isThreadsConnected ? 'Connected' : 'Optional';
    threadsHead.append(threadsH, threadsBadge);

    const threadsHint = doc.createElement('p');
    threadsHint.className = 'account-card-hint';
    threadsHint.textContent = 'Paste a Threads Graph API token for automatic cross-posting, reply sync, and synchronized delete.';

    const thTokGroup = doc.createElement('div');
    thTokGroup.className = 'input-group';
    const thTokLbl = doc.createElement('label');
    thTokLbl.setAttribute('for', 'user-threads-token');
    thTokLbl.textContent = 'Access Token';
    const thTokIn = doc.createElement('input');
    thTokIn.type = 'password';
    thTokIn.id = 'user-threads-token';
    thTokIn.className = 'onboarding-input';
    thTokIn.placeholder = 'Optional Threads Graph API token';
    thTokGroup.append(thTokLbl, thTokIn);

    const thBtn = doc.createElement('button');
    thBtn.type = 'submit';
    thBtn.className = 'onboarding-btn';
    thBtn.textContent = s.isThreadsConnected ? 'Update Threads Token' : 'Connect Threads Bridge';
    threadsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const tok = thTokIn.value.trim();
      if (!tok) {
        setStatus('Paste a Threads access token.');
        return;
      }
      thBtn.disabled = true;
      try {
        const me = await verifyThreadsCredentials({ accessToken: tok });
        const uid = String(me?.id || '').trim();
        if (!uid) {
          throw new Error('Could not resolve Threads profile from token.');
        }
        const username = String(me.username || uid).replace(/^@/, '');
        await upsertSocialAccount(
          {
            id: `threads:${uid}`,
            platform: 'threads',
            userId: uid,
            handle: username,
            acct: username,
            displayName: me.name || username,
            avatar: me.threads_profile_picture_url || '',
          },
          { accessToken: tok }
        );
        thTokIn.value = '';
        setStatus(`Connected @${username}`);
        await onAccountsUpdated?.();
        renderBody();
      } catch (err) {
        setStatus(err?.message || 'Threads token verification failed.');
      } finally {
        thBtn.disabled = false;
      }
    });

    threadsForm.append(threadsHead, threadsHint, thTokGroup, thBtn);
    wrap.appendChild(threadsForm);

    bodyHost.replaceChildren(desc, wrap);
  }

  const unsubAuth = authStore.subscribe(() => {
    if (!closed) renderBody();
  });

  renderBody();
  modal.open();
  return modal;
}
