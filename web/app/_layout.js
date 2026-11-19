import { openAuthorSheetModal } from '../components/AuthorSheetModal.js';
import { openSettingsModal } from '../components/sanctuary/SettingsModal.js';
import { openUserModal } from '../components/sanctuary/UserModal.js';
import { createUserIconSvg } from '../constants/avatars.js';
import { toUnifiedItem } from '../core/schema/unifiedItem.js';
import { exchangeOAuthCode, verifyCredentials } from '../queries/fediverse.js';
import { syncRecentUserPostsToSanctuary } from '../queries/socialClient.js';
import { authStore, hydrateAuthStore, upsertSocialAccount } from '../state/authStore.js';
import { openCompose, prefillFromUserBubble } from '../state/composeStore.js';
import { connectionStore, initSanctuaryConnection, onSanctuaryEvent } from '../state/sanctuary/connection.js';
import { attachOutboxAutoFlush, hydrateOutbox } from '../state/sanctuary/outboxModel.js';
import { kvDelete, kvGet, kvSet } from '../storage/nativeStore.js';
import { mountActivityScreen } from './activity.js';
import { mountComposeModal } from './composeModal.js';
import { mountFeedScreen } from './feed.js';
import { mountMessagesScreen } from './messages.js';
import { renderPostThreadView } from './postThread.js';
import { mountProfileScreen } from './profile.js';
import { mountProgramThread } from './programThread.js';
import { mountSearchScreen } from './search.js';

const NAV_ITEMS = [
  {
    id: 'home',
    label: 'Home',
    iconSvg: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`,
  },
  {
    id: 'search',
    label: 'Search',
    desktopOnly: true,
    iconSvg: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  },
  {
    id: 'messages',
    label: 'Messages',
    iconSvg: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
  },
  {
    id: 'activity',
    label: 'Activity',
    iconSvg: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`,
  },
  {
    id: 'profile',
    label: 'Profile',
    mobileOnly: true,
    iconSvg: createUserIconSvg({ size: 22, strokeWidth: 2 }),
  },
];

const PANEL_COLLAPSE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"></rect><line x1="15" y1="3" x2="15" y2="21"></line><polyline points="10 9 13 12 10 15"></polyline></svg>`;
const PANEL_EXPAND_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"></rect><line x1="15" y1="3" x2="15" y2="21"></line><polyline points="12 9 9 12 12 15"></polyline></svg>`;

const SEARCH_UTILITY_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
const USER_SVG = createUserIconSvg({ size: 20, strokeWidth: 2 });
const SETTINGS_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
const PLUS_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;

const TAB_TITLES = {
  home: 'Home | Sanctuary',
  search: 'Search | Sanctuary',
  messages: 'Messages | Sanctuary',
  activity: 'Activity | Sanctuary',
  profile: 'Profile | Sanctuary',
  sanctuary: 'Sanctuary',
};

function dismissSplashOverlay(doc) {
  const overlay = doc.getElementById('chat-loading-overlay');
  if (overlay) {
    overlay.classList.add('fade-out');
  }
}

async function handlePendingOAuthCallback() {
  const loc = globalThis.location;
  if (!loc?.search) return false;
  const params = new URLSearchParams(loc.search);
  const code = params.get('code');
  if (!code) return false;

  const pending = await kvGet('pending_oauth_app', null);
  if (!pending?.instanceUrl || !pending?.clientId || !pending?.clientSecret) {
    return false;
  }

  try {
    const tokenRes = await exchangeOAuthCode({
      instanceUrl: pending.instanceUrl,
      clientId: pending.clientId,
      clientSecret: pending.clientSecret,
      redirectUri: pending.redirectUri,
      code,
    });
    const profile = await verifyCredentials({
      instanceUrl: pending.instanceUrl,
      accessToken: tokenRes.access_token,
    });
    await upsertSocialAccount(
      {
        id: `fediverse:${profile.acct}`,
        platform: 'fediverse',
        instanceUrl: `https://${new URL(pending.instanceUrl.includes('://') ? pending.instanceUrl : `https://${pending.instanceUrl}`).host}`,
        handle: profile.username,
        acct: profile.acct,
        displayName: profile.displayName,
        avatar: profile.avatar,
        userId: profile.id,
      },
      {
        accessToken: tokenRes.access_token,
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
      }
    );
    await kvDelete('pending_oauth_app');
    const cleanUrl = `${loc.origin}${loc.pathname}${loc.hash || ''}`;
    globalThis.history?.replaceState?.(null, '', cleanUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mount the 3-column desktop / responsive mobile LM-Sanctuary shell:
 * 1) Left icon rail (`Home`, `Search`, `Messages`, `Activity`, `User`, `Settings`, `+` Compose)
 * 2) Center hairline social column (`main#main-content`)
 * 3) Persistent right Sanctuary companion dock (`aside.sanctuary-right-dock`)
 */
