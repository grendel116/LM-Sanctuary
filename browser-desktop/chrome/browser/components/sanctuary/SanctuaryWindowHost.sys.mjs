/* SPDX-License-Identifier: AGPL-3.0-or-later */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const WINDOW_STATES = new WeakMap();
let observerInstalled = false;
let sanctuaryModulesStarted = false;
let hostTabSeq = 0;

function nextHostTabId() {
  hostTabSeq += 1;
  return `tab_host_${Date.now().toString(36)}_${hostTabSeq}`;
}

function startSanctuaryModules() {
  if (sanctuaryModulesStarted) {
    return;
  }
  sanctuaryModulesStarted = true;
  try {
    ChromeUtils.registerWindowActor("SanctuaryAgentPage", {
      parent: {
        esModuleURI:
          "moz-src:///browser/components/sanctuary/SanctuaryAgentPageParent.sys.mjs",
      },
      child: {
        esModuleURI:
          "moz-src:///browser/components/sanctuary/SanctuaryAgentPageChild.sys.mjs",
      },
      remoteTypes: ["web", "webIsolated", "webCOOP+COEP", "file"],
    });
  } catch {
    // Already registered or unavailable in minimal test harness
  }
  for (const prefName of [
    "browser.ml.enable",
    "browser.ml.chat.enabled",
    "browser.ml.chat.menu",
    "browser.ml.chat.page",
    "identity.fxaccounts.enabled",
    "extensions.pocket.enabled",
    "browser.tabs.firefox-view",
  ]) {
    try {
      Services?.prefs?.setBoolPref?.(prefName, false);
    } catch {
      // Ignore read-only/unavailable prefs in minimal test harness
    }
  }
}

function getBlockedCountForBrowser(_win, browser) {
  if (!browser) {
    return 0;
  }
  try {
    const raw = typeof browser.getContentBlockingLog === "function" ? browser.getContentBlockingLog() : "";
    if (!raw) {
      return 0;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return 0;
    }
    let count = 0;
    for (const entries of Object.values(parsed)) {
      if (Array.isArray(entries) && entries.some(item => Array.isArray(item) && item[1] === true)) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function isPrivateWindow(win) {
  try {
    if (typeof lazy.PrivateBrowsingUtils?.isWindowPrivate === "function") {
      return Boolean(lazy.PrivateBrowsingUtils.isWindowPrivate(win));
    }
  } catch {
    // Fall back to DOM attribute check below
  }
  return win?.document?.documentElement?.getAttribute?.("privatebrowsingmode") === "temporary";
}

function applyShellWindowChromeStyle(win) {
  const doc = win?.document;
  if (!doc) {
    return;
  }
  const styleId = "sanctuary-shell-chrome-style";
  if (doc.getElementById(styleId)) {
    return;
  }
  const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "style");
  style.id = styleId;
  style.textContent = `
    #tabbrowser-tabpanels > .sanctuary-active-tab-panel {
      -moz-subtree-hidden-only-visually: 0 !important;
      visibility: visible !important;
      position: fixed !important;
      right: auto !important;
      bottom: auto !important;
      max-width: none !important;
      max-height: none !important;
      z-index: 5 !important;
      pointer-events: auto !important;
      margin: 0 !important;
      box-sizing: border-box !important;
      display: flex !important;
      flex-direction: column !important;
      min-width: 0 !important;
      min-height: 0 !important;
      border-radius: 8px !important;
      overflow: clip !important;
      background-color: #121214 !important;
    }
    #tabbrowser-tabpanels > .sanctuary-active-tab-panel > .browserContainer {
      flex: 1 1 auto !important;
      min-height: 0 !important;
      margin: 0 !important;
      border-radius: 0 !important;
      outline: none !important;
    }
    :root:not([data-sanctuary-browser-active="true"]) #statuspanel {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
    }
    :root[data-sanctuary-browser-active="true"] #statuspanel:not([hidden]) {
      position: fixed !important;
      z-index: 25 !important;
      left: var(--sanctuary-pane-left, 12px) !important;
      right: auto !important;
      bottom: var(--sanctuary-pane-bottom, 8px) !important;
      max-width: var(--sanctuary-pane-max-w, calc(100vw - 24px)) !important;
      padding-top: 0 !important;
      overflow: visible !important;
      pointer-events: none !important;
    }
    :root[data-sanctuary-browser-active="true"] #statuspanel[mirror]:not([hidden]) {
      left: auto !important;
      right: var(--sanctuary-pane-right, 12px) !important;
    }
    :root[data-sanctuary-browser-active="true"] #statuspanel::before,
    :root[data-sanctuary-browser-active="true"] #statuspanel::after {
      display: none !important;
      content: none !important;
    }
    :root[data-sanctuary-browser-active="true"] #statuspanel-label {
      margin: 0 !important;
      padding: 3px 9px !important;
      height: auto !important;
      line-height: 1.35 !important;
      transform: none !important;
      background-color: rgba(18, 18, 22, 0.94) !important;
      color: #d4cfdf !important;
      border: 1px solid rgba(255, 255, 255, 0.12) !important;
      border-radius: 7px !important;
      font-size: 11.5px !important;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45) !important;
    }
    #context-bookmarkpage,
    #context-bookmarklink,
    #context-bookmarkframe,
    #context-ask-chat,
    #context-sendpagetodevice,
    #context-sep-sendpagetodevice,
    #context-sendlinktodevice,
    #context-sep-sendlinktodevice,
    #context-take-screenshot,
    #context-sep-screenshots,
    #context-openlinkincontainertab,
    #context-openlinkinusercontext-menu,
    #context-openlink,
    #context-openlinksmartwindow,
    #context-previewlink,
    #context-add-engine,
    #context-searchselect,
    #context-searchselect-private,
    #context-setDesktopBackground,
    #context-sep-setbackground,
    #context-sendimage,
    #context-sendvideo,
    #context-sendaudio,
    #fill-login,
    #fill-login-generated-password,
    #use-relay-mask,
    #manage-saved-logins,
    #passwordmgr-items-separator,
    #context-inspect-a11y,
    #context-video-pictureinpicture,
    #context_HidePictureInPictureToggle,
    #context_MovePictureInPictureToggle {
      display: none !important;
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

function ensureStatusPanelLayer(win) {
  const doc = win?.document;
  if (!doc) {
    return;
  }
  const panel = doc.getElementById("statuspanel");
  const browserWrap = doc.getElementById("browser");
  // Lift #statuspanel out of #tabbrowser-tabbox so z-index: 25 paints above positioned gBrowser panels.
  if (panel && browserWrap && panel.parentNode !== browserWrap) {
    browserWrap.appendChild(panel);
  }
  if (
    win.gBrowser &&
    typeof win.gBrowser.appendStatusPanel === "function" &&
    !win.gBrowser._sanctuaryAppendWrapped
  ) {
    win.gBrowser._sanctuaryAppendWrapped = true;
    win.gBrowser.appendStatusPanel = () => {
      const targetPanel = doc.getElementById("statuspanel");
      const hostWrap = doc.getElementById("browser");
      if (targetPanel && hostWrap && targetPanel.parentNode !== hostWrap) {
        hostWrap.appendChild(targetPanel);
      }
    };
  }
}

function syncShellChromeMode(win, isSanctuaryShell) {
  const doc = win?.document;
  if (!doc) {
    return;
  }
  for (const elId of ["navigator-toolbox", "sidebar-box"]) {
    const el = doc.getElementById(elId);
    if (!el) {
      continue;
    }
    el.collapsed = Boolean(isSanctuaryShell);
    el.style.display = isSanctuaryShell ? "none" : "";
  }
}

function isShellOriginUrl(rawUrl) {
  const spec = String(rawUrl || "").trim();
  if (!spec) {
    return false;
  }
  try {
    const configured =
      Services?.prefs?.getStringPref?.("browser.sanctuary.shellUrl", "http://127.0.0.1:5000") ||
      "http://127.0.0.1:5000";
    return new URL(spec).origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

function buildPrivateShellUrl(targetUrl = "") {
  const configured =
    Services?.prefs?.getStringPref?.("browser.sanctuary.shellUrl", "http://127.0.0.1:5000") ||
    "http://127.0.0.1:5000";
  const u = new URL("/", configured);
  u.searchParams.set("privateWindow", "1");
  const cleanTarget = String(targetUrl || "").trim();
  if (/^https?:\/\//i.test(cleanTarget)) {
    u.searchParams.set("privateUrl", cleanTarget);
  }
  return u.href;
}

function ensureSanctuaryContextMenuItems(win, state, menu) {
  const doc = win?.document;
  if (!doc || !menu) {
    return null;
  }
  const createEl = tag =>
    typeof doc.createXULElement === "function" ? doc.createXULElement(tag) : doc.createElement(tag);
  const existingSep = doc.getElementById("sanctuary-context-sep");
  if (existingSep) {
    return {
      sep: existingSep,
      searchSelection: doc.getElementById("sanctuary-context-search-selection"),
      bookmarkPage: doc.getElementById("sanctuary-context-bookmark-page"),
      askSanctuary: doc.getElementById("sanctuary-context-ask-sanctuary"),
      clipDatabank: doc.getElementById("sanctuary-context-clip-databank"),
    };
  }
  const sep = createEl("menuseparator");
  sep.id = "sanctuary-context-sep";
  const makeItem = (id, action) => {
    const item = createEl("menuitem");
    item.id = id;
    item.addEventListener("command", () => {
      const ctx = state.lastContextTarget || {};
      emitEvent(state, { type: "context-action", action, ...ctx });
    });
    return item;
  };
  const searchSelection = makeItem("sanctuary-context-search-selection", "search-selection");
  const bookmarkPage = makeItem("sanctuary-context-bookmark-page", "toggle-bookmark");
  const askSanctuary = makeItem("sanctuary-context-ask-sanctuary", "ask-sanctuary");
  const clipDatabank = makeItem("sanctuary-context-clip-databank", "clip-databank");

  const anchor = doc.getElementById("inspect-separator");
  const insertTarget = anchor && anchor.parentNode === menu ? anchor : null;
  for (const node of [sep, searchSelection, bookmarkPage, askSanctuary, clipDatabank]) {
    if (insertTarget) {
      menu.insertBefore(node, insertTarget);
    } else {
      menu.appendChild(node);
    }
  }
  return { sep, searchSelection, bookmarkPage, askSanctuary, clipDatabank };
}

function getState(win) {
  let state = WINDOW_STATES.get(win);
  if (!state) {
    state = {
      tabs: new Map(),
      shellTab: null,
      parentActor: null,
      mounted: false,
      active: false,
      overlayOpen: false,
      focusedPane: "primary",
      activePanes: [],
      pendingPrivateUrl: "",
      contextBrowser: null,
      lastContextTarget: null,
      suppressTabOpen: false,
      suppressTabClose: false,
    };
    WINDOW_STATES.set(win, state);
  }
  return state;
}

function emitEvent(state, payload) {
  try {
    state.parentActor?.sendAsyncMessage("SanctuaryHost:Event", payload);
  } catch {
    // Actor may be destroyed during navigation or shutdown
  }
}

function findTabEntryByBrowser(state, browser) {
  if (!state || !browser) {
    return null;
  }
  for (const entry of state.tabs.entries()) {
    const rec = entry[1];
    if (rec?.browser === browser || rec?.tab?.linkedBrowser === browser) {
      return entry;
    }
  }
  return null;
}

function findTabEntryByTab(state, tab) {
  if (!state || !tab) {
    return null;
  }
  for (const entry of state.tabs.entries()) {
    if (entry[1]?.tab === tab) {
      return entry;
    }
  }
  return null;
}

function resolveShellTab(win, state, parentActor = null) {
  const gBrowser = win?.gBrowser;
  if (!gBrowser) {
    return null;
  }
  const actorBrowser = parentActor?.browsingContext?.top?.embedderElement || null;
  if (actorBrowser && typeof gBrowser.getTabForBrowser === "function") {
    const resolved = gBrowser.getTabForBrowser(actorBrowser);
    if (resolved && !resolved.closing) {
      state.shellTab = resolved;
      return resolved;
    }
  }
  if (state.shellTab && !state.shellTab.closing) {
    return state.shellTab;
  }
  const fallback = gBrowser.tabs?.[0] || gBrowser.selectedTab || null;
  if (fallback && !fallback.closing) {
    state.shellTab = fallback;
    return fallback;
  }
  return null;
}

function resolvePanelForTab(win, tab, browser) {
  if (win?.gBrowser && typeof win.gBrowser.getPanel === "function" && browser) {
    try {
      const panel = win.gBrowser.getPanel(browser);
      if (panel) {
        return panel;
      }
    } catch {
      // Fallback to linkedPanel lookup below
    }
  }
  if (tab?.linkedPanel && win?.document?.getElementById) {
    return win.document.getElementById(tab.linkedPanel) || null;
  }
  return null;
}

function hideManagedTabStripEntry(win, tab) {
  if (!win?.gBrowser || !tab || tab.selected || tab.closing || tab.pinned) {
    return;
  }
  try {
    win.gBrowser.hideTab?.(tab, "sanctuary");
  } catch {
    // Ignore transient hideTab errors during startup or close
  }
}

function showManagedPanel(rec, { leftPx, topPx, widthPx, heightPx }) {
  rec.tab?.setAttribute?.("sanctuary-managed-tab", "true");
  const panel = rec.panel;
  if (panel) {
    panel.hidden = false;
    panel.classList?.add?.("sanctuary-active-tab-panel");
    if (panel.style) {
      panel.style.left = `${leftPx}px`;
      panel.style.top = `${topPx}px`;
      panel.style.width = `${widthPx}px`;
      panel.style.height = `${heightPx}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.visibility = "visible";
      panel.style.pointerEvents = "auto";
    }
  }
  if (rec.browser) {
    rec.browser.docShellIsActive = true;
    rec.browser.renderLayers = true;
  }
}

