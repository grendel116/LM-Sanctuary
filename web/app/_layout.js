import { openAuthorSheetModal } from '../components/AuthorSheetModal.js';
import { parseSocialPostItemFromUrl } from '../components/PostCard.js';
import { showAlert } from '../components/sanctuary/SanctuaryDialog.js';
import { openSettingsModal, promptUnlockVault } from '../components/sanctuary/SettingsModal.js';
import { openUserModal } from '../components/sanctuary/UserModal.js';
import { createUserIconSvg } from '../constants/avatars.js';
import { toUnifiedItem } from '../core/schema/unifiedItem.js';
import { NEWTAB_URL, stripTrackingParams } from '../core/urlPrivacy.js';
import { refreshKeePassStatus, subscribeBrowserHostEvents } from '../adapters/browserBridge.js';
import { exchangeOAuthCode, verifyCredentials } from '../queries/fediverse.js';
import {
  completeThreadsOAuthFlow,
  fetchKeywordFilters,
  fetchSocialBridgeStatus,
  recoverUniqueCrossPostLinks,
  syncLinkedPostsWithSanctuary,
  syncRecentUserPostsToSanctuary,
} from '../queries/socialClient.js';
import {
  authStore,
  hydrateAuthStore,
  syncSocialAccountsWithServer,
  upsertSocialAccount,
} from '../state/authStore.js';
import { activityStore, hydrateActivityStore, markActivitySeen, refreshActivityNotifications } from '../state/activityStore.js';
import {
  MAX_SANCTUARY_SPLIT_PCT,
  MIN_SANCTUARY_SPLIT_PCT,
  browserStore,
  clampSanctuarySplitPct,
  executeBrowserAgentCommand,
  hydrateBrowserStore,
  isStandalonePrivateWindow,
  openBrowserTab,
  setSanctuarySplitPct,
  syncBrowserBookmarksWithServer,
  syncSearchConfigWithServer,
} from '../state/browserStore.js';
import { openCompose, prefillFromUserBubble, syncComposeDraftsWithServer } from '../state/composeStore.js';
import { hydrateCachedFilters, hydrateCachedModeration, hydrateFeedTuning } from '../state/feedStore.js';
import { hydrateMetricsLedger } from '../state/metricsLedger.js';
import { connectionStore, initSanctuaryConnection, onSanctuaryEvent } from '../state/sanctuary/connection.js';
import { attachOutboxAutoFlush, hydrateOutbox } from '../state/sanctuary/outboxModel.js';
import { kvDelete, kvGet, kvSet } from '../storage/nativeStore.js';
import { mountActivityScreen } from './activity.js';
import { mountBrowserScreen } from './browser.js';
import { mountComposeModal } from './composeModal.js';
import { mountFeedScreen } from './feed.js';
import {
  getDirectConvoKey,
  mountDirectMessageThread,
  mountMessagesScreen,
  resolveDirectConversationTarget,
} from './messages.js';
import { renderPostThreadView } from './postThread.js';
import { mountProfileScreen, openEditPostDialog } from './profile.js';
import { mountProgramThread } from './programThread.js';
import { mountSearchScreen } from './search.js';

