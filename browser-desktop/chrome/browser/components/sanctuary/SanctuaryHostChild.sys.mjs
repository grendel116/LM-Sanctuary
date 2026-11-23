/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store */

/**
 * Exposes window.sanctuaryBrowserHost exclusively to LM-Sanctuary's trusted shell origin.
 */
export class SanctuaryHostChild extends JSWindowActorChild {
  #listeners = new Set();
  #kpConnected = false;

  #isTrustedShellWindow() {
    const win = this.contentWindow;
    if (!win || win !== win.top) {
      return false;
    }
    try {
      const configured = Services.prefs.getStringPref(
        "browser.sanctuary.shellUrl",
        "http://127.0.0.1:5000"
      );
      const allowedOrigin = new URL(configured).origin;
      return win.location?.origin === allowedOrigin;
    } catch {
      return false;
    }
  }

  #isPrivatePageWindow() {
    const win = this.contentWindow;
    if (!win || win !== win.top) {
      return false;
    }
    const href = String(win.location?.href || "");
    const docUri = String(win.document?.documentURI || "");
    return (
      href.startsWith("about:privatebrowsing") ||
      docUri.startsWith("about:privatebrowsing") ||
      href === "chrome://browser/content/sval/home/private.html"
    );
  }

  #mountPrivatePage(win) {
    let cachedCfg = null;
    const dispatchCfg = () => {
      if (this.contentWindow !== win || !cachedCfg) {
        return;
      }
      win.dispatchEvent(
        new win.CustomEvent("SanctuaryPrivate:SearchConfig", {
          detail: Cu.cloneInto(cachedCfg, win),
        })
      );
    };

    win.addEventListener("SanctuaryPrivate:Ready", () => {
      dispatchCfg();
    });

    win.addEventListener("SanctuaryPrivate:Navigate", event => {
      if (!this.document?.hasValidTransientUserGestureActivation) {
        return;
      }
      const rawUrl = String(event?.detail?.url || "").trim();
      if (!/^https?:\/\//i.test(rawUrl)) {
        return;
      }
      this.sendAsyncMessage("SanctuaryHost:LoadPrivateUrl", { url: rawUrl });
    });

    this.sendQuery("SanctuaryHost:GetPrivateSearchConfig", {})
      .then(cfg => {
        cachedCfg = cfg ?? {};
        dispatchCfg();
      })
      .catch(() => {});
  }

  #sendAsyncToContent(win, msgName, payload) {
    return new win.Promise((resolve, reject) => {
      this.sendQuery(msgName, payload).then(
        result => resolve(Cu.cloneInto(result ?? null, win)),
        err => reject(new win.Error(String(err?.message || err || "Host error")))
      );
    });
  }

  handleEvent(event) {
    if (event?.type !== "DOMWindowCreated") {
      return;
    }
    const win = this.contentWindow;
    if (!win) {
      return;
    }
    if (!this.#isTrustedShellWindow()) {
      if (this.#isPrivatePageWindow()) {
        this.#mountPrivatePage(win);
      }
      return;
    }
    this.sendAsyncMessage("SanctuaryHost:ShellReset", {});
    const hostObj = Cu.createObjectIn(win, { defineAs: "sanctuaryBrowserHost" });

    Cu.exportFunction(
      (tabId, url, opts) => {
        const cleanOpts = opts && typeof opts === "object" ? Cu.waiveXrays(opts) : {};
        return this.#sendAsyncToContent(win, "SanctuaryHost:LoadTab", {
          tabId: String(tabId || ""),
          url: String(url || ""),
          privacy: cleanOpts.privacy ?? {},
          viewMode: String(cleanOpts.viewMode || "frame"),
          forceReload: Boolean(cleanOpts.forceReload),
        });
      },
      hostObj,
      { defineAs: "loadTab" }
    );

    Cu.exportFunction(
      tabId => {
        this.sendAsyncMessage("SanctuaryHost:CloseTab", {
          tabId: String(tabId || ""),
        });
      },
      hostObj,
      { defineAs: "closeTab" }
    );

    Cu.exportFunction(
      layout => {
        const clean = layout && typeof layout === "object" ? Cu.waiveXrays(layout) : {};
        this.sendAsyncMessage("SanctuaryHost:SyncLayout", {
          active: Boolean(clean.active),
          overlayOpen: Boolean(clean.overlayOpen),
          focusedPane: String(clean.focusedPane || "primary"),
          panes: Array.isArray(clean.panes)
            ? clean.panes.map(p => ({
                tabId: String(p?.tabId || ""),
                pane: String(p?.pane || "primary"),
                x: Number(p?.x || 0),
                y: Number(p?.y || 0),
                width: Number(p?.width || 0),
                height: Number(p?.height || 0),
              }))
            : [],
        });
      },
      hostObj,
      { defineAs: "syncLayout" }
    );

    Cu.exportFunction(
      privacy => {
        const clean = privacy && typeof privacy === "object" ? Cu.waiveXrays(privacy) : {};
        this.sendAsyncMessage("SanctuaryHost:SetPrivacy", { privacy: clean });
      },
      hostObj,
      { defineAs: "setPrivacy" }
    );

    Cu.exportFunction(
      tokens => {
        const clean = tokens && typeof tokens === "object" ? Cu.waiveXrays(tokens) : {};
        this.sendAsyncMessage("SanctuaryHost:SetTheme", { tokens: clean });
      },
      hostObj,
      { defineAs: "setProgramTheme" }
    );

    Cu.exportFunction(
      searchConfig => {
        const clean = searchConfig && typeof searchConfig === "object" ? Cu.waiveXrays(searchConfig) : {};
        this.sendAsyncMessage("SanctuaryHost:SetSearchConfig", { searchConfig: clean });
      },
      hostObj,
      { defineAs: "setSearchConfig" }
    );

    Cu.exportFunction(
      opts => {
        const clean = opts && typeof opts === "object" ? Cu.waiveXrays(opts) : {};
        return this.#sendAsyncToContent(win, "SanctuaryHost:OpenPrivateWindow", {
          url: String(clean.url || ""),
          searchConfig: clean.searchConfig ?? null,
        });
      },
      hostObj,
      { defineAs: "openPrivateWindow" }
    );

    Cu.exportFunction(
      () => this.#kpConnected,
      hostObj,
      { defineAs: "isKeePassConnected" }
    );

    Cu.exportFunction(
      () => this.#sendAsyncToContent(win, "SanctuaryHost:InstallOrOpenKeePassXC", {}),
      hostObj,
      { defineAs: "installOrOpenKeePassXC" }
    );

    Cu.exportFunction(
      tabId =>
        this.#sendAsyncToContent(win, "SanctuaryHost:ExtractTabContent", {
          tabId: String(tabId || ""),
        }),
      hostObj,
      { defineAs: "extractTabContent" }
    );

    Cu.exportFunction(
      (tabId, action, args) => {
        const cleanArgs = args && typeof args === "object" ? Cu.waiveXrays(args) : {};
        return this.#sendAsyncToContent(win, "SanctuaryHost:ActOnTab", {
          tabId: String(tabId || ""),
          action: String(action || "snapshot"),
          args: JSON.parse(JSON.stringify(cleanArgs)),
        });
      },
      hostObj,
      { defineAs: "actOnTab" }
    );

    Cu.exportFunction(
      (tabId, delta) =>
        this.#sendAsyncToContent(win, "SanctuaryHost:StepHistory", {
          tabId: String(tabId || ""),
          delta: Number(delta || 0),
        }),
      hostObj,
      { defineAs: "stepHistory" }
    );

    Cu.exportFunction(
      cb => {
        if (typeof cb !== "function") {
          return Cu.exportFunction(() => {}, win);
        }
        this.#listeners.add(cb);
        return Cu.exportFunction(() => {
          this.#listeners.delete(cb);
        }, win);
      },
      hostObj,
      { defineAs: "onEvent" }
    );

    this.sendQuery("SanctuaryHost:IsKeePassConnected", {})
      .then(connected => {
        this.#kpConnected = Boolean(connected);
      })
      .catch(() => {});
  }

  async #inspectDocument() {
    const win = this.contentWindow;
    const doc = win?.document;
    if (!win || !doc) {
      return {};
    }
    const url = String(win.location?.href || "");
    const title = String(doc.title || "").trim();
    const siteName = String(
      doc.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || ""
    ).trim();
    const excerpt = String(
      doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
        doc.querySelector('meta[property="og:description"]')?.getAttribute("content") ||
        ""
    ).trim();
    const selection = String(win.getSelection?.()?.toString?.() || "").trim();
    let exportedText = "";
    if (!selection && win.location?.hostname === "docs.google.com") {
      const m = String(win.location?.pathname || "").match(
        /^\/(document|spreadsheets)\/d\/([a-zA-Z0-9_-]+)/
      );
      if (m) {
        const exportUrl =
          m[1] === "document"
            ? `https://docs.google.com/document/d/${m[2]}/export?format=txt`
            : `https://docs.google.com/spreadsheets/d/${m[2]}/export?format=csv`;
        try {
          const ctrl = typeof AbortController === "function" ? new AbortController() : null;
          const timer = ctrl ? win.setTimeout(() => ctrl.abort(), 6000) : null;
          try {
            const resp = await win.fetch(exportUrl, {
              credentials: "include",
              signal: ctrl?.signal,
            });
            if (resp?.ok) {
              exportedText = String(await resp.text()).trim();
            }
          } finally {
            if (timer !== null) {
              win.clearTimeout(timer);
            }
          }
        } catch {
          // Fall back to DOM/PageExtractor when document export is unavailable
        }
      }
    }
    const fallbackText = String(doc.body?.innerText || "").trim().slice(0, 200000);
    return {
      url,
      title,
      siteName,
      excerpt,
      selection,
      exportedText,
      fallbackText,
    };
  }

  receiveMessage(message) {
    if (message?.name === "SanctuaryHost:InspectDocument") {
      return this.#inspectDocument();
    }
    if (message?.name === "SanctuaryHost:KeePassState") {
      this.#kpConnected = Boolean(message.data?.connected);
      return;
    }
    if (message?.name !== "SanctuaryHost:Event" || !this.#isTrustedShellWindow()) {
      return;
    }
    const win = this.contentWindow;
    const cloned = Cu.cloneInto(message.data ?? {}, win);
    for (const cb of this.#listeners) {
      try {
        cb(cloned);
      } catch {
        // Ignore downstream listener errors
      }
    }
  }

  didDestroy() {
    this.#listeners.clear();
  }
}