function hideManagedPanel(rec) {
  rec.tab?.removeAttribute?.("sanctuary-managed-tab");
  const panel = rec.panel;
  if (panel) {
    panel.classList?.remove?.("sanctuary-active-tab-panel");
    if (panel.style) {
      panel.style.left = "";
      panel.style.top = "";
      panel.style.width = "";
      panel.style.height = "";
      panel.style.right = "";
      panel.style.bottom = "";
      panel.style.visibility = "";
      panel.style.pointerEvents = "none";
    }
  }
  if (rec.browser) {
    rec.browser.docShellIsActive = false;
  }
}

function detachBrowserDomListeners(rec) {
  if (rec?.browser && rec.onDomWindowClose) {
    try {
      rec.browser.removeEventListener?.("DOMWindowClose", rec.onDomWindowClose);
    } catch {
      // Ignore cleanup errors on closing browser
    }
  }
  if (rec) {
    rec.onDomWindowClose = null;
  }
}

function attachBrowserDomListeners(win, state, tabId, rec) {
  if (!rec?.browser) {
    return;
  }
  const onDomWindowClose = () => {
    if (!state.tabs.has(tabId)) {
      return;
    }
    emitEvent(state, { type: "close-tab", tabId });
    SanctuaryWindowHost.closeTab(win, tabId);
  };
  rec.onDomWindowClose = onDomWindowClose;
  rec.browser.addEventListener?.("DOMWindowClose", onDomWindowClose, { once: true });
}

function cleanupTabRecord(rec) {
  hideManagedPanel(rec);
  detachBrowserDomListeners(rec);
}

async function captureRecordSnapshot(win, state, tabId, rec) {
  if (!win || !rec?.browser || !tabId) {
    return { ok: false };
  }
  if (rec.capturePromise) {
    return rec.capturePromise;
  }
  const wgp = rec.browser.browsingContext?.currentWindowGlobal;
  if (typeof wgp?.drawSnapshot !== "function" || typeof win.document?.createElementNS !== "function") {
    return { ok: false };
  }
  rec.capturePromise = (async () => {
    try {
      const bitmap = await wgp.drawSnapshot(null, 1, "rgb(18, 18, 20)");
      if (!bitmap || !bitmap.width || !bitmap.height) {
        bitmap?.close?.();
        return { ok: false };
      }
      const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        bitmap.close?.();
        return { ok: false };
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
      if (!dataUrl || !dataUrl.startsWith("data:image/")) {
        return { ok: false };
      }
      rec.previewDataUrl = dataUrl;
      emitEvent(state, {
        type: "tab-preview",
        tabId,
        url: String(rec.browser?.currentURI?.spec || rec.url || ""),
        dataUrl,
      });
      return { ok: true, tabId, dataUrl };
    } catch {
      return { ok: false };
    } finally {
      rec.capturePromise = null;
    }
  })();
  return rec.capturePromise;
}

function attachTabRecord(win, state, tabId, tab, initialUrl = "") {
  const browser = win.gBrowser?.getBrowserForTab?.(tab) || tab.linkedBrowser || null;
  const panel = resolvePanelForTab(win, tab, browser);
  const record = {
    tab,
    browser,
    panel,
    url: initialUrl,
    title: "",
    blockedCount: 0,
    onDomWindowClose: null,
  };
  attachBrowserDomListeners(win, state, tabId, record);
  hideManagedPanel(record);
  state.tabs.set(tabId, record);
  return record;
}