export function createAppShell(rootEl, { initialTab = 'home', skipBackgroundInit = false } = {}) {
  const doc = globalThis.document;
  rootEl.replaceChildren();

  let activeTab = TAB_TITLES[initialTab] ? initialTab : 'home';
  let feedScreenHandle = null;
  let activeScreenHandle = null;
  let threadScreenHandle = null;
  let savedHomeScrollTop = 0;
  let savedScreenScrollTop = 0;
  let msgNavPayload = {};

  const shell = doc.createElement('div');
  shell.className = 'app-shell-frame';

  // Column 1: Left Icon Rail (Desktop) / Bottom Tab Bar (Mobile)
  const nav = doc.createElement('nav');
  nav.className = 'primary-tab-nav';
  nav.setAttribute('aria-label', 'Primary');

  const railSpacer = doc.createElement('div');
  railSpacer.className = 'rail-spacer';
  railSpacer.setAttribute('aria-hidden', 'true');

  const railCenterStack = doc.createElement('div');
  railCenterStack.className = 'rail-center-stack';

  const navButtons = new Map();
  const navList = doc.createElement('ul');
  navList.className = 'primary-tab-list';
  navList.setAttribute('role', 'list');

  for (const item of NAV_ITEMS) {
    const li = doc.createElement('li');
    if (item.mobileOnly) li.className = 'mobile-only-nav-item';
    else if (item.desktopOnly) li.className = 'desktop-only-nav-item';
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = [
      'primary-tab-btn',
      item.mobileOnly ? 'mobile-only-tab' : '',
      item.desktopOnly ? 'desktop-only-tab' : '',
    ].filter(Boolean).join(' ');
    btn.dataset.tab = item.id;
    btn.setAttribute('aria-label', item.label);
    btn.title = item.label;
    btn.innerHTML = `${item.iconSvg}<span class="primary-tab-label">${item.label}</span>`;
    btn.addEventListener('click', () => navigateToTab(item.id));
    li.appendChild(btn);
    navList.appendChild(li);
    navButtons.set(item.id, btn);
  }

  const railDivider = doc.createElement('div');
  railDivider.className = 'rail-divider';
  railDivider.setAttribute('aria-hidden', 'true');

  const railUtilityGroup = doc.createElement('div');
  railUtilityGroup.className = 'rail-utility-group';

  const railUserBtn = doc.createElement('button');
  railUserBtn.type = 'button';
  railUserBtn.className = 'rail-utility-btn';
  railUserBtn.dataset.modal = 'user';
  railUserBtn.setAttribute('aria-label', 'User & Accounts');
  railUserBtn.title = 'User & Accounts';
  railUserBtn.innerHTML = USER_SVG;

  const railSettingsBtn = doc.createElement('button');
  railSettingsBtn.type = 'button';
  railSettingsBtn.className = 'rail-utility-btn';
  railSettingsBtn.dataset.modal = 'settings';
  railSettingsBtn.setAttribute('aria-label', 'Settings');
  railSettingsBtn.title = 'Settings';
  railSettingsBtn.innerHTML = SETTINGS_SVG;

  railUtilityGroup.append(railUserBtn, railSettingsBtn);
  railCenterStack.append(navList, railDivider, railUtilityGroup);

  const railComposeFab = doc.createElement('button');
  railComposeFab.type = 'button';
  railComposeFab.className = 'rail-compose-fab';
  railComposeFab.setAttribute('aria-label', 'New Post');
  railComposeFab.title = 'New Post';
  railComposeFab.innerHTML = PLUS_SVG;
  railComposeFab.addEventListener('click', () => openCompose({}));

  nav.append(railSpacer, railCenterStack, railComposeFab);

  // Column 2: Center Fediverse Column (plus compact mobile utility bar)
  const centerWrap = doc.createElement('div');
  centerWrap.className = 'center-column-wrap';

  const mobileBar = doc.createElement('div');
  mobileBar.className = 'mobile-utility-bar';
  const mobileTitle = doc.createElement('span');
  mobileTitle.className = 'mobile-utility-title';
  mobileTitle.textContent = 'Fediverse';
  const mobileActions = doc.createElement('div');
  mobileActions.className = 'mobile-utility-actions';

  const mobileSearchBtn = doc.createElement('button');
  mobileSearchBtn.type = 'button';
  mobileSearchBtn.className = 'rail-utility-btn mobile-search-btn';
  mobileSearchBtn.dataset.tab = 'search';
  mobileSearchBtn.setAttribute('aria-label', 'Search');
  mobileSearchBtn.title = 'Search';
  mobileSearchBtn.innerHTML = SEARCH_UTILITY_SVG;

  const mobileSettingsBtn = doc.createElement('button');
  mobileSettingsBtn.type = 'button';
  mobileSettingsBtn.className = 'rail-utility-btn';
  mobileSettingsBtn.setAttribute('aria-label', 'Settings');
  mobileSettingsBtn.innerHTML = SETTINGS_SVG;

  const mobileComposeBtn = doc.createElement('button');
  mobileComposeBtn.type = 'button';
  mobileComposeBtn.className = 'rail-compose-fab mobile-compose-fab';
  mobileComposeBtn.setAttribute('aria-label', 'New Post');
  mobileComposeBtn.title = 'New Post';
  mobileComposeBtn.innerHTML = PLUS_SVG;
  mobileComposeBtn.addEventListener('click', () => openCompose({}));

  mobileActions.append(mobileSearchBtn, mobileSettingsBtn);
  mobileBar.append(mobileTitle, mobileActions);

  const mainEl = doc.createElement('main');
  mainEl.id = 'main-content';
  mainEl.className = 'app-main-stage';

  const screenHostEl = doc.createElement('div');
  screenHostEl.className = 'stage-screen-host';

  const feedHostEl = doc.createElement('div');
  feedHostEl.className = 'stage-feed-host';

  const subScreenHostEl = doc.createElement('div');
  subScreenHostEl.className = 'stage-subscreen-host';
  subScreenHostEl.hidden = true;

  screenHostEl.append(feedHostEl, subScreenHostEl);

  const threadHostEl = doc.createElement('div');
  threadHostEl.className = 'stage-thread-host';
  threadHostEl.hidden = true;

  mainEl.append(screenHostEl, threadHostEl);

  centerWrap.append(mobileBar, mainEl);

  // Column 3: Collapsible Sanctuary Companion Right Dock
  const rightDockEl = doc.createElement('aside');
  rightDockEl.id = 'sanctuary-right-dock';
  rightDockEl.className = 'sanctuary-right-dock';
  rightDockEl.setAttribute('aria-label', 'Sanctuary Companion');

  let isSanctuaryCollapsed = false;
  const sanctuaryToggleBtn = doc.createElement('button');
  sanctuaryToggleBtn.type = 'button';
  sanctuaryToggleBtn.className = 'sanctuary-dock-toggle';
  sanctuaryToggleBtn.setAttribute('aria-controls', 'sanctuary-right-dock');

  function syncSanctuaryCollapseUi() {
    shell.classList.toggle('is-sanctuary-collapsed', isSanctuaryCollapsed);
    sanctuaryToggleBtn.setAttribute('aria-expanded', isSanctuaryCollapsed ? 'false' : 'true');
    const lbl = isSanctuaryCollapsed ? 'Expand Sanctuary' : 'Collapse Sanctuary';
    sanctuaryToggleBtn.setAttribute('aria-label', lbl);
    sanctuaryToggleBtn.title = lbl;
    sanctuaryToggleBtn.innerHTML = isSanctuaryCollapsed ? PANEL_EXPAND_SVG : PANEL_COLLAPSE_SVG;
  }

  function setSanctuaryCollapsed(next) {
    isSanctuaryCollapsed = Boolean(next);
    syncSanctuaryCollapseUi();
    void kvSet('sanctuary_dock_collapsed', isSanctuaryCollapsed);
  }

  sanctuaryToggleBtn.addEventListener('click', () => setSanctuaryCollapsed(!isSanctuaryCollapsed));
  syncSanctuaryCollapseUi();

  const modalHost = doc.createElement('div');
  modalHost.className = 'compose-modal-host';

  shell.append(nav, centerWrap, rightDockEl, sanctuaryToggleBtn, mobileComposeBtn, modalHost);
  rootEl.appendChild(shell);

  const sanctuaryCtrl = mountProgramThread(rightDockEl, {
    onOpenCompose: () => openCompose({}),
    onProgramChanged: () => {
      if (activeTab === 'messages') renderActiveScreen();
    },
  });

  const composeCtrl = mountComposeModal(modalHost, {
    onPublished() {
      if (threadScreenHandle?.refresh) {
        void threadScreenHandle.refresh();
      } else if (activeTab !== 'home' && activeScreenHandle?.refresh) {
        void activeScreenHandle.refresh();
      }
    },
  });

  function openUserAccountsModal() {
    openUserModal({
      onAccountsUpdated: () => {
        if (activeTab === 'profile') {
          renderActiveScreen();
        }
      },
    });
  }

  function handleSelectAuthor(author, item) {
    const primary = (authStore.get().accounts || []).find((a) => a.platform === 'fediverse');
    const authorHandle = String(author?.handle || author?.acct || '').replace(/^@/, '').toLowerCase();
    const myAcct = String(primary?.acct || primary?.handle || '').replace(/^@/, '').toLowerCase();
    const sameUser = Boolean(
      primary && (
        (author?.id && String(author.id) === String(primary.userId)) ||
        (myAcct && authorHandle && authorHandle === myAcct)
      )
    );
    if (sameUser) {
      navigateToTab('profile');
      return;
    }
    openAuthorSheetModal({
      author,
      instanceUrl: item?._meta?.mastodon?.instanceUrl || primary?.instanceUrl || 'https://mastodon.social',
      item,
      onOpenPostThread: openPostThread,
      onAskSanctuary: askSanctuaryAboutPost,
    });
  }

  function openGlobalSettingsModal() {
    openSettingsModal({
      initialTab: 'engine',
      temperature: sanctuaryCtrl.getTemperature(),
      onSettingsChanged: ({ temperature } = {}) => {
        if (temperature !== undefined) sanctuaryCtrl.setTemperature(temperature);
        void sanctuaryCtrl.refreshModels();
        void sanctuaryCtrl.refresh();
      },
    });
  }

  railUserBtn.addEventListener('click', () => navigateToTab('profile'));
  mobileSearchBtn.addEventListener('click', () => navigateToTab('search'));
  railSettingsBtn.addEventListener('click', openGlobalSettingsModal);
  mobileSettingsBtn.addEventListener('click', openGlobalSettingsModal);

  function syncNavIndicators() {
    for (const [id, btn] of navButtons.entries()) {
      const isCurrent = id === activeTab;
      btn.classList.toggle('is-active', isCurrent);
      if (isCurrent) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
    const isProfile = activeTab === 'profile';
    railUserBtn.classList.toggle('is-active', isProfile);
    if (isProfile) railUserBtn.setAttribute('aria-current', 'page');
    else railUserBtn.removeAttribute('aria-current');

    const isSearch = activeTab === 'search';
    mobileSearchBtn.classList.toggle('is-active', isSearch);
    if (isSearch) mobileSearchBtn.setAttribute('aria-current', 'page');
    else mobileSearchBtn.removeAttribute('aria-current');

    shell.classList.toggle('is-mobile-sanctuary-active', activeTab === 'sanctuary');
    doc.title = TAB_TITLES[activeTab] || 'LM-Sanctuary';
  }

  function askSanctuaryAboutPost(post) {
    if (isSanctuaryCollapsed) setSanctuaryCollapsed(false);
    sanctuaryCtrl.attachSharedPost(toUnifiedItem(post));
    if (Number(globalThis.innerWidth || 1280) < 1024) {
      navigateToTab('sanctuary');
    }
  }

  function closePostThread({ restoreScroll = true } = {}) {
    if (!threadScreenHandle && threadHostEl.hidden) return;
    threadScreenHandle?.destroy?.();
    threadScreenHandle = null;
    threadHostEl.replaceChildren();
    threadHostEl.hidden = true;
    screenHostEl.classList.remove('is-backgrounded');
    screenHostEl.removeAttribute('inert');
    if (restoreScroll) {
      centerWrap.scrollTop = savedScreenScrollTop;
      if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(() => {
          centerWrap.scrollTop = savedScreenScrollTop;
        });
      }
    }
  }

  function openPostThread(post) {
    if (!threadScreenHandle) {
      savedScreenScrollTop = centerWrap.scrollTop || 0;
    } else {
      threadScreenHandle.destroy?.();
    }
    screenHostEl.classList.add('is-backgrounded');
    screenHostEl.setAttribute('inert', '');
    threadHostEl.hidden = false;
    centerWrap.scrollTop = 0;
    threadScreenHandle = renderPostThreadView(threadHostEl, {
      post,
      onBack: () => closePostThread({ restoreScroll: true }),
      onAskSanctuary: askSanctuaryAboutPost,
      onSelectAuthor: handleSelectAuthor,
      showSanctuaryAction: connectionStore.get().mode === 'online' || connectionStore.get().programs.length > 0,
    });
  }

  function renderActiveScreen() {
    closePostThread({ restoreScroll: false });
    syncNavIndicators();

    if (activeTab === 'home') {
      activeScreenHandle?.destroy?.();
      activeScreenHandle = null;
      subScreenHostEl.replaceChildren();
      subScreenHostEl.hidden = true;
      feedHostEl.hidden = false;
      feedHostEl.removeAttribute('inert');
      if (!feedScreenHandle) {
        feedScreenHandle = mountFeedScreen(feedHostEl, {
          onOpenPostThread: openPostThread,
          onAskSanctuary: askSanctuaryAboutPost,
          onOpenAccounts: () => openUserAccountsModal(),
          onSelectAuthor: handleSelectAuthor,
        });
      }
      centerWrap.scrollTop = savedHomeScrollTop;
      if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(() => {
          centerWrap.scrollTop = savedHomeScrollTop;
        });
      }
      return;
    }

    feedHostEl.hidden = true;
    feedHostEl.setAttribute('inert', '');
    centerWrap.scrollTop = 0;
    activeScreenHandle?.destroy?.();
    activeScreenHandle = null;
    subScreenHostEl.hidden = false;

    if (activeTab === 'search') {
      activeScreenHandle = mountSearchScreen(subScreenHostEl, {
        onOpenPostThread: openPostThread,
        onAskSanctuary: askSanctuaryAboutPost,
        onSelectAuthor: handleSelectAuthor,
      });
    } else if (activeTab === 'messages') {
      const payload = { ...msgNavPayload };
      msgNavPayload = {};
      activeScreenHandle = mountMessagesScreen(subScreenHostEl, {
        ...payload,
        activeUser: sanctuaryCtrl.getActiveUser(),
        currentProgramId: sanctuaryCtrl.getCurrentProgramId(),
        currentSessionId: sanctuaryCtrl.getCurrentSessionId(),
        onSwitchProgram: (progId, sessId) => {
          if (isSanctuaryCollapsed) setSanctuaryCollapsed(false);
          sanctuaryCtrl.switchProgram(progId, sessId);
          if (Number(globalThis.innerWidth || 1280) < 1024) {
            navigateToTab('sanctuary');
          }
        },
        onOpenCompose: (patch) => openCompose(patch || {}),
        onOpenAccounts: () => openUserAccountsModal(),
        onProgramChanged: () => void sanctuaryCtrl.refresh(),
      });
    } else if (activeTab === 'activity') {
      activeScreenHandle = mountActivityScreen(subScreenHostEl, {
        onOpenPostThread: openPostThread,
        onAskSanctuary: askSanctuaryAboutPost,
        onOpenAccounts: () => openUserAccountsModal(),
        onSelectAuthor: handleSelectAuthor,
      });
    } else if (activeTab === 'profile') {
      activeScreenHandle = mountProfileScreen(subScreenHostEl, {
        onOpenPostThread: openPostThread,
        onAskSanctuary: askSanctuaryAboutPost,
        onOpenAccounts: () => openUserAccountsModal(),
        onSelectAuthor: handleSelectAuthor,
      });
    }
  }

  function navigateToTab(tabId) {
    if (tabId === 'compose') {
      openCompose({});
      return;
    }
    if (tabId === 'settings') {
      openGlobalSettingsModal();
      return;
    }
    const targetTab = (tabId === 'user' || tabId === 'profile')
      ? 'profile'
      : (TAB_TITLES[tabId] ? tabId : 'home');
    if (activeTab === 'home' && !threadScreenHandle && targetTab !== 'home') {
      savedHomeScrollTop = centerWrap.scrollTop || 0;
    }
    if (targetTab === activeTab) {
      if (threadScreenHandle) {
        closePostThread({ restoreScroll: true });
      }
      return;
    }
    closePostThread({ restoreScroll: false });
    activeTab = targetTab;
    renderActiveScreen();
  }

  // Paint shell immediately before any network calls
  renderActiveScreen();
  dismissSplashOverlay(doc);

  let detachOutbox = () => {};
  const offRecentPostsSync = onSanctuaryEvent('sanctuary:online', () => {
    void syncRecentUserPostsToSanctuary().catch(() => {});
  });
  const initPromise = skipBackgroundInit
    ? Promise.resolve()
    : (async () => {
        const savedCollapsed = await kvGet('sanctuary_dock_collapsed', false);
        if (savedCollapsed === true) {
          isSanctuaryCollapsed = true;
          syncSanctuaryCollapseUi();
        }
        await hydrateAuthStore();
        const handledOAuth = await handlePendingOAuthCallback();
        await hydrateOutbox();
        detachOutbox = attachOutboxAutoFlush();
        await initSanctuaryConnection();
        void syncRecentUserPostsToSanctuary().catch(() => {});

        const isNativeCapacitor = Boolean(globalThis.Capacitor?.isNativePlatform?.());
        const loc = globalThis.location;
        const canRegisterSw =
          !isNativeCapacitor &&
          typeof navigator !== 'undefined' &&
          'serviceWorker' in navigator &&
          Boolean(loc) &&
          (loc.protocol === 'https:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1');

        if (canRegisterSw) {
          navigator.serviceWorker.register('./sw.js', { type: 'module' }).catch((err) => {
            console.warn('Service worker registration failed:', err);
          });
        }

        if (globalThis.location?.search) {
          const sp = new URLSearchParams(globalThis.location.search);
          const sharedText = [sp.get('title'), sp.get('text'), sp.get('url')].filter(Boolean).join('\n');
          if (sharedText && !sp.get('code')) {
            prefillFromUserBubble({ text: sharedText });
          }
        }
        if (handledOAuth) {
          openUserAccountsModal();
        }
      })();

  function handleExternalLinkClick(event) {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || anchor.hasAttribute('download')) return;
    const rawHref = anchor.getAttribute('href') || '';
    if (!rawHref || rawHref.startsWith('#')) return;
    let parsed;
    try {
      parsed = new URL(rawHref, globalThis.location?.href || 'http://127.0.0.1');
    } catch {
      return;
    }
    const scheme = parsed.protocol.toLowerCase();
    if (scheme !== 'https:' && scheme !== 'http:' && scheme !== 'mailto:') return;
    const curOrigin = globalThis.location?.origin || '';
    if (scheme !== 'mailto:' && curOrigin && parsed.origin === curOrigin) return;

    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');

    if (globalThis.pywebview || globalThis.chrome?.webview) {
      event.preventDefault();
      if (typeof globalThis.pywebview?.api?.open_external === 'function') {
        void globalThis.pywebview.api.open_external(parsed.href);
      } else {
        void fetch('/api/social/open-external', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: parsed.href }),
        }).catch(() => {});
      }
    }
  }
  doc.addEventListener('click', handleExternalLinkClick);

  return {
    navigateToTab,
    toggleSanctuaryCollapsed: () => setSanctuaryCollapsed(!isSanctuaryCollapsed),
    composeCtrl,
    sanctuaryCtrl,
    initPromise,
    destroy() {
      doc.removeEventListener('click', handleExternalLinkClick);
      closePostThread({ restoreScroll: false });
      feedScreenHandle?.destroy?.();
      activeScreenHandle?.destroy?.();
      sanctuaryCtrl.destroy();
      composeCtrl.destroy();
      detachOutbox();
      offRecentPostsSync();
    },
  };
}

// Auto-mount in browser / pywebview / APK unless disabled by tests
const autoMountEl = globalThis.document?.getElementById?.('app-shell');
if (autoMountEl && !globalThis.__SANCTUARY_NO_AUTOBOOT) {
  createAppShell(autoMountEl);
}