const GLOBE_SVG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`;

const NAV_ITEMS = [
  {
    id: 'browser',
    label: 'Browser',
    iconSvg: GLOBE_SVG,
  },
  {
    id: 'home',
    label: 'Home',
    desktopOnly: true,
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
    id: 'home',
    label: 'Home',
    mobileOnly: true,
    iconSvg: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`,
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
  browser: 'Browser',
  home: 'Home',
  search: 'Search',
  messages: 'Messages',
  activity: 'Activity',
  profile: 'Profile',
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

  const pendingThreads = await kvGet('pending_threads_oauth', null);
  if (pendingThreads?.clientId && pendingThreads?.clientSecret) {
    if (!pendingThreads.state || params.get('state') === pendingThreads.state) {
      try {
        await completeThreadsOAuthFlow({ ...pendingThreads, code });
        await kvDelete('pending_threads_oauth');
        const cleanUrl = `${loc.origin}${loc.pathname}${loc.hash || ''}`;
        globalThis.history?.replaceState?.(null, '', cleanUrl);
        return true;
      } catch {
        return false;
      }
    }
  }

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
export function createAppShell(
  rootEl,
  { initialTab = 'home', skipBackgroundInit = false, privateWindow = isStandalonePrivateWindow() } = {}
) {
  const doc = globalThis.document;
  rootEl.replaceChildren();

  const isPrivateWindow = Boolean(privateWindow);
  let activeTab = isPrivateWindow ? 'browser' : (TAB_TITLES[initialTab] ? initialTab : 'home');
  let feedScreenHandle = null;
  let browserScreenHandle = null;
  let activeScreenHandle = null;
  let threadScreenHandle = null;
  let savedHomeScrollTop = 0;
  let savedScreenScrollTop = 0;
  let msgNavPayload = {};
  let resolveStartupReady = null;
  let startupCapTimer = null;
  const startupReadyPromise = skipBackgroundInit
    ? null
    : new Promise((resolve) => {
        resolveStartupReady = () => {
          if (startupCapTimer) {
            clearTimeout(startupCapTimer);
            startupCapTimer = null;
          }
          resolve();
        };
        startupCapTimer = setTimeout(resolveStartupReady, 2500);
      });

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
    btn.innerHTML = item.iconSvg;
    if (item.id === 'activity') {
      const dot = doc.createElement('span');
      dot.className = 'nav-unread-dot';
      dot.setAttribute('aria-hidden', 'true');
      dot.hidden = true;
      btn.appendChild(dot);
    }
    btn.addEventListener('click', () => navigateToTab(item.id));
    li.appendChild(btn);
    navList.appendChild(li);
    const list = navButtons.get(item.id) || [];
    list.push(btn);
    navButtons.set(item.id, list);
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

  const browserHostEl = doc.createElement('div');
  browserHostEl.className = 'stage-browser-host';
  browserHostEl.hidden = true;

  const subScreenHostEl = doc.createElement('div');
  subScreenHostEl.className = 'stage-subscreen-host';
  subScreenHostEl.hidden = true;

  screenHostEl.append(feedHostEl, browserHostEl, subScreenHostEl);

  const threadHostEl = doc.createElement('div');
  threadHostEl.className = 'stage-thread-host';
  threadHostEl.hidden = true;

  mainEl.append(screenHostEl, threadHostEl);

  centerWrap.append(mobileBar, mainEl);

  const splitResizerEl = doc.createElement('div');
  splitResizerEl.className = 'workspace-split-resizer';
  splitResizerEl.setAttribute('role', 'separator');
  splitResizerEl.setAttribute('aria-orientation', 'vertical');
  splitResizerEl.setAttribute('aria-label', 'Resize Sanctuary sidebar');
  splitResizerEl.setAttribute('aria-valuemin', String(MIN_SANCTUARY_SPLIT_PCT));
  splitResizerEl.setAttribute('aria-valuemax', String(MAX_SANCTUARY_SPLIT_PCT));
  splitResizerEl.setAttribute('aria-valuenow', String(browserStore.get().sanctuarySplitPct));
  splitResizerEl.tabIndex = 0;

  // Column 3: Collapsible Sanctuary Companion Right Dock
  const rightDockEl = doc.createElement('aside');
  rightDockEl.id = 'sanctuary-right-dock';
  rightDockEl.className = 'sanctuary-right-dock';
  rightDockEl.setAttribute('aria-label', 'Sanctuary Companion');

  function applySanctuarySplitWidth(pct) {
    const clamped = clampSanctuarySplitPct(pct);
    shell.style.setProperty('--sanctuary-dock-w', `${clamped}%`);
    splitResizerEl.setAttribute('aria-valuenow', String(clamped));
    return clamped;
  }

  let draggingSplit = false;
  splitResizerEl.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    draggingSplit = true;
    splitResizerEl.setPointerCapture?.(e.pointerId);
    splitResizerEl.classList.add('is-dragging');
  });
  splitResizerEl.addEventListener('pointermove', (e) => {
    if (!draggingSplit) return;
    const rect = shell.getBoundingClientRect?.();
    if (!rect || rect.width <= 0) return;
    const rawPct = ((rect.right - e.clientX) / rect.width) * 100;
    applySanctuarySplitWidth(rawPct);
  });
  const finishSplitDrag = (e) => {
    if (!draggingSplit) return;
    draggingSplit = false;
    splitResizerEl.releasePointerCapture?.(e?.pointerId);
    splitResizerEl.classList.remove('is-dragging');
    const current = Number(splitResizerEl.getAttribute('aria-valuenow'));
    setSanctuarySplitPct(current);
  };
  splitResizerEl.addEventListener('pointerup', finishSplitDrag);
  splitResizerEl.addEventListener('pointercancel', finishSplitDrag);
  splitResizerEl.addEventListener('keydown', (e) => {
    const current = Number(splitResizerEl.getAttribute('aria-valuenow') || browserStore.get().sanctuarySplitPct);
    let next = null;
    if (e.key === 'ArrowLeft') next = current + 2;
    else if (e.key === 'ArrowRight') next = current - 2;
    else if (e.key === 'Home') next = MIN_SANCTUARY_SPLIT_PCT;
    else if (e.key === 'End') next = MAX_SANCTUARY_SPLIT_PCT;
    if (next === null) return;
    e.preventDefault();
    const applied = applySanctuarySplitWidth(next);
    setSanctuarySplitPct(applied);
  });

  let isSanctuaryCollapsed = false;
  const sanctuaryToggleBtn = doc.createElement('button');
  sanctuaryToggleBtn.type = 'button';
  sanctuaryToggleBtn.className = 'sanctuary-dock-toggle';
  sanctuaryToggleBtn.setAttribute('aria-controls', 'sanctuary-right-dock');

  function syncSanctuaryCollapseUi() {
    shell.classList.toggle('is-sanctuary-collapsed', isSanctuaryCollapsed);
    splitResizerEl.hidden = isSanctuaryCollapsed;
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
  applySanctuarySplitWidth(browserStore.get().sanctuarySplitPct);

  const modalHost = doc.createElement('div');
  modalHost.className = 'compose-modal-host';

  shell.append(nav, centerWrap, splitResizerEl, rightDockEl, sanctuaryToggleBtn, mobileComposeBtn, modalHost);
  if (isPrivateWindow) {
    if (!browserStore.get().isPrivateWindow) {
      browserStore.set((prev) => ({
        isPrivateWindow: true,
        tabs: prev.tabs.map((t) => ({ ...t, isPrivate: true })),
      }));
    }
    shell.classList.add('is-private-browser-window', 'is-sanctuary-collapsed');
    isSanctuaryCollapsed = true;
    nav.hidden = true;
    rightDockEl.hidden = true;
    sanctuaryToggleBtn.hidden = true;
    splitResizerEl.hidden = true;
    mobileComposeBtn.hidden = true;
  }
  rootEl.appendChild(shell);

  function ensureBrowserScreenMounted() {
    if (!browserScreenHandle) {
      browserScreenHandle = mountBrowserScreen(browserHostEl, {
        onAskSanctuaryPage: (pageCard) => askSanctuaryAboutPost(pageCard),
        onShareToFediverse: ({ title, url } = {}) => {
          prefillFromUserBubble({
            text: [title, url].filter(Boolean).join('\n'),
          });
        },
      });
    }
    return browserScreenHandle;
  }

  function openExternalInBrowser(rawUrl, { activate = true, inSplit = false } = {}) {
    const useStrip = browserStore.get().privacy.stripTrackingParams !== false;
    const cleanUrl = useStrip ? stripTrackingParams(rawUrl) : String(rawUrl || '').trim();
    if (!cleanUrl) return;
    ensureBrowserScreenMounted();
    openBrowserTab(cleanUrl, { activate, inSplit });
    if (activate) {
      navigateToTab('browser');
    }
  }

  const sanctuaryDockPane = doc.createElement('div');
  sanctuaryDockPane.className = 'sanctuary-dock-pane sanctuary-program-dock-pane';

  const dmDockPane = doc.createElement('div');
  dmDockPane.className = 'sanctuary-dock-pane sanctuary-dm-dock-pane';
  dmDockPane.hidden = true;
  dmDockPane.setAttribute('inert', '');

  rightDockEl.append(sanctuaryDockPane, dmDockPane);

  const sanctuaryCtrl = mountProgramThread(sanctuaryDockPane, {
    onOpenCompose: () => openCompose({}),
    onProgramChanged: () => {
      if (activeTab === 'messages') renderActiveScreen();
    },
    onClientAction: (action) => {
      if (action?.type === 'open_browser_tab' && action.url) {
        openExternalInBrowser(action.url, { activate: true, inSplit: Boolean(action.split) });
      }
    },
    onBrowserCommand: (cmd) =>
      executeBrowserAgentCommand(cmd, {
        onActivateBrowser: () => {
          ensureBrowserScreenMounted();
          navigateToTab('browser');
        },
      }),
  });

  let activeDmDockHandle = null;
  let activeDirectConvoKey = '';

  function closeDirectConvoInDock() {
    if (!activeDmDockHandle && dmDockPane.hidden) return;
    activeDmDockHandle?.destroy?.();
    activeDmDockHandle = null;
    activeDirectConvoKey = '';
    dmDockPane.replaceChildren();
    dmDockPane.hidden = true;
    dmDockPane.setAttribute('inert', '');
    sanctuaryDockPane.hidden = false;
    sanctuaryDockPane.removeAttribute('inert');
    rightDockEl.setAttribute('aria-label', 'Sanctuary Companion');
    activeScreenHandle?.setSelectedDirectConvo?.(null);
  }

  function openDirectConvoInDock(convo) {
    if (!convo) return;
    if (isSanctuaryCollapsed) setSanctuaryCollapsed(false);
    activeDmDockHandle?.destroy?.();
    activeDirectConvoKey = getDirectConvoKey(convo);
    sanctuaryDockPane.hidden = true;
    sanctuaryDockPane.setAttribute('inert', '');
    dmDockPane.hidden = false;
    dmDockPane.removeAttribute('inert');
    rightDockEl.setAttribute('aria-label', 'Direct Messages');
    activeDmDockHandle = mountDirectMessageThread(dmDockPane, {
      convo,
      onBack: () => closeDirectConvoInDock(),
    });
    activeScreenHandle?.setSelectedDirectConvo?.(convo);
    if (Number(globalThis.innerWidth || 1280) < 1024) {
      navigateToTab('sanctuary');
    }
    activeDmDockHandle.focusInput?.();
  }

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
    const accounts = authStore.get().accounts || [];
    const rawAcct = String(author?.handle || author?.acct || '').trim().replace(/^@/, '').toLowerCase();
    const authorId = String(author?.id || author?.did || '');
    const targetProto = (
      author?.protocol === 'threads'
      || author?.network === 'threads'
      || item?.protocol === 'threads'
      || String(author?.url || '').includes('threads.net')
    )
      ? 'threads'
      : (
          author?.protocol === 'bluesky'
          || author?.network === 'bluesky'
          || item?.protocol === 'bluesky'
          || rawAcct.endsWith('@bsky.brid.gy')
          || authorId.startsWith('did:')
          || String(author?.url || '').includes('bsky.app')
        )
        ? 'bluesky'
        : 'mastodon';

    const cleanTargetAcct = rawAcct.endsWith('@bsky.brid.gy')
      ? rawAcct.slice(0, -'@bsky.brid.gy'.length)
      : rawAcct;

    const sameUser = accounts.some((acc) => {
      const accProto = acc.platform === 'fediverse' ? 'mastodon' : acc.platform;
      if (accProto !== targetProto) return false;
      const accId = String(acc.userId || acc.did || String(acc.id || '').replace(/^(?:fediverse|mastodon|bluesky|threads):/, ''));
      if (authorId && accId && authorId === accId) return true;
      const accAcct = String(acc.acct || acc.handle || '').trim().replace(/^@/, '').toLowerCase();
      if (cleanTargetAcct && accAcct && cleanTargetAcct === accAcct) return true;
      if (targetProto === 'mastodon' && cleanTargetAcct && accAcct && cleanTargetAcct === accAcct.split('@')[0]) {
        const myInstance = String(acc.instanceUrl || '').replace(/\/+$/, '');
        const itemInstance = String(item?._meta?.mastodon?.instanceUrl || '').replace(/\/+$/, '');
        if (!itemInstance || itemInstance === myInstance) return true;
      }
      return false;
    });
    if (sameUser) {
      navigateToTab('profile');
      return;
    }
    const primary = accounts.find((a) => a.platform === 'fediverse');
    openAuthorSheetModal({
      author,
      instanceUrl: item?._meta?.mastodon?.instanceUrl || primary?.instanceUrl || 'https://mastodon.social',
      item,
      onMessageAuthor: openDirectMessageToAuthor,
      onOpenPostThread: openPostThread,
      onAskSanctuary: askSanctuaryAboutPost,
      onEditPost: (p, onDone) => openEditPostDialog(p, { onSaved: onDone }),
    });
  }

  async function openDirectMessageToAuthor(target) {
    if (!target) return;
    if (activeTab === 'messages' && typeof activeScreenHandle?.openDirectRecipient === 'function') {
      await activeScreenHandle.openDirectRecipient(target);
      return;
    }
    try {
      const convo = await resolveDirectConversationTarget(target);
      if (convo) openDirectConvoInDock(convo);
    } catch (err) {
      showAlert('Direct Message Failed', err?.message || 'Unable to open direct conversation.');
    }
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
    for (const [id, btns] of navButtons.entries()) {
      const isCurrent = id === activeTab;
      for (const btn of btns) {
        btn.classList.toggle('is-active', isCurrent);
        if (isCurrent) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      }
    }
    const isProfile = activeTab === 'profile';
    railUserBtn.classList.toggle('is-active', isProfile);
    if (isProfile) railUserBtn.setAttribute('aria-current', 'page');
    else railUserBtn.removeAttribute('aria-current');

    const isSearch = activeTab === 'search';
    mobileSearchBtn.classList.toggle('is-active', isSearch);
    if (isSearch) mobileSearchBtn.setAttribute('aria-current', 'page');
    else mobileSearchBtn.removeAttribute('aria-current');

    const isBrowser = activeTab === 'browser';
    shell.classList.toggle('is-mobile-sanctuary-active', activeTab === 'sanctuary');
    shell.classList.toggle('is-browser-stage-active', isBrowser);
    mobileBar.hidden = isBrowser;
    doc.title = isPrivateWindow ? 'Private Browsing — Sanctuary Browser' : (TAB_TITLES[activeTab] || 'Sanctuary Browser');
    syncActivityUnreadBadge();
  }

  function syncActivityUnreadBadge() {
    const actBtns = navButtons.get('activity') || [];
    const showDot = Boolean(activityStore.get().hasUnread && activeTab !== 'activity');
    for (const actBtn of actBtns) {
      actBtn.classList.toggle('has-unread-activity', showDot);
      actBtn.setAttribute('aria-label', showDot ? 'Activity (unread notifications)' : 'Activity');
      const dot = actBtn.querySelector('.nav-unread-dot');
      if (dot) dot.hidden = !showDot;
    }
  }
  const unsubActivityBadge = activityStore.subscribe(() => syncActivityUnreadBadge());
  const onRequestUnlock = (e) => promptUnlockVault({ onUnlocked: async () => { await e?.detail?.onUnlocked?.(); } });
  globalThis.addEventListener?.('sanctuary:request-unlock', onRequestUnlock);

  function askSanctuaryAboutPost(post) {
    closeDirectConvoInDock();
    if (isSanctuaryCollapsed) setSanctuaryCollapsed(false);
    sanctuaryCtrl.attachSharedPost(post?.network === 'web' ? post : toUnifiedItem(post));
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
      browserHostEl.hidden = true;
      browserHostEl.setAttribute('inert', '');
      browserScreenHandle?.syncViewport?.();
      feedHostEl.hidden = false;
      feedHostEl.removeAttribute('inert');
      if (!feedScreenHandle) {
        feedScreenHandle = mountFeedScreen(feedHostEl, {
          onOpenPostThread: openPostThread,
          onAskSanctuary: askSanctuaryAboutPost,
          onOpenAccounts: () => openUserAccountsModal(),
          onSelectAuthor: handleSelectAuthor,
          startupReadyPromise,
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

    if (activeTab === 'browser') {
      activeScreenHandle?.destroy?.();
      activeScreenHandle = null;
      subScreenHostEl.replaceChildren();
      subScreenHostEl.hidden = true;
      feedHostEl.hidden = true;
      feedHostEl.setAttribute('inert', '');
      browserHostEl.hidden = false;
      browserHostEl.removeAttribute('inert');
      centerWrap.scrollTop = 0;
      ensureBrowserScreenMounted();
      browserScreenHandle?.syncViewport?.();
      return;
    }

    feedHostEl.hidden = true;
    feedHostEl.setAttribute('inert', '');
    browserHostEl.hidden = true;
    browserHostEl.setAttribute('inert', '');
    browserScreenHandle?.syncViewport?.();
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
        activeDirectConvoKey,
        onSwitchProgram: (progId, sessId) => {
          closeDirectConvoInDock();
          if (isSanctuaryCollapsed) setSanctuaryCollapsed(false);
          sanctuaryCtrl.switchProgram(progId, sessId);
          if (Number(globalThis.innerWidth || 1280) < 1024) {
            navigateToTab('sanctuary');
          }
        },
        onOpenDirectConvo: (convo) => openDirectConvoInDock(convo),
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

  function scrollHomeToTop({ smooth = true } = {}) {
    savedHomeScrollTop = 0;
    const prefersReduced = Boolean(
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    );
    if (smooth && !prefersReduced && typeof centerWrap.scrollTo === 'function') {
      centerWrap.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      centerWrap.scrollTop = 0;
    }
    if (doc.documentElement) {
      doc.documentElement.scrollTop = 0;
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
    if (isPrivateWindow && tabId !== 'browser') {
      return;
    }
    const targetTab = (tabId === 'user' || tabId === 'profile')
      ? 'profile'
      : (TAB_TITLES[tabId] ? tabId : 'home');
    if (activeTab === 'home' && !threadScreenHandle && targetTab !== 'home') {
      savedHomeScrollTop = centerWrap.scrollTop || 0;
    }
    if (targetTab === activeTab) {
      if (targetTab === 'home') {
        if (threadScreenHandle) {
          closePostThread({ restoreScroll: false });
          scrollHomeToTop({ smooth: false });
        } else {
          scrollHomeToTop({ smooth: true });
        }
        return;
      }
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
  let activityPollTimer = null;
  let unsubAuthActivity = () => {};
  let onVisibilityActivityCheck = null;
  let initialBootVaultSyncDone = false;
  const syncComposeVaultLock = (s = authStore.get()) => {
    const locked = Boolean(s?.vaultLocked);
    railComposeFab.disabled = locked;
    railComposeFab.style.opacity = locked ? '0.4' : '';
    railComposeFab.title = locked ? 'New Post — Unlock vault first' : 'New Post';
    mobileComposeBtn.disabled = locked;
    mobileComposeBtn.style.opacity = locked ? '0.4' : '';
    mobileComposeBtn.title = locked ? 'New Post — Unlock vault first' : 'New Post';
  };
  syncComposeVaultLock();
  const unsubComposeVaultLock = authStore.subscribe((next) => syncComposeVaultLock(next));

  const offRecentPostsSync = onSanctuaryEvent('sanctuary:online', () => {
    void syncRecentUserPostsToSanctuary().catch(() => {});
  });
  const offSocialVaultSync = onSanctuaryEvent('sanctuary:online', () => {
    if (!initialBootVaultSyncDone) return;
    void refreshKeePassStatus()
      .then(() => syncSocialAccountsWithServer())
      .then(() => {
        if (authStore.get().accounts.length > 0) {
          return refreshActivityNotifications().catch(() => {});
        }
        return undefined;
      })
      .catch((err) => {
        console.error('[social vault] Could not sync accounts with Sanctuary:', err);
      });
  });
  const offVaultChangedSync = onSanctuaryEvent('sanctuary:vault-changed', (e) => {
    if (!e?.detail?.unlocked) return;
    void syncSocialAccountsWithServer()
      .then(() => {
        if (authStore.get().accounts.length > 0) {
          return refreshActivityNotifications().catch(() => {});
        }
        return undefined;
      })
      .catch(() => {});
    void syncComposeDraftsWithServer().catch(() => {});
    void syncBrowserBookmarksWithServer().catch(() => {});
    void syncLinkedPostsWithSanctuary().catch(() => {});
  });
  const offDraftsSync = onSanctuaryEvent('sanctuary:online', () => {
    void syncComposeDraftsWithServer().catch(() => {});
  });
  const offLinkedPostSync = onSanctuaryEvent('sanctuary:online', () => {
    void (async () => {
      try {
        await syncLinkedPostsWithSanctuary();
        await recoverUniqueCrossPostLinks();
      } catch (err) {
        console.error('[social links] Could not sync cross-post mappings with Sanctuary:', err);
      }
    })();
  });
  const offBookmarkSync = onSanctuaryEvent('sanctuary:online', () => {
    void syncBrowserBookmarksWithServer().catch(() => {});
    void syncSearchConfigWithServer().catch(() => {});
  });
  const initPromise = skipBackgroundInit
    ? Promise.resolve()
    : (async () => {
        if (isPrivateWindow) {
          await hydrateBrowserStore();
          await initSanctuaryConnection();
          resolveStartupReady?.();
          await Promise.allSettled([
            syncSearchConfigWithServer(),
            syncBrowserBookmarksWithServer(),
          ]);
          return;
        }
        const [savedCollapsed, hydratedBrowser] = await Promise.all([
          kvGet('sanctuary_dock_collapsed', false),
          hydrateBrowserStore(),
          hydrateAuthStore(),
          hydrateActivityStore(),
          hydrateOutbox(),
          hydrateFeedTuning(),
          hydrateCachedModeration().catch(() => {}),
          hydrateCachedFilters().catch(() => {}),
          hydrateMetricsLedger().catch(() => {}),
        ]);
        if (hydratedBrowser?.sanctuarySplitPct) {
          applySanctuarySplitWidth(hydratedBrowser.sanctuarySplitPct);
        }
        if (savedCollapsed === true) {
          isSanctuaryCollapsed = true;
          syncSanctuaryCollapseUi();
        }
        const handledOAuth = await handlePendingOAuthCallback();
        void fetchSocialBridgeStatus().catch(() => {});
        detachOutbox = attachOutboxAutoFlush();
        await initSanctuaryConnection();
        await refreshKeePassStatus().catch(() => {});
        try {
          await syncSocialAccountsWithServer();
        } catch (err) {
          console.error('[social vault] Could not sync accounts with Sanctuary:', err);
        } finally {
          initialBootVaultSyncDone = true;
          resolveStartupReady?.();
        }
        void fetchKeywordFilters().catch(() => {});
        void syncBrowserBookmarksWithServer().catch(() => {});
        void syncSearchConfigWithServer().catch(() => {});
        void (async () => {
          try {
            await syncLinkedPostsWithSanctuary();
          } catch (err) {
            console.error('[social links] Could not sync cross-post mappings with Sanctuary:', err);
          }
          try {
            const result = await recoverUniqueCrossPostLinks();
            if (result.recovered > 0) {
              console.info(`[social links] Recovered ${result.recovered} historical cross-post mapping(s).`);
            }
          } catch (err) {
            console.error('[social links] Could not recover historical cross-post mappings:', err);
          }
        })();
        void syncRecentUserPostsToSanctuary().catch(() => {});

        if ((authStore.get().accounts || []).length > 0) {
          void refreshActivityNotifications({
            limit: 40,
            markSeen: activeTab === 'activity',
            background: true,
          }).catch(() => {});
        }
        let prevAccSig = (authStore.get().accounts || []).map((a) => a.id).join(',');
        unsubAuthActivity = authStore.subscribe((st) => {
          const sig = (st?.accounts || []).map((a) => a.id).join(',');
          if (sig !== prevAccSig) {
            prevAccSig = sig;
            if ((st?.accounts || []).length > 0) {
              void refreshActivityNotifications({
                limit: 40,
                markSeen: activeTab === 'activity',
                background: true,
              }).catch(() => {});
            }
          }
        });
        activityPollTimer = setInterval(() => {
          if ((authStore.get().accounts || []).length > 0 && doc.visibilityState !== 'hidden') {
            void refreshActivityNotifications({
              limit: 40,
              markSeen: activeTab === 'activity',
              background: true,
            }).catch(() => {});
          }
        }, 90_000);
        onVisibilityActivityCheck = () => {
          if (doc.visibilityState === 'visible' && (authStore.get().accounts || []).length > 0) {
            void refreshActivityNotifications({
              limit: 40,
              markSeen: activeTab === 'activity',
              background: true,
            }).catch(() => {});
          }
        };
        doc.addEventListener?.('visibilitychange', onVisibilityActivityCheck);

        const isNativeCapacitor = Boolean(globalThis.Capacitor?.isNativePlatform?.());
        const loc = globalThis.location;
        const canRegisterSw =
          !isNativeCapacitor &&
          typeof navigator !== 'undefined' &&
          'serviceWorker' in navigator &&
          Boolean(loc) &&
          (loc.protocol === 'https:' || loc.hostname === 'localhost' || loc.hostname === '127.0.0.1');

        if (canRegisterSw) {
          navigator.serviceWorker
            .register('./sw.js', { type: 'module', updateViaCache: 'none' })
            .then((reg) => reg?.update?.()?.catch?.(() => {}))
            .catch((err) => {
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

  function extractHashtagFromAnchor(anchor, parsed) {
    const cls = String(anchor.className || '');
    const rel = String(anchor.getAttribute('rel') || '');
    const text = String(anchor.textContent || '').trim();
    const isTaggedEl =
      /\bhashtag\b/i.test(cls)
      || rel.split(/\s+/).some((t) => t.toLowerCase() === 'tag');
    const pathMatch = parsed.pathname.match(/^\/(?:tags?|hashtag)\/([^/?#]+)/i);
    const threadsQ = parsed.hostname.toLowerCase().includes('threads.net')
      ? String(parsed.searchParams.get('q') || '').trim()
      : '';
    if (!isTaggedEl && !pathMatch && !threadsQ.startsWith('#')) return '';
    let raw = '';
    if (pathMatch?.[1]) {
      try {
        raw = decodeURIComponent(pathMatch[1]);
      } catch {
        raw = pathMatch[1];
      }
    } else if (threadsQ.startsWith('#')) {
      raw = threadsQ;
    } else if (text.startsWith('#')) {
      raw = text;
    }
    const clean = raw.replace(/^#+/, '').trim();
    if (!clean || /\s/.test(clean)) return '';
    return clean;
  }

  function extractMentionActorFromAnchor(anchor, parsed) {
    const clsTokens = String(anchor.className || '').split(' ').filter(Boolean);
    const isMentionEl = clsTokens.includes('mention') || clsTokens.includes('u-url');
    const host = parsed.hostname.toLowerCase();
    const segs = parsed.pathname.split('/').filter(Boolean);

    if (host === 'bsky.app' && segs.length === 2 && segs[0] === 'profile') {
      let target = segs[1];
      try {
        target = decodeURIComponent(segs[1]);
      } catch {
        target = segs[1];
      }
      const textHandle = String(anchor.textContent || '').trim().replace(/^@/, '');
      if (target.startsWith('did:')) {
        return {
          id: target,
          handle: textHandle && textHandle.includes('.') ? textHandle : '',
          protocol: 'bluesky',
          url: parsed.href,
        };
      }
      return {
        handle: target,
        protocol: 'bluesky',
        url: parsed.href,
      };
    }

    if ((host === 'threads.net' || host === 'www.threads.net') && segs.length === 1 && segs[0].startsWith('@')) {
      let handle = segs[0].slice(1);
      try {
        handle = decodeURIComponent(handle);
      } catch {
        // Keep raw handle
      }
      return {
        handle,
        protocol: 'threads',
        url: parsed.href,
      };
    }

    if (isMentionEl && segs.length === 1 && segs[0].startsWith('@')) {
      let user = segs[0].slice(1);
      try {
        user = decodeURIComponent(user);
      } catch {
        // Keep raw user
      }
      const handle = user.includes('@') ? user : `${user}@${host}`;
      return {
        handle,
        protocol: 'mastodon',
        url: parsed.href,
      };
    }

    return null;
  }

  function handleExternalLinkClick(event) {
    const targetEl = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const anchor = targetEl?.closest?.('a[href]');
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
    if (scheme !== 'https:' && scheme !== 'http:') return;
    const curOrigin = globalThis.location?.origin || '';
    if (curOrigin && parsed.origin === curOrigin) return;

    const hashtag = extractHashtagFromAnchor(anchor, parsed);
    if (hashtag) {
      event.preventDefault();
      navigateToTab('home');
      doc.dispatchEvent(new CustomEvent('sanctuary:open-hashtag', { detail: { tag: hashtag } }));
      return;
    }

    const activate = !(event.ctrlKey || event.metaKey || event.button === 1);
    const mentionActor = extractMentionActorFromAnchor(anchor, parsed);
    if (mentionActor && activate) {
      event.preventDefault();
      handleSelectAuthor(mentionActor, null);
      return;
    }

    if (activate && !anchor.dataset?.openExternal && !String(anchor.className || '').includes('ext-link')) {
      const socialPost = parseSocialPostItemFromUrl(parsed.href);
      if (socialPost) {
        event.preventDefault();
        openPostThread(socialPost);
        return;
      }
    }

    event.preventDefault();
    openExternalInBrowser(parsed.href, { activate });
  }
  doc.addEventListener('click', handleExternalLinkClick, true);
  const handleOpenDmEvent = (e) => {
    if (e?.detail) openDirectMessageToAuthor(e.detail);
  };
  const handleOpenPostEvent = (e) => {
    if (e?.detail) openPostThread(e.detail);
  };
  doc.addEventListener('sanctuary:open-dm', handleOpenDmEvent);
  doc.addEventListener('sanctuary:open-post', handleOpenPostEvent);
  const hostOpenInBrowser = (url, opts) => openExternalInBrowser(url, { activate: true, ...opts });
  globalThis.__sanctuaryOpenInBrowser = hostOpenInBrowser;
  const unsubBrowserHostNav = subscribeBrowserHostEvents((evt) => {
    if (!evt) return;
    if (evt.type === 'context-action') {
      if (evt.action === 'search-selection' && evt.text) {
        ensureBrowserScreenMounted();
        browserScreenHandle?.submitSearchOrUrl?.(evt.text);
        if (activeTab !== 'browser') {
          navigateToTab('browser');
        }
        browserScreenHandle?.syncViewport?.();
        return;
      }
      if (isPrivateWindow) return;
      if (evt.action === 'toggle-bookmark') {
        ensureBrowserScreenMounted();
        void browserScreenHandle?.toggleBookmarkForTab?.(evt.tabId, {
          url: evt.url,
          title: evt.title,
        });
        return;
      }
      if (evt.action === 'ask-sanctuary') {
        if (evt.isShell && evt.text) {
          askSanctuaryAboutPost({
            authorName: 'Selected Text',
            authorHandle: 'sanctuary',
            text: String(evt.text).slice(0, 1200),
            mediaUrl: '',
            mediaAlt: '',
            url: '',
            network: 'web',
          });
          return;
        }
        ensureBrowserScreenMounted();
        void browserScreenHandle?.askSanctuaryForTab?.(evt.tabId, {
          selectionText: evt.text || '',
        });
        return;
      }
      if (evt.action === 'clip-databank') {
        ensureBrowserScreenMounted();
        void browserScreenHandle?.clipTabToDataBankById?.(evt.tabId, {
          selectionText: evt.text || '',
        });
        return;
      }
      return;
    }
    if (evt.type !== 'open-tab' || (!evt.url && !evt.nativeReady)) return;
    const wasMounted = Boolean(browserScreenHandle);
    ensureBrowserScreenMounted();
    if (!wasMounted) {
      const rawUrl = String(evt.url || '').trim();
      const clean = rawUrl ? stripTrackingParams(rawUrl) : NEWTAB_URL;
      openBrowserTab(clean, {
        id: evt.tabId ? String(evt.tabId) : '',
        activate: evt.activate !== false,
        inSplit: Boolean(evt.split),
        nativePending: Boolean(evt.nativeReady && clean === NEWTAB_URL),
      });
    }
    if (evt.activate !== false && activeTab !== 'browser') {
      navigateToTab('browser');
    }
    browserScreenHandle?.syncViewport?.();
  });

  return {
    navigateToTab,
    openInBrowser: (url, opts) => openExternalInBrowser(url, opts),
    toggleSanctuaryCollapsed: () => setSanctuaryCollapsed(!isSanctuaryCollapsed),
    composeCtrl,
    sanctuaryCtrl,
    initPromise,
    destroy() {
      if (globalThis.__sanctuaryOpenInBrowser === hostOpenInBrowser) {
        delete globalThis.__sanctuaryOpenInBrowser;
      }
      unsubBrowserHostNav();
      doc.removeEventListener('click', handleExternalLinkClick, true);
      doc.removeEventListener('sanctuary:open-dm', handleOpenDmEvent);
      doc.removeEventListener('sanctuary:open-post', handleOpenPostEvent);
      if (onVisibilityActivityCheck) doc.removeEventListener?.('visibilitychange', onVisibilityActivityCheck);
      if (activityPollTimer) clearInterval(activityPollTimer);
      unsubAuthActivity();
      unsubActivityBadge();
      globalThis.removeEventListener?.('sanctuary:request-unlock', onRequestUnlock);
      unsubComposeVaultLock();
      closePostThread({ restoreScroll: false });
      feedScreenHandle?.destroy?.();
      browserScreenHandle?.destroy?.();
      activeScreenHandle?.destroy?.();
      activeDmDockHandle?.destroy?.();
      sanctuaryCtrl.destroy();
      composeCtrl.destroy();
      detachOutbox();
      offRecentPostsSync();
      offSocialVaultSync();
      offVaultChangedSync();
      offDraftsSync();
      offLinkedPostSync();
      offBookmarkSync();
    },
  };
}

// Auto-mount in browser / pywebview / APK unless disabled by tests
const autoMountEl = globalThis.document?.getElementById?.('app-shell');
if (autoMountEl && !globalThis.__SANCTUARY_NO_AUTOBOOT) {
  createAppShell(autoMountEl);
}