function createManagedTab(win, state, tabId, options = {}) {
  const gBrowser = win?.gBrowser;
  if (!gBrowser || typeof gBrowser.addTab !== "function") {
    return null;
  }
  const uriSpec = String(options.url || options.uri?.spec || "").trim();
  const hasInitialUrl = Boolean(uriSpec && uriSpec !== "about:blank");
  const targetUriString = hasInitialUrl ? uriSpec : "about:blank";
  const privWin = isPrivateWindow(win);
  const userContextId = privWin ? 0 : options.userContextId || 0;
  const originAttrs = privWin ? { privateBrowsingId: 1 } : { userContextId };
  const triggeringPrincipal =
    options.triggeringPrincipal ||
    Services.scriptSecurityManager.createNullPrincipal(originAttrs);
  const openWindowInfo = options.openWindowInfo || null;
  const forceNotRemote = Boolean(openWindowInfo && openWindowInfo.isRemote === false);

  let tab = null;
  state.suppressTabOpen = true;
  try {
    tab = gBrowser.addTab(targetUriString, {
      triggeringPrincipal,
      referrerInfo: options.referrerInfo || null,
      userContextId,
      inBackground: true,
      skipAnimation: true,
      skipBackgroundNotify: true,
      forceNotRemote,
      openWindowInfo,
      openerBrowser: options.openerBrowser || null,
      name: options.name || "",
      preferredRemoteType: options.preferredRemoteType || options.openerBrowser?.remoteType || undefined,
      policyContainer: options.policyContainer || null,
      postData: options.postData || null,
      allowInheritPrincipal: Boolean(options.allowInheritPrincipal),
      skipLoad: Boolean(options.skipLoad),
      hasValidUserGestureActivation: options.hasValidUserGestureActivation ?? true,
    });
  } finally {
    state.suppressTabOpen = false;
  }

  if (!tab) {
    return null;
  }
  hideManagedTabStripEntry(win, tab);
  return attachTabRecord(win, state, tabId, tab, hasInitialUrl && !options.skipLoad ? uriSpec : "");
}

function getFocusedManagedBrowser(state) {
  if (!state?.active || state.overlayOpen || !state.activePanes.length) {
    return null;
  }
  const targetPane =
    state.activePanes.find(p => p.pane === state.focusedPane) ||
    state.activePanes[0];
  const rec = targetPane ? state.tabs.get(targetPane.tabId) : null;
  if (!rec?.browser) {
    return null;
  }
  if (rec.panel && !rec.panel.classList?.contains?.("sanctuary-active-tab-panel")) {
    return null;
  }
  return rec.browser;
}

function reloadManagedBrowser(browser, bypassCache = false) {
  if (!browser) {
    return;
  }
  try {
    if (bypassCache && typeof browser.reloadWithFlags === "function") {
      const flags = Ci.nsIWebNavigation?.LOAD_FLAGS_BYPASS_CACHE || 0;
      browser.reloadWithFlags(flags);
      return;
    }
    if (typeof browser.reload === "function") {
      browser.reload();
    }
  } catch {
    // Ignore transient reload errors while a tab is navigating
  }
}

function printManagedBrowser(win, targetBrowser) {
  const bc = targetBrowser?.browsingContext;
  if (!bc || typeof win?.PrintUtils?.startPrintWindow !== "function") {
    return;
  }
  try {
    win.PrintUtils.startPrintWindow(bc);
  } catch {
    // Ignore print invocation failures when browsingContext is closing
  }
}

function kickOffManagedLoad(browser, uriSpec, options = {}) {
  if (!browser || !uriSpec) {
    return;
  }
  const originAttrs = browser.browsingContext?.originAttributes || {
    userContextId: options.userContextId || 0,
  };
  const triggeringPrincipal =
    options.triggeringPrincipal ||
    Services.scriptSecurityManager.createNullPrincipal(originAttrs);
  let loadFlags = Ci.nsIWebNavigation?.LOAD_FLAGS_NONE || 0;
  if (!options.allowInheritPrincipal) {
    loadFlags |= Ci.nsIWebNavigation?.LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL || 0;
  }
  const loadOpts = {
    triggeringPrincipal,
    referrerInfo: options.referrerInfo || null,
    policyContainer: options.policyContainer || null,
    postData: options.postData || null,
    loadFlags,
    hasValidUserGestureActivation: options.hasValidUserGestureActivation ?? true,
  };
  if (typeof browser.fixupAndLoadURIString === "function") {
    browser.fixupAndLoadURIString(uriSpec, loadOpts);
  } else if (typeof browser.loadURI === "function") {
    browser.loadURI(Services.io.newURI(uriSpec), loadOpts);
  } else {
    browser.setAttribute("src", uriSpec);
  }
}

function openManagedNewTab(win, state, options = {}) {
  const tabId = nextHostTabId();
  const uriSpec = String(options.url || options.uri?.spec || "").trim();
  const hasInitialUrl = Boolean(uriSpec && uriSpec !== "about:blank");
  const rec = createManagedTab(win, state, tabId, {
    ...options,
    url: hasInitialUrl ? uriSpec : "about:blank",
  });
  if (!rec) {
    return null;
  }
  emitEvent(state, {
    type: "open-tab",
    tabId,
    url: hasInitialUrl ? uriSpec : "",
    activate: options.activate !== false,
    nativeReady: true,
  });
  return rec.browser;
}

function wrapFallbackRouting(win) {
  const origBrowserDOMWindow = win?.browserDOMWindow;
  if (origBrowserDOMWindow && !origBrowserDOMWindow.isSanctuaryDelegated) {
    const callOrFallback = (routed, fallbackFn) => (routed !== undefined ? routed : fallbackFn());
    win.browserDOMWindow = {
      isSanctuaryDelegated: true,
      QueryInterface: ChromeUtils.generateQI(["nsIBrowserDOMWindow"]),
      createContentWindow(aURI, aOpenWindowInfo, aWhere, aFlags, aTriggeringPrincipal, aPolicyContainer) {
        return callOrFallback(
          SanctuaryWindowHost.routeContentWindow(
            win,
            aURI,
            aOpenWindowInfo,
            aWhere,
            aFlags,
            aTriggeringPrincipal,
            aPolicyContainer,
            true
          ),
          () =>
            origBrowserDOMWindow.createContentWindow?.(
              aURI,
              aOpenWindowInfo,
              aWhere,
              aFlags,
              aTriggeringPrincipal,
              aPolicyContainer
            )
        );
      },
      openURI(aURI, aOpenWindowInfo, aWhere, aFlags, aTriggeringPrincipal, aPolicyContainer) {
        if (!aURI) {
          if (globalThis.Components?.Exception) {
            throw globalThis.Components.Exception("", globalThis.Cr?.NS_ERROR_FAILURE);
          }
          throw new Error("openURI should only be called with a valid URI");
        }
        return callOrFallback(
          SanctuaryWindowHost.routeContentWindow(
            win,
            aURI,
            aOpenWindowInfo,
            aWhere,
            aFlags,
            aTriggeringPrincipal,
            aPolicyContainer,
            false
          ),
          () =>
            origBrowserDOMWindow.openURI?.(
              aURI,
              aOpenWindowInfo,
              aWhere,
              aFlags,
              aTriggeringPrincipal,
              aPolicyContainer
            )
        );
      },
      createContentWindowInFrame(aURI, aParams, aWhere, aFlags, aName) {
        return callOrFallback(
          SanctuaryWindowHost.routeContentWindowInFrame(win, aURI, aParams, aWhere, aFlags, aName, true),
          () => origBrowserDOMWindow.createContentWindowInFrame?.(aURI, aParams, aWhere, aFlags, aName)
        );
      },
      openURIInFrame(aURI, aParams, aWhere, aFlags, aName) {
        return callOrFallback(
          SanctuaryWindowHost.routeContentWindowInFrame(win, aURI, aParams, aWhere, aFlags, aName, false),
          () => origBrowserDOMWindow.openURIInFrame?.(aURI, aParams, aWhere, aFlags, aName)
        );
      },
      canClose() {
        return typeof origBrowserDOMWindow.canClose === "function"
          ? origBrowserDOMWindow.canClose()
          : true;
      },
      isTabContentWindow(aWindow) {
        return typeof origBrowserDOMWindow.isTabContentWindow === "function"
          ? origBrowserDOMWindow.isTabContentWindow(aWindow)
          : false;
      },
      get tabCount() {
        return origBrowserDOMWindow.tabCount ?? 1;
      },
    };
  }

  if (typeof win?.openLinkIn === "function" && !win.openLinkIn.isSanctuaryDelegated) {
    const origOpenLinkIn = win.openLinkIn.bind(win);
    const wrappedOpenLinkIn = (url, where, params = {}) => {
      if (SanctuaryWindowHost.routeLinkOpen(win, url, where, params)) {
        return;
      }
      return origOpenLinkIn(url, where, params);
    };
    wrappedOpenLinkIn.isSanctuaryDelegated = true;
    win.openLinkIn = wrappedOpenLinkIn;
  }
}

export const SanctuaryWindowHost = {
  isShellWindow(win) {
    return Boolean(win && WINDOW_STATES.get(win)?.mounted);
  },

  routeContentWindowInFrame(win, aURI, aParams, aWhere, _aFlags, aName, skipLoad) {
    if (!this.isShellWindow(win) || aWhere === Ci.nsIBrowserDOMWindow?.OPEN_PRINT_BROWSER) {
      return undefined;
    }
    const isPriv = Boolean(
      aParams?.isPrivate ||
        aParams?.openerOriginAttributes?.privateBrowsingId ||
        aParams?.openWindowInfo?.originAttributes?.privateBrowsingId
    );
    if (isPriv && !isPrivateWindow(win)) {
      this.openPrivateWindow(win, { url: aURI?.spec || "" });
      return null;
    }
    const userContextId =
      aParams?.openerOriginAttributes && "userContextId" in aParams.openerOriginAttributes
        ? aParams.openerOriginAttributes.userContextId
        : aParams?.openWindowInfo?.originAttributes?.userContextId || 0;
    const state = getState(win);
    const opener = aParams?.openerBrowser || null;
    if (aWhere === Ci.nsIBrowserDOMWindow?.OPEN_CURRENTWINDOW) {
      const openerEntry = findTabEntryByBrowser(state, opener);
      const target = openerEntry?.browser || getFocusedManagedBrowser(state);
      if (target) {
        if (!skipLoad && aURI?.spec) {
          const entry = findTabEntryByBrowser(state, target);
          if (entry?.[1]) {
            entry[1].url = aURI.spec;
          }
          kickOffManagedLoad(target, aURI.spec, {
            triggeringPrincipal: aParams?.triggeringPrincipal || null,
            referrerInfo: aParams?.referrerInfo || null,
            policyContainer: aParams?.policyContainer || null,
          });
        }
        return target;
      }
      if (aURI?.spec && isShellOriginUrl(aURI.spec)) {
        return undefined;
      }
    }
    return openManagedNewTab(win, state, {
      uri: skipLoad ? null : aURI,
      predictedUri: aURI?.spec || "",
      openWindowInfo: aParams?.openWindowInfo || null,
      openerBrowser: opener,
      userContextId,
      name: aName || "",
      triggeringPrincipal: aParams?.triggeringPrincipal || null,
      referrerInfo: aParams?.referrerInfo || null,
      policyContainer: aParams?.policyContainer || null,
      skipLoad,
      activate: aWhere !== Ci.nsIBrowserDOMWindow?.OPEN_NEWTAB_BACKGROUND,
    });
  },

  routeContentWindow(
    win,
    aURI,
    aOpenWindowInfo,
    aWhere,
    _aFlags,
    aTriggeringPrincipal,
    aPolicyContainer,
    skipLoad
  ) {
    if (!this.isShellWindow(win) || aWhere === Ci.nsIBrowserDOMWindow?.OPEN_PRINT_BROWSER) {
      return undefined;
    }
    const isPriv = Boolean(aOpenWindowInfo?.originAttributes?.privateBrowsingId);
    if (isPriv && !isPrivateWindow(win)) {
      this.openPrivateWindow(win, { url: aURI?.spec || "" });
      return null;
    }
    const state = getState(win);
    const openerBrowser = aOpenWindowInfo?.parent?.top?.embedderElement || null;
    if (aWhere === Ci.nsIBrowserDOMWindow?.OPEN_CURRENTWINDOW) {
      const openerEntry = findTabEntryByBrowser(state, openerBrowser);
      const target = openerEntry?.browser || getFocusedManagedBrowser(state);
      if (target) {
        if (!skipLoad && aURI?.spec) {
          const entry = findTabEntryByBrowser(state, target);
          if (entry?.[1]) {
            entry[1].url = aURI.spec;
          }
          kickOffManagedLoad(target, aURI.spec, {
            triggeringPrincipal: aTriggeringPrincipal,
            policyContainer: aPolicyContainer,
          });
        }
        return target.browsingContext || null;
      }
      if (!aURI?.spec || isShellOriginUrl(aURI.spec)) {
        return undefined;
      }
    }
    const browser = openManagedNewTab(win, state, {
      uri: skipLoad ? null : aURI,
      predictedUri: aURI?.spec || "",
      openWindowInfo: aOpenWindowInfo || null,
      openerBrowser,
      userContextId: aOpenWindowInfo?.originAttributes?.userContextId || 0,
      triggeringPrincipal: aTriggeringPrincipal || null,
      policyContainer: aPolicyContainer || null,
      skipLoad,
      activate: aWhere !== Ci.nsIBrowserDOMWindow?.OPEN_NEWTAB_BACKGROUND,
    });
    return browser?.browsingContext || null;
  },

  routeLinkOpen(win, url, where, params = {}) {
    if (!this.isShellWindow(win)) {
      return false;
    }
    const targetUrl = String(url || "").trim();
    if (!targetUrl || !where || where === "save" || where === "chromeless") {
      return false;
    }
    if (params?.private && (!isPrivateWindow(win) || where === "window")) {
      this.openPrivateWindow(win, { url: targetUrl });
      return true;
    }
    const state = getState(win);
    const opener = params?.targetBrowser || params?.openerBrowser || win.nsContextMenu?.browser || null;
    if (where === "current") {
      const openerEntry = findTabEntryByBrowser(state, opener);
      if (openerEntry?.[1]?.browser) {
        openerEntry[1].url = targetUrl;
        kickOffManagedLoad(openerEntry[1].browser, targetUrl, params);
        return true;
      }
      if (isShellOriginUrl(targetUrl)) {
        return false;
      }
    }
    if (
      where === "current" ||
      where === "tab" ||
      where === "tabshifted" ||
      where === "window"
    ) {
      const activate =
        params?.inBackground !== undefined && params?.inBackground !== null
          ? !params.inBackground
          : where !== "tabshifted";
      const browser = openManagedNewTab(win, state, {
        url: targetUrl,
        predictedUri: targetUrl,
        openerBrowser: opener,
        userContextId: params?.userContextId || 0,
        triggeringPrincipal: params?.triggeringPrincipal || null,
        referrerInfo: params?.referrerInfo || null,
        policyContainer: params?.policyContainer || null,
        postData: params?.postData || null,
        allowInheritPrincipal: Boolean(params?.allowInheritPrincipal),
        hasValidUserGestureActivation: params?.hasValidUserGestureActivation ?? true,
        activate,
      });
      if (!browser) {
        return false;
      }
      params?.resolveOnNewTabCreated?.(browser);
      params?.resolveOnContentBrowserCreated?.(browser);
      return true;
    }
    return false;
  },

  mount(win) {
    if (!observerInstalled) {
      observerInstalled = true;
      Services.obs.addObserver(subject => {
        SanctuaryWindowHost.mount(subject);
      }, "browser-delayed-startup-finished");
    }
    if (!win?.document) {
      return;
    }
    startSanctuaryModules();
    const state = getState(win);
    if (state.mounted) {
      if (isPrivateWindow(win) && state.pendingPrivateUrl) {
        const pendingUrl = String(state.pendingPrivateUrl || "");
        state.pendingPrivateUrl = "";
        const shellBrowser = state.shellTab?.linkedBrowser || win.gBrowser?.selectedBrowser;
        if (shellBrowser) {
          const destSpec = buildPrivateShellUrl(pendingUrl);
          try {
            if (typeof shellBrowser.loadURI === "function") {
              shellBrowser.loadURI(Services.io.newURI(destSpec), {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
              });
            } else {
              shellBrowser.setAttribute?.("src", destSpec);
            }
          } catch {
            // Ignore transient navigation errors
          }
        }
      }
      return;
    }
    state.mounted = true;
    state.shellTab = resolveShellTab(win, state);
    applyShellWindowChromeStyle(win);
    ensureStatusPanelLayer(win);
    syncShellChromeMode(win, true);
    wrapFallbackRouting(win);
    if (isPrivateWindow(win)) {
      const shellBrowser = state.shellTab?.linkedBrowser || win.gBrowser?.selectedBrowser;
      const currentSpec = String(shellBrowser?.currentURI?.spec || "");
      const pendingUrl = String(state.pendingPrivateUrl || "");
      state.pendingPrivateUrl = "";
      if (shellBrowser && (!isShellOriginUrl(currentSpec) || pendingUrl)) {
        const destSpec = buildPrivateShellUrl(pendingUrl);
        try {
          if (typeof shellBrowser.loadURI === "function") {
            shellBrowser.loadURI(Services.io.newURI(destSpec), {
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
            });
          } else {
            shellBrowser.setAttribute?.("src", destSpec);
          }
        } catch {
          // Ignore transient startup navigation error
        }
      }
    }

    const emitBlockedCountIfChanged = (tabId, rec) => {
      const nextBlocked = getBlockedCountForBrowser(win, rec.browser);
      if (nextBlocked !== rec.blockedCount) {
        rec.blockedCount = nextBlocked;
        emitEvent(state, {
          type: "blocked-count",
          tabId,
          blockedCount: nextBlocked,
        });
      }
    };

    const tabsProgressListener = {
      onLocationChange(browser, webProgress, _request, location, flags = 0) {
        if (webProgress && !webProgress.isTopLevel) {
          return;
        }
        const sessionStoreFlag = Ci.nsIWebProgressListener?.LOCATION_CHANGE_SESSION_STORE || 0;
        if (sessionStoreFlag && (flags & sessionStoreFlag)) {
          return;
        }
        const entry = findTabEntryByBrowser(state, browser);
        if (!entry) {
          return;
        }
        const [tabId, rec] = entry;
        const spec = String(location?.spec || "").trim();
        if (!spec || spec === "about:blank" || spec.startsWith("about:neterror")) {
          return;
        }
        const changed = spec !== rec.url;
        rec.url = spec;
        const contentTitle = String(browser.contentTitle || "").trim();
        if (contentTitle) {
          rec.title = contentTitle;
        }
        emitEvent(state, {
          type: "location-change",
          tabId,
          url: spec,
          title: contentTitle,
          loading: false,
          pushHistory: changed,
          canGoBack: Boolean(browser.canGoBack),
          canGoForward: Boolean(browser.canGoForward),
        });
        emitBlockedCountIfChanged(tabId, rec);
      },

      onStateChange(browser, webProgress, _request, stateFlags) {
        if (webProgress && !webProgress.isTopLevel) {
          return;
        }
        const flags = Ci.nsIWebProgressListener;
        if (!flags || !(stateFlags & flags.STATE_IS_NETWORK)) {
          return;
        }
        const entry = findTabEntryByBrowser(state, browser);
        if (!entry) {
          return;
        }
        const [tabId] = entry;
        if (stateFlags & flags.STATE_START) {
          emitEvent(state, { type: "loading-change", tabId, loading: true });
        } else if (stateFlags & flags.STATE_STOP) {
          const [, stopRec] = entry;
          emitEvent(state, {
            type: "loading-change",
            tabId,
            loading: false,
            canGoBack: Boolean(browser.canGoBack),
            canGoForward: Boolean(browser.canGoForward),
          });
          if (typeof win.setTimeout === "function") {
            win.setTimeout(() => {
              if (state.tabs.get(tabId) === stopRec) {
                void captureRecordSnapshot(win, state, tabId, stopRec);
              }
            }, 120);
          }
        }
      },

      onContentBlockingEvent(browser) {
        const entry = findTabEntryByBrowser(state, browser);
        if (!entry) {
          return;
        }
        const [tabId, rec] = entry;
        emitBlockedCountIfChanged(tabId, rec);
      },
    };

    const onPageTitleChanged = event => {
      const browser = event?.target;
      const entry = findTabEntryByBrowser(state, browser);
      if (!entry) {
        return;
      }
      const [tabId, rec] = entry;
      const title = String(browser?.contentTitle || "").trim();
      if (title) {
        rec.title = title;
        emitEvent(state, { type: "title-change", tabId, title });
      }
    };

    const onTabOpen = event => {
      if (state.suppressTabOpen) {
        return;
      }
      const tab = event?.target;
      if (!tab || tab === state.shellTab || findTabEntryByTab(state, tab)) {
        return;
      }
      const browser = win.gBrowser?.getBrowserForTab?.(tab) || tab.linkedBrowser;
      if (!browser) {
        return;
      }
      hideManagedTabStripEntry(win, tab);
      const tabId = nextHostTabId();
      const spec = String(browser.currentURI?.spec || "").trim();
      const initialUrl =
        spec && spec !== "about:blank" && !spec.startsWith("about:neterror") ? spec : "";
      const rec = attachTabRecord(win, state, tabId, tab, initialUrl);
      emitEvent(state, {
        type: "open-tab",
        tabId,
        url: rec.url,
        activate: true,
        nativeReady: true,
      });
    };

    const onTabSelect = event => {
      const selected = event?.target || win.gBrowser?.selectedTab;
      const shellTab = resolveShellTab(win, state);
      if (shellTab && !shellTab.closing && selected && selected !== shellTab && win.gBrowser) {
        state.shellTab = shellTab;
        try {
          win.gBrowser.selectedTab = shellTab;
        } catch {
          // Ignore selection errors during window close
        }
        for (const rec of state.tabs.values()) {
          hideManagedTabStripEntry(win, rec.tab);
        }
      }
    };

    const onTabClose = event => {
      if (state.suppressTabClose) {
        return;
      }
      const found = findTabEntryByTab(state, event?.target);
      if (!found) {
        return;
      }
      const [tabId, rec] = found;
      cleanupTabRecord(rec);
      state.tabs.delete(tabId);
      emitEvent(state, { type: "close-tab", tabId });
    };

    const onTabRemotenessChange = event => {
      const tab = event?.target;
      const found = findTabEntryByTab(state, tab);
      if (!found) {
        return;
      }
      const [tabId, rec] = found;
      const nextBrowser = win.gBrowser?.getBrowserForTab?.(tab) || tab.linkedBrowser || rec.browser;
      if (nextBrowser && nextBrowser !== rec.browser) {
        detachBrowserDomListeners(rec);
        rec.browser = nextBrowser;
        attachBrowserDomListeners(win, state, tabId, rec);
      }
      rec.panel = resolvePanelForTab(win, tab, rec.browser) || rec.panel;
      if (state.active && !state.overlayOpen && state.activePanes.some(p => p.tabId === tabId)) {
        tab.setAttribute?.("sanctuary-managed-tab", "true");
        if (rec.browser) {
          rec.browser.docShellIsActive = true;
          rec.browser.renderLayers = true;
        }
      }
    };

    const onKeyDown = event => {
      const key = String(event.key || "").toLowerCase();
      const isMod = Boolean(event.ctrlKey || event.metaKey);
      if (event.key === "F5" || (isMod && !event.altKey && key === "r")) {
        event.preventDefault();
        event.stopPropagation();
        reloadManagedBrowser(getFocusedManagedBrowser(state), Boolean(event.shiftKey));
        return;
      }
      if (isMod && !event.altKey && !event.shiftKey && key === "p") {
        event.preventDefault();
        event.stopPropagation();
        printManagedBrowser(win, getFocusedManagedBrowser(state) || win.gBrowser?.selectedBrowser);
      }
    };

    const onCommand = event => {
      const cmdId = event.target?.id;
      const targetBrowser =
        state.contextBrowser || win.gContextMenu?.browser || getFocusedManagedBrowser(state);
      const isManagedTarget = Boolean(
        targetBrowser && targetBrowser !== state.shellTab?.linkedBrowser
      );
      if (cmdId === "Browser:Back" || cmdId === "Browser:BackOrBackDuplicate") {
        if (isManagedTarget) {
          event.preventDefault();
          event.stopPropagation();
          if (targetBrowser.canGoBack) {
            targetBrowser.goBack?.();
          }
        }
      } else if (cmdId === "Browser:Forward" || cmdId === "Browser:ForwardOrForwardDuplicate") {
        if (isManagedTarget) {
          event.preventDefault();
          event.stopPropagation();
          if (targetBrowser.canGoForward) {
            targetBrowser.goForward?.();
          }
        }
      } else if (
        cmdId === "Browser:Reload" ||
        cmdId === "Browser:ReloadOrDuplicate" ||
        cmdId === "Browser:ReloadSkipCache"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (isManagedTarget) {
          reloadManagedBrowser(targetBrowser, cmdId === "Browser:ReloadSkipCache");
        }
      } else if (cmdId === "Browser:Stop") {
        if (isManagedTarget) {
          event.preventDefault();
          event.stopPropagation();
          targetBrowser.stop?.();
        }
      } else if (cmdId === "cmd_print") {
        event.preventDefault();
        event.stopPropagation();
        printManagedBrowser(win, getFocusedManagedBrowser(state) || win.gBrowser?.selectedBrowser);
      }
    };

    const onPopupShowing = event => {
      if (event.target?.id !== "contentAreaContextMenu" || event.defaultPrevented) {
        return;
      }
      const menu = event.target;
      const cm = win.gContextMenu;
      if (!cm) {
        return;
      }
      const targetBrowser = cm.browser || null;
      const shellTab = resolveShellTab(win, state);
      const managedEntry = findTabEntryByBrowser(state, targetBrowser);
      const isShellContext =
        !managedEntry &&
        (targetBrowser === shellTab?.linkedBrowser ||
          isShellOriginUrl(targetBrowser?.currentURI?.spec));
      const privWin = isPrivateWindow(win);
      const selectedFullText = String(
        cm.selectionInfo?.fullText || cm.selectionInfo?.text || ""
      ).trim();
      const hasSelection = Boolean(cm.isContentSelected && selectedFullText);
      const isInteractiveShellTarget = Boolean(
        cm.onTextInput ||
          cm.onEditable ||
          hasSelection ||
          cm.onLink ||
          cm.onImage ||
          cm.onCanvas ||
          cm.onVideo ||
          cm.onAudio
      );

      if (isShellContext && !isInteractiveShellTarget && !event.shiftKey) {
        event.preventDefault();
        return;
      }

      if (isShellContext) {
        for (const id of [
          "context-navigation",
          "context-sep-navigation",
          "context-savepage",
          "context-viewsource",
          "context-viewpartialsource-selection",
          "frame",
          "frame-sep",
        ]) {
          const el = win.document.getElementById(id);
          if (el) {
            el.hidden = true;
          }
        }
      } else {
        state.contextBrowser = targetBrowser;
        const setDisabled = (id, disabled) => {
          const el = win.document.getElementById(id);
          if (!el) {
            return;
          }
          if (disabled) {
            el.setAttribute("disabled", "true");
          } else {
            el.removeAttribute("disabled");
          }
        };
        setDisabled("Browser:Back", !targetBrowser?.canGoBack);
        setDisabled("context-back", !targetBrowser?.canGoBack);
        setDisabled("Browser:Forward", !targetBrowser?.canGoForward);
        setDisabled("context-forward", !targetBrowser?.canGoForward);
        setDisabled("Browser:Reload", false);
        setDisabled("context-reload", false);
        if (privWin) {
          const openPrivEl = win.document.getElementById("context-openlinkprivate");
          if (openPrivEl) {
            openPrivEl.hidden = true;
          }
        }
      }

      const items = ensureSanctuaryContextMenuItems(win, state, menu);
      if (!items) {
        return;
      }
      const targetUrl = String(managedEntry?.[1]?.url || targetBrowser?.currentURI?.spec || "");
      const targetTitle = String(managedEntry?.[1]?.title || targetBrowser?.contentTitle || "");
      state.lastContextTarget = {
        tabId: managedEntry?.[0] || "",
        url: targetUrl,
        title: targetTitle,
        text: selectedFullText,
        isShell: isShellContext,
      };

      const isWebPage = !isShellContext && !cm.onTextInput && /^https?:\/\//i.test(targetUrl);
      if (items.searchSelection) {
        items.searchSelection.hidden = !hasSelection;
        if (hasSelection) {
          const snippet =
            selectedFullText.length > 28 ? `${selectedFullText.slice(0, 28)}…` : selectedFullText;
          items.searchSelection.setAttribute("label", `Search Web for "${snippet}"`);
        }
      }
      if (items.bookmarkPage) {
        const showBookmark =
          isWebPage && !privWin && !cm.onLink && !cm.onImage && !cm.onVideo && !cm.onAudio;
        items.bookmarkPage.hidden = !showBookmark;
        items.bookmarkPage.setAttribute("label", "Bookmark Page");
      }
      if (items.askSanctuary) {
        const showAsk = !privWin && (hasSelection || isWebPage);
        items.askSanctuary.hidden = !showAsk;
        items.askSanctuary.setAttribute(
          "label",
          hasSelection ? "Ask Sanctuary about Selection" : "Ask Sanctuary about Page"
        );
      }
      if (items.clipDatabank) {
        const showClip = !privWin && isWebPage;
        items.clipDatabank.hidden = !showClip;
        items.clipDatabank.setAttribute(
          "label",
          hasSelection ? "Clip Selection to Data Bank" : "Clip Page to Data Bank"
        );
      }
      if (items.sep) {
        items.sep.hidden = Boolean(
          items.searchSelection?.hidden &&
            items.bookmarkPage?.hidden &&
            items.askSanctuary?.hidden &&
            items.clipDatabank?.hidden
        );
      }
    };

    const onPopupHiding = event => {
      if (event.target?.id === "contentAreaContextMenu") {
        state.contextBrowser = null;
      }
    };

    win.gBrowser?.addTabsProgressListener?.(tabsProgressListener);
    win.gBrowser?.addEventListener?.("pagetitlechanged", onPageTitleChanged);
    win.gBrowser?.tabContainer?.addEventListener?.("TabOpen", onTabOpen);
    win.gBrowser?.tabContainer?.addEventListener?.("TabSelect", onTabSelect);
    win.gBrowser?.tabContainer?.addEventListener?.("TabClose", onTabClose);
    win.gBrowser?.tabContainer?.addEventListener?.("TabRemotenessChange", onTabRemotenessChange);
    win.addEventListener("keydown", onKeyDown, true);
    win.document.addEventListener("command", onCommand, true);
    win.document.addEventListener("popupshowing", onPopupShowing);
    win.document.addEventListener("popuphiding", onPopupHiding);
    win.addEventListener(
      "unload",
      () => {
        win.removeEventListener("keydown", onKeyDown, true);
        win.document.removeEventListener("command", onCommand, true);
        win.document.removeEventListener("popupshowing", onPopupShowing);
        win.document.removeEventListener("popuphiding", onPopupHiding);
        win.gBrowser?.removeTabsProgressListener?.(tabsProgressListener);
        win.gBrowser?.removeEventListener?.("pagetitlechanged", onPageTitleChanged);
        win.gBrowser?.tabContainer?.removeEventListener?.("TabOpen", onTabOpen);
        win.gBrowser?.tabContainer?.removeEventListener?.("TabSelect", onTabSelect);
        win.gBrowser?.tabContainer?.removeEventListener?.("TabClose", onTabClose);
        win.gBrowser?.tabContainer?.removeEventListener?.("TabRemotenessChange", onTabRemotenessChange);
        SanctuaryWindowHost.resetPanes(win);
      },
      { once: true }
    );
  },

  resetPanes(win, parentActor = null) {
    if (!win) {
      return;
    }
    const state = getState(win);
    const shellTab = resolveShellTab(win, state, parentActor);
    state.suppressTabClose = true;
    try {
      for (const rec of state.tabs.values()) {
        cleanupTabRecord(rec);
        if (rec.tab && rec.tab !== shellTab && !rec.tab.closing) {
          win.gBrowser?.removeTab?.(rec.tab, { animate: false, skipSessionStore: true });
        }
      }
      state.tabs.clear();
      const rawTabs = win.gBrowser?.tabs ? [...win.gBrowser.tabs] : [];
      for (const tab of rawTabs) {
        if (tab && tab !== shellTab && !tab.closing && !tab.pinned) {
          win.gBrowser?.removeTab?.(tab, { animate: false, skipSessionStore: true });
        }
      }
      if (shellTab && win.gBrowser && win.gBrowser.selectedTab !== shellTab && !shellTab.closing) {
        win.gBrowser.selectedTab = shellTab;
      }
    } finally {
      state.suppressTabClose = false;
    }
    state.active = false;
    state.overlayOpen = false;
    state.focusedPane = "primary";
    state.activePanes = [];
    win.document?.documentElement?.removeAttribute?.("data-sanctuary-browser-active");
  },

  openPrivateWindow(win, { url = "" } = {}) {
    const opener = win || Services.wm.getMostRecentBrowserWindow();
    if (!opener || typeof opener.OpenBrowserWindow !== "function") {
      return { opened: false };
    }
    const targetUrl = String(url || "").trim();
    const privWin = opener.OpenBrowserWindow({ private: true });
    if (!privWin) {
      return { opened: false };
    }
    const privState = getState(privWin);
    privState.pendingPrivateUrl = /^https?:\/\//i.test(targetUrl) ? targetUrl : "";
    if (privWin.document && privWin.gBrowser) {
      SanctuaryWindowHost.mount(privWin);
    } else {
      const onReady = subject => {
        if (subject !== privWin) {
          return;
        }
        Services.obs.removeObserver(onReady, "browser-delayed-startup-finished");
        SanctuaryWindowHost.mount(privWin);
      };
      Services.obs.addObserver(onReady, "browser-delayed-startup-finished");
    }
    return { opened: true };
  },

  async loadTab(win, parentActor, { tabId, url, forceReload = false }) {
    if (!win || !tabId || !url) {
      return { kind: "native", url: url || "", title: url || "", blockedCount: 0 };
    }
    SanctuaryWindowHost.mount(win);
    const state = getState(win);
    state.parentActor = parentActor;
    state.shellTab = resolveShellTab(win, state, parentActor);
    syncShellChromeMode(win, true);
    applyShellWindowChromeStyle(win);
    ensureStatusPanelLayer(win);
    let rec = state.tabs.get(tabId);
    if (!rec) {
      rec = createManagedTab(win, state, tabId, {
        url,
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        skipLoad: true,
      });
    }
    const browser = rec?.browser;
    if (browser) {
      if (rec.url !== url) {
        rec.url = url;
        const triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
        if (typeof browser.loadURI === "function") {
          browser.loadURI(Services.io.newURI(url), { triggeringPrincipal });
        } else {
          browser.setAttribute("src", url);
        }
      } else if (forceReload) {
        if (typeof browser.reload === "function") {
          browser.reload();
        } else if (typeof browser.loadURI === "function") {
          const triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
          browser.loadURI(Services.io.newURI(url), {
            triggeringPrincipal,
            loadFlags: Ci.nsIWebNavigation?.LOAD_FLAGS_BYPASS_CACHE || 0,
          });
        }
      }
    }
    let title = browser?.contentTitle || "";
    if (!title) {
      try {
        title = new URL(url).hostname || url;
      } catch {
        title = url;
      }
    }
    const blockedCount = getBlockedCountForBrowser(win, browser);
    if (rec) {
      rec.blockedCount = blockedCount;
    }
    return {
      kind: "native",
      url,
      title,
      blockedCount,
    };
  },

  stepHistory(win, { tabId, delta = 0 } = {}) {
    if (!win || !tabId) {
      return { handled: false };
    }
    const state = getState(win);
    const rec = state.tabs.get(tabId);
    const browser = rec?.browser;
    if (!browser) {
      return { handled: false };
    }
    try {
      if (Number(delta) < 0 && browser.canGoBack && typeof browser.goBack === "function") {
        browser.goBack();
        return {
          handled: true,
          canGoBack: Boolean(browser.canGoBack),
          canGoForward: Boolean(browser.canGoForward),
        };
      }
      if (Number(delta) > 0 && browser.canGoForward && typeof browser.goForward === "function") {
        browser.goForward();
        return {
          handled: true,
          canGoBack: Boolean(browser.canGoBack),
          canGoForward: Boolean(browser.canGoForward),
        };
      }
    } catch {
      // Fall back to frontend URL history stepping when native history cannot step
    }
    return {
      handled: false,
      canGoBack: Boolean(browser.canGoBack),
      canGoForward: Boolean(browser.canGoForward),
    };
  },

  async clearHistory(win) {
    if (win) {
      const state = getState(win);
      for (const rec of state.tabs.values()) {
        try {
          rec?.browser?.browsingContext?.sessionHistory?.purgeHistory?.();
        } catch {
          // Ignore per-tab session history purge failures
        }
      }
    }
    try {
      const { PlacesUtils } = ChromeUtils.importESModule(
        "resource://gre/modules/PlacesUtils.sys.mjs"
      );
      if (typeof PlacesUtils?.history?.clear === "function") {
        await PlacesUtils.history.clear();
      }
    } catch {
      // PlacesUtils unavailable in minimal test harness
    }
    return { cleared: true };
  },

  async extractTabContent(win, { tabId } = {}) {
    if (!win || !tabId) {
      return { ok: false };
    }
    const state = getState(win);
    const rec = state.tabs.get(tabId);
    const browser = rec?.browser;
    if (!browser) {
      return { ok: false };
    }
    const topSpec = String(browser.currentURI?.spec || "").trim();
    const validTopUrl =
      topSpec && topSpec !== "about:blank" && !topSpec.startsWith("about:neterror")
        ? topSpec
        : String(rec.url || "").trim();
    const topTitle = String(browser.contentTitle || rec.title || "").trim();
    const windowGlobal = browser.browsingContext?.currentWindowGlobal || null;

    let inspected = {};
    if (windowGlobal) {
      try {
        const shActor = windowGlobal.getActor("SanctuaryHost");
        inspected = (await shActor.sendQuery("SanctuaryHost:InspectDocument", {})) || {};
      } catch {
        inspected = {};
      }
    }

    let peText = "";
    if (windowGlobal && !inspected?.selection && !inspected?.exportedText) {
      try {
        const peActor = windowGlobal.getActor("PageExtractor");
        const peRes = await peActor.getText({
          removeBoilerplate: true,
          sourceUrl: validTopUrl || undefined,
        });
        peText = String(peRes?.text || "").trim();
        if (
          peText.length < 80 &&
          String(inspected?.fallbackText || "").length > peText.length * 2
        ) {
          const fullRes = await peActor.getText({
            removeBoilerplate: false,
            sourceUrl: validTopUrl || undefined,
          });
          const fullText = String(fullRes?.text || "").trim();
          if (fullText.length > peText.length) {
            peText = fullText;
          }
        }
      } catch {
        peText = "";
      }
    }

    const url = validTopUrl || String(inspected?.url || "").trim();
    const title = topTitle || String(inspected?.title || "").trim();
    const text = String(
      inspected?.selection ||
        inspected?.exportedText ||
        peText ||
        inspected?.fallbackText ||
        inspected?.excerpt ||
        ""
    )
      .trim()
      .slice(0, 250000);
    const excerpt = String(inspected?.excerpt || text.slice(0, 400)).trim();

    return {
      ok: Boolean(text),
      url,
      title,
      siteName: String(inspected?.siteName || "").trim(),
      text,
      excerpt,
      isSelection: Boolean(inspected?.selection),
    };
  },

  async actOnTab(win, { tabId = "", action = "snapshot", args = {} } = {}) {
    if (!win) {
      return { ok: false, error: "no_window", message: "No browser window available." };
    }
    startSanctuaryModules();
    const state = getState(win);
    let rec = tabId ? state.tabs.get(tabId) : null;
    if (!rec) {
      const focusedPane = state.activePanes.find(p => p.pane === state.focusedPane) || state.activePanes[0];
      if (focusedPane?.tabId) {
        rec = state.tabs.get(focusedPane.tabId) || null;
      }
      if (!rec) {
        for (const candidate of state.tabs.values()) {
          rec = candidate;
          break;
        }
      }
    }
    const browser = rec?.browser;
    if (!browser) {
      return { ok: false, error: "no_tab", message: "No open Browser tab to inspect or act on." };
    }

    const topSpec = String(browser.currentURI?.spec || "").trim();
    const url =
      topSpec && topSpec !== "about:blank" && !topSpec.startsWith("about:neterror")
        ? topSpec
        : String(rec.url || "").trim();
    const title = String(browser.contentTitle || rec.title || "").trim();

    let pageActorFn = null;
    try {
      const mod = ChromeUtils.importESModule(
        "moz-src:///browser/components/sanctuary/SanctuaryAgentPageParent.sys.mjs"
      );
      pageActorFn = mod?.pageActor || null;
    } catch {
      pageActorFn = null;
    }

    const cleanAction = String(action || "snapshot").toLowerCase();
    const cleanArgs = args && typeof args === "object" ? args : {};

    if (!pageActorFn) {
      if (cleanAction === "read_text" || cleanAction === "read" || cleanAction === "snapshot") {
        const fallback = await SanctuaryWindowHost.extractTabContent(win, { tabId: rec.tabId || tabId });
        return {
          ok: Boolean(fallback?.ok),
          url: fallback?.url || url,
          title: fallback?.title || title,
          text: fallback?.text || "",
          snapshot: fallback?.text || "",
        };
      }
      return { ok: false, error: "actor_unavailable", message: "SanctuaryAgentPage actor is not available." };
    }

    try {
      const actor = pageActorFn(browser);
      if (["click", "type", "select", "press"].includes(cleanAction)) {
        try {
          const chall = await actor.challenge();
          const hasChallenge =
            (Array.isArray(chall?.frames) && chall.frames.length > 0) ||
            Boolean(chall?.markers?.turnstile || chall?.markers?.recaptcha || chall?.markers?.hcaptcha);
          if (hasChallenge) {
            return {
              ok: false,
              error: "human_verification_required",
              url,
              title,
              message: "A CAPTCHA or human-verification check is displayed. Ask the user to complete it in the Browser.",
            };
          }
        } catch {
          // Proceed if challenge probe unsupported on page
        }
      }

      if (cleanAction === "snapshot") {
        const snap = await actor.snapshot({
          ref: cleanArgs.ref ? String(cleanArgs.ref) : undefined,
          viewportOnly: Boolean(cleanArgs.viewportOnly),
        });
        return {
          ok: true,
          url,
          title,
          snapshot: String(snap?.text || ""),
          refs: Number(snap?.refs || 0),
          truncated: Boolean(snap?.truncated),
        };
      }

      if (cleanAction === "read_text" || cleanAction === "read") {
        const res = await actor.text({
          ref: cleanArgs.ref ? String(cleanArgs.ref) : undefined,
          offset: Number(cleanArgs.offset || 0),
          chunk: Number(cleanArgs.chunk || 20000),
        });
        return {
          ok: true,
          url,
          title,
          text: String(res?.text || ""),
          total: Number(res?.total || 0),
          nextOffset: res?.nextOffset ?? null,
        };
      }

      if (cleanAction === "click") {
        const res = await actor.click({ ref: String(cleanArgs.ref || "") });
        return {
          ok: true,
          url: String(browser.currentURI?.spec || url),
          title: String(browser.contentTitle || title),
          ref: String(res?.ref || cleanArgs.ref || ""),
        };
      }

      if (cleanAction === "type") {
        const res = await actor.type({
          ref: String(cleanArgs.ref || ""),
          text: String(cleanArgs.text ?? ""),
          clear: cleanArgs.clear !== false,
        });
        return {
          ok: true,
          url,
          title,
          value: String(res?.value ?? ""),
        };
      }

      if (cleanAction === "select") {
        const vals = Array.isArray(cleanArgs.values)
          ? cleanArgs.values.map(v => String(v))
          : [String(cleanArgs.value ?? cleanArgs.text ?? "")];
        await actor.select({ ref: String(cleanArgs.ref || ""), values: vals });
        return { ok: true, url, title, values: vals };
      }

      if (cleanAction === "press") {
        const keys = Array.isArray(cleanArgs.keys)
          ? cleanArgs.keys.map(k => String(k))
          : [String(cleanArgs.key || "Enter")];
        await actor.press({ keys });
        return { ok: true, url: String(browser.currentURI?.spec || url), title: String(browser.contentTitle || title), keys };
      }

      if (cleanAction === "scroll") {
        await actor.scroll({
          ref: cleanArgs.ref ? String(cleanArgs.ref) : undefined,
          direction: cleanArgs.direction ? String(cleanArgs.direction) : (cleanArgs.ref ? undefined : "down"),
          amount: cleanArgs.amount !== undefined ? Number(cleanArgs.amount) : (cleanArgs.ref ? undefined : 3),
        });
        return { ok: true, url, title };
      }

      if (cleanAction === "wait_text") {
        const res = await actor.waitForText({
          text: String(cleanArgs.text || ""),
          timeoutMs: Math.min(15000, Math.max(500, Number(cleanArgs.timeoutMs || 5000))),
        });
        return { ok: true, url, title, found: Boolean(res?.found) };
      }

      return { ok: false, error: "unknown_action", message: `Unsupported browser action: ${cleanAction}` };
    } catch (err) {
      return {
        ok: false,
        url,
        title,
        error: String(err?.code || err?.name || "browser_error"),
        message: String(err?.message || err || "Browser action failed."),
      };
    }
  },

  closeTab(win, tabId) {
    if (!win || !tabId) {
      return;
    }
    const state = getState(win);
    const rec = state.tabs.get(tabId);
    if (!rec) {
      return;
    }
    cleanupTabRecord(rec);
    state.tabs.delete(tabId);
    if (rec.tab && rec.tab !== state.shellTab && !rec.tab.closing) {
      state.suppressTabClose = true;
      try {
        win.gBrowser?.removeTab?.(rec.tab, { animate: false, skipSessionStore: true });
      } finally {
        state.suppressTabClose = false;
      }
    }
  },

  syncLayout(win, parentActor, layout = {}) {
    if (!win) {
      return;
    }
    SanctuaryWindowHost.mount(win);
    const state = getState(win);
    state.parentActor = parentActor;
    state.shellTab = resolveShellTab(win, state, parentActor);
    syncShellChromeMode(win, true);
    applyShellWindowChromeStyle(win);
    ensureStatusPanelLayer(win);
    if (
      state.shellTab &&
      win.gBrowser &&
      win.gBrowser.selectedTab !== state.shellTab &&
      !state.shellTab.closing
    ) {
      try {
        win.gBrowser.selectedTab = state.shellTab;
      } catch {
        // Ignore transient selection errors
      }
    }
    const hostBrowser =
      parentActor?.browsingContext?.top?.embedderElement ||
      state.shellTab?.linkedBrowser ||
      win.gBrowser?.selectedBrowser ||
      null;
    const hostRect =
      typeof hostBrowser?.getBoundingClientRect === "function"
        ? hostBrowser.getBoundingClientRect()
        : { left: 0, top: 0 };
    const offsetX = Number(hostRect.left || 0);
    const offsetY = Number(hostRect.top || 0);
    const zoom = Number(hostBrowser?.browsingContext?.fullZoom || 1) || 1;

    const activeMap = new Map();
    const isActive = Boolean(layout.active && !layout.overlayOpen);
    state.active = isActive;
    state.overlayOpen = Boolean(layout.overlayOpen);
    state.focusedPane = String(layout.focusedPane || "primary");
    if (isActive && Array.isArray(layout.panes)) {
      for (const pane of layout.panes) {
        if (pane?.tabId && Number(pane.width) > 0 && Number(pane.height) > 0) {
          activeMap.set(pane.tabId, pane);
        }
      }
    }
    state.activePanes = [...activeMap.values()];

    const toScreenBounds = rect => ({
      leftPx: Math.round(offsetX + Number(rect.x || 0) * zoom),
      topPx: Math.round(offsetY + Number(rect.y || 0) * zoom),
      widthPx: Math.round(Number(rect.width) * zoom),
      heightPx: Math.round(Number(rect.height) * zoom),
    });

    for (const [tabId, rec] of state.tabs.entries()) {
      rec.panel = resolvePanelForTab(win, rec.tab, rec.browser) || rec.panel;
      hideManagedTabStripEntry(win, rec.tab);
      const rect = activeMap.get(tabId);
      if (!rect) {
        if (state.overlayOpen && rec.panel?.classList?.contains?.("sanctuary-active-tab-panel")) {
          void captureRecordSnapshot(win, state, tabId, rec);
        }
        hideManagedPanel(rec);
        continue;
      }
      showManagedPanel(rec, toScreenBounds(rect));
    }

    const rootEl = win.document?.documentElement;
    if (rootEl) {
      const targetPane =
        state.activePanes.find(p => p.pane === state.focusedPane) ||
        state.activePanes[0] ||
        null;
      if (isActive && targetPane) {
        const { leftPx, topPx, widthPx, heightPx } = toScreenBounds(targetPane);
        const winW = Number(win.innerWidth || 0);
        const winH = Number(win.innerHeight || 0);
        const rightGap = winW > 0 ? Math.max(8, winW - (leftPx + widthPx) + 8) : 12;
        const bottomGap = winH > 0 ? Math.max(8, winH - (topPx + heightPx) + 8) : 8;
        rootEl.setAttribute("data-sanctuary-browser-active", "true");
        rootEl.style?.setProperty?.("--sanctuary-pane-left", `${leftPx + 8}px`);
        rootEl.style?.setProperty?.("--sanctuary-pane-right", `${rightGap}px`);
        rootEl.style?.setProperty?.("--sanctuary-pane-bottom", `${bottomGap}px`);
        rootEl.style?.setProperty?.("--sanctuary-pane-max-w", `${Math.max(160, widthPx - 16)}px`);
      } else {
        rootEl.removeAttribute?.("data-sanctuary-browser-active");
      }
    }
  },

  async captureTabPreview(win, { tabId = "" } = {}) {
    if (!win || !tabId) {
      return { ok: false };
    }
    const state = getState(win);
    const rec = state.tabs.get(tabId);
    if (!rec) {
      return { ok: false };
    }
    return captureRecordSnapshot(win, state, tabId, rec);
  },

  async autofillTab(win, { tabId = "", login = "", password = "" } = {}) {
    if (!win || !tabId) {
      return { ok: false, filledCount: 0 };
    }
    const state = getState(win);
    const rec = state.tabs.get(tabId);
    const wgp = rec?.browser?.browsingContext?.currentWindowGlobal;
    if (!wgp || typeof wgp.getActor !== "function") {
      return { ok: false, filledCount: 0 };
    }
    try {
      const shActor = wgp.getActor("SanctuaryHost");
      return (
        (await shActor.sendQuery("SanctuaryHost:FillCredentials", {
          login: String(login || ""),
          password: String(password || ""),
        })) || { ok: false, filledCount: 0 }
      );
    } catch {
      return { ok: false, filledCount: 0 };
    }
  },

  applyProgramTheme(win, tokens = {}) {
    const rootStyle = win?.document?.documentElement?.style;
    if (!rootStyle) {
      return;
    }
    if (tokens.primary_accent) {
      rootStyle.setProperty("--primary-accent", String(tokens.primary_accent));
    }
    if (tokens.primary_glow) {
      rootStyle.setProperty("--primary-glow", String(tokens.primary_glow));
    }
    if (tokens.accent_border) {
      rootStyle.setProperty("--accent-border", String(tokens.accent_border));
    }
    if (tokens.accent_bg) {
      rootStyle.setProperty("--accent-bg", String(tokens.accent_bg));
    }
    if (tokens.bg_canvas) {
      rootStyle.setProperty("--bg-color", String(tokens.bg_canvas));
    }
  },

  notifyShellEvent(win, payload) {
    const state = win ? WINDOW_STATES.get(win) : null;
    if (!state || !payload || typeof payload !== "object") {
      return false;
    }
    emitEvent(state, payload);
    return true;
  },
};
