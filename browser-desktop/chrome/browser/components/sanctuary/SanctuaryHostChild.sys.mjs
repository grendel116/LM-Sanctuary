/* SPDX-License-Identifier: AGPL-3.0-or-later */

/**
 * Exposes window.sanctuaryBrowserHost exclusively to LM-Sanctuary's trusted shell origin.
 */
export class SanctuaryHostChild extends JSWindowActorChild {
  #listeners = new Set();
  #kpConnected = false;
  #autofillCleanup = null;

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
      href === "chrome://browser/content/sanctuary/private/private.html"
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
        return;
      }
      if (this.#isAutofillableWebWindow(win)) {
        this.#mountWebLoginAutofill(win);
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
      tabId =>
        this.#sendAsyncToContent(win, "SanctuaryHost:CaptureTabPreview", {
          tabId: String(tabId || ""),
        }),
      hostObj,
      { defineAs: "captureTabPreview" }
    );

    Cu.exportFunction(
      (tabId, creds) => {
        const cleanCreds = creds && typeof creds === "object" ? Cu.waiveXrays(creds) : {};
        return this.#sendAsyncToContent(win, "SanctuaryHost:AutofillTab", {
          tabId: String(tabId || ""),
          login: String(cleanCreds.login || ""),
          password: String(cleanCreds.password || ""),
        });
      },
      hostObj,
      { defineAs: "autofillTab" }
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
      () =>
        this.#sendAsyncToContent(win, "SanctuaryHost:ClearHistory", {}),
      hostObj,
      { defineAs: "clearHistory" }
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

  #isAutofillableWebWindow(win) {
    if (!win || win !== win.top) {
      return false;
    }
    try {
      const parsed = new URL(String(win.location?.href || ""));
      const proto = parsed.protocol.toLowerCase();
      const host = parsed.hostname.toLowerCase();
      if (!host || host === "lm-sanctuary.local" || host.endsWith(".lm-sanctuary.local")) {
        return false;
      }
      return proto === "https:" || (proto === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(host));
    } catch {
      return false;
    }
  }

  #setNativeInputValue(win, inputEl, nextValue) {
    if (!win || !inputEl) {
      return false;
    }
    const target = Cu.waiveXrays(inputEl);
    const val = String(nextValue ?? "");
    try {
      const proto = win.HTMLInputElement?.prototype;
      const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
      if (desc && typeof desc.set === "function") {
        desc.set.call(target, val);
      } else {
        target.value = val;
      }
      target.dispatchEvent(new win.Event("input", { bubbles: true }));
      target.dispatchEvent(new win.Event("change", { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  }

  #isEditableInputVisible(win, el) {
    if (!el || el.disabled || el.readOnly) {
      return false;
    }
    const style = win.getComputedStyle?.(el);
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) {
      return false;
    }
    const rect = el.getBoundingClientRect?.();
    return Boolean(rect && rect.width >= 80 && rect.height >= 20);
  }

  #looksLikeUsernameInput(el) {
    const type = String(el?.getAttribute?.("type") || el?.type || "text").toLowerCase();
    if (type === "email") {
      return true;
    }
    if (!["text", "tel", ""].includes(type)) {
      return false;
    }
    const ac = String(el?.getAttribute?.("autocomplete") || "").toLowerCase();
    if (ac.includes("username") || ac === "email") {
      return true;
    }
    const hint = [
      el?.getAttribute?.("name"),
      el?.id,
      el?.getAttribute?.("placeholder"),
      el?.getAttribute?.("aria-label"),
    ]
      .map(s => String(s || "").toLowerCase())
      .join(" ");
    if (hint.includes("search")) {
      return false;
    }
    return (
      hint.includes("username") ||
      hint.includes("user_name") ||
      hint.includes("email") ||
      hint.includes("login") ||
      hint.includes("identifier") ||
      hint.includes("handle")
    );
  }

  #collectCredentialTargets(win, knownPasswordInputs) {
    const doc = win?.document;
    if (!doc) {
      return { fields: [], pairs: new Map() };
    }
    const allInputs = Array.from(doc.querySelectorAll("input"));
    const visibleTextLikes = [];
    const targets = new Set();
    const pairs = new Map();

    for (let i = 0; i < allInputs.length; i += 1) {
      const el = allInputs[i];
      const rawType = String(el.getAttribute("type") || el.type || "text").toLowerCase();
      if (rawType === "password") {
        knownPasswordInputs.add(el);
      }
      const isPassword = rawType === "password" || knownPasswordInputs.has(el);
      if (!this.#isEditableInputVisible(win, el)) {
        continue;
      }
      if (isPassword) {
        targets.add(el);
        let userInput = null;
        for (let j = visibleTextLikes.length - 1; j >= 0 && j >= visibleTextLikes.length - 3; j -= 1) {
          const cand = visibleTextLikes[j];
          if (cand.form && el.form && cand.form !== el.form) {
            continue;
          }
          userInput = cand;
          break;
        }
        if (userInput) {
          targets.add(userInput);
          pairs.set(userInput, { userInput, passInput: el });
          pairs.set(el, { userInput, passInput: el });
        } else {
          pairs.set(el, { userInput: null, passInput: el });
        }
      } else if (["text", "email", "tel", ""].includes(rawType)) {
        visibleTextLikes.push(el);
        if (this.#looksLikeUsernameInput(el)) {
          targets.add(el);
          if (!pairs.has(el)) {
            pairs.set(el, { userInput: el, passInput: null });
          }
        }
      }
    }
    return { fields: Array.from(targets), pairs };
  }

  #fillPageCredentials(win, { login = "", password = "" } = {}, anchorInput = null, knownPasswordInputs = new WeakSet()) {
    if (!win?.document) {
      return { ok: false, filledCount: 0 };
    }
    const { fields, pairs } = this.#collectCredentialTargets(win, knownPasswordInputs);
    let pair = anchorInput ? pairs.get(anchorInput) : null;
    if (!pair && fields.length > 0) {
      const withPassword = fields.find(f => pairs.get(f)?.passInput);
      pair = pairs.get(withPassword || fields[0]) || null;
    }
    if (!pair) {
      return { ok: false, filledCount: 0 };
    }
    let filledCount = 0;
    if (pair.userInput && login) {
      if (this.#setNativeInputValue(win, pair.userInput, login)) {
        filledCount += 1;
      }
    }
    if (pair.passInput && password) {
      if (this.#setNativeInputValue(win, pair.passInput, password)) {
        filledCount += 1;
      }
    }
    return { ok: filledCount > 0, filledCount };
  }

  #mountWebLoginAutofill(win) {
    this.#autofillCleanup?.();
    const doc = win?.document;
    if (!doc) {
      return;
    }
    const knownPasswordInputs = new WeakSet();
    let shadowRoot = null;
    let hostLayer = null;
    let buttonsWrap = null;
    let menuEl = null;
    let noticeTimer = null;
    let rafId = 0;
    let observer = null;
    let activeFields = [];
    let activePairs = new Map();
    const btnToInput = new WeakMap();

    const ensureLayer = () => {
      if (shadowRoot && hostLayer?.isConnected) {
        return true;
      }
      const rootParent = doc.documentElement || doc.body;
      if (!rootParent) {
        return false;
      }
      hostLayer = doc.createElement("div");
      hostLayer.setAttribute("data-sanctuary-kxc-layer", "1");
      hostLayer.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483646;margin:0;padding:0;border:0;";
      shadowRoot = hostLayer.attachShadow({ mode: "closed" });

      const styleEl = doc.createElement("style");
      styleEl.textContent = `
        :host { all: initial; }
        .kxc-btn {
          position: fixed;
          width: 24px;
          height: 24px;
          padding: 0;
          border-radius: 7px;
          border: 1px solid rgba(167, 139, 250, 0.45);
          background: #1c1926;
          color: #ddd6fe;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          pointer-events: auto;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
          transition: background 120ms ease, border-color 120ms ease, transform 120ms ease;
        }
        .kxc-btn:hover {
          background: #2b2440;
          border-color: #a78bfa;
          color: #ffffff;
        }
        .kxc-btn.is-filled {
          background: #173628;
          border-color: #34d399;
          color: #6ee7b7;
        }
        .kxc-menu {
          position: fixed;
          min-width: 220px;
          max-width: 300px;
          padding: 6px;
          border-radius: 10px;
          border: 1px solid rgba(167, 139, 250, 0.35);
          background: #18171f;
          color: #f4f4f5;
          font: 500 13px/1.35 system-ui, -apple-system, sans-serif;
          box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
          pointer-events: auto;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .kxc-menu[hidden] { display: none; }
        .kxc-menu-hdr {
          font-size: 11px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: #a1a1aa;
          padding: 2px 8px 4px;
        }
        .kxc-menu-item {
          all: unset;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          padding: 7px 9px;
          border-radius: 7px;
          cursor: pointer;
          color: #f4f4f5;
        }
        .kxc-menu-item:hover {
          background: rgba(167, 139, 250, 0.2);
        }
        .kxc-menu-name {
          font-size: 12px;
          color: #a1a1aa;
        }
        .kxc-notice {
          padding: 6px 9px;
          font-size: 12px;
          color: #e4e4e7;
        }
      `;
      buttonsWrap = doc.createElement("div");
      menuEl = doc.createElement("div");
      menuEl.className = "kxc-menu";
      menuEl.hidden = true;
      shadowRoot.append(styleEl, buttonsWrap, menuEl);
      rootParent.appendChild(hostLayer);
      return true;
    };

    const closeMenu = () => {
      if (noticeTimer !== null) {
        win.clearTimeout(noticeTimer);
        noticeTimer = null;
      }
      if (menuEl) {
        menuEl.hidden = true;
        menuEl.replaceChildren();
      }
    };

    const positionMenuNear = inputEl => {
      if (!menuEl || !inputEl) return;
      const rect = inputEl.getBoundingClientRect();
      const top = Math.min(win.innerHeight - 140, Math.max(8, rect.bottom + 6));
      const left = Math.min(win.innerWidth - 260, Math.max(8, rect.left));
      menuEl.style.top = `${Math.round(top)}px`;
      menuEl.style.left = `${Math.round(left)}px`;
      menuEl.hidden = false;
    };

    const showNotice = (inputEl, text) => {
      if (!ensureLayer()) return;
      closeMenu();
      const msg = doc.createElement("div");
      msg.className = "kxc-notice";
      msg.textContent = String(text || "");
      menuEl.appendChild(msg);
      positionMenuNear(inputEl);
      noticeTimer = win.setTimeout(closeMenu, 3500);
    };

    const showPicker = (inputEl, entries, btn) => {
      if (!ensureLayer()) return;
      closeMenu();
      const hdr = doc.createElement("div");
      hdr.className = "kxc-menu-hdr";
      hdr.textContent = "Sanctuary Vault (.kdbx)";
      menuEl.appendChild(hdr);
      for (const entry of entries) {
        const itemBtn = doc.createElement("button");
        itemBtn.type = "button";
        itemBtn.className = "kxc-menu-item";
        const loginSpan = doc.createElement("span");
        loginSpan.textContent = entry.login || entry.name || "(Unnamed)";
        itemBtn.appendChild(loginSpan);
        if (entry.name && entry.login && entry.name !== entry.login) {
          const nameSpan = doc.createElement("span");
          nameSpan.className = "kxc-menu-name";
          nameSpan.textContent = entry.name;
          itemBtn.appendChild(nameSpan);
        }
        itemBtn.addEventListener("click", ev => {
          if (!ev.isTrusted) return;
          ev.preventDefault();
          ev.stopPropagation();
          closeMenu();
          const res = this.#fillPageCredentials(win, entry, inputEl, knownPasswordInputs);
          if (res.ok && btn) {
            btn.classList.add("is-filled");
            win.setTimeout(() => btn.classList.remove("is-filled"), 1400);
          }
        });
        menuEl.appendChild(itemBtn);
      }
      positionMenuNear(inputEl);
    };

    const handleTriggerClick = async (ev, btn) => {
      if (!ev.isTrusted) return;
      ev.preventDefault();
      ev.stopPropagation();
      const inputEl = btnToInput.get(btn);
      if (!inputEl) return;
      closeMenu();
      try {
        const res = await this.sendQuery("SanctuaryHost:RequestPageLogins", {});
        if (this.contentWindow !== win) return;
        if (res?.openedModal) {
          return;
        }
        const entries = Array.isArray(res?.entries) ? res.entries : [];
        if (entries.length === 1) {
          const filled = this.#fillPageCredentials(win, entries[0], inputEl, knownPasswordInputs);
          if (filled.ok) {
            btn.classList.add("is-filled");
            win.setTimeout(() => btn.classList.remove("is-filled"), 1400);
          }
          return;
        }
        if (entries.length > 1) {
          showPicker(inputEl, entries, btn);
          return;
        }
        const hostLabel = String(win.location?.hostname || "this site");
        if (res?.ok && ensureLayer()) {
          closeMenu();
          const hdr = doc.createElement("div");
          hdr.className = "kxc-menu-hdr";
          hdr.textContent = "Sanctuary Vault (.kdbx)";
          const saveBtn = doc.createElement("button");
          saveBtn.type = "button";
          saveBtn.className = "kxc-menu-item";
          saveBtn.textContent = `Save login for ${hostLabel} in Vault…`;
          saveBtn.addEventListener("click", ev => {
            if (!ev.isTrusted) return;
            ev.preventDefault();
            ev.stopPropagation();
            closeMenu();
            void this.sendQuery("SanctuaryHost:OpenVaultForPage", {});
          });
          menuEl.append(hdr, saveBtn);
          positionMenuNear(inputEl);
          return;
        }
        showNotice(
          inputEl,
          res?.error || `No login saved for ${hostLabel}`
        );
      } catch (err) {
        showNotice(inputEl, String(err?.message || "KeePassXC unavailable"));
      }
    };

    const renderButtons = () => {
      rafId = 0;
      if (this.contentWindow !== win) return;
      const collected = this.#collectCredentialTargets(win, knownPasswordInputs);
      activeFields = collected.fields;
      activePairs = collected.pairs;
      if (!activeFields.length) {
        if (buttonsWrap) buttonsWrap.replaceChildren();
        closeMenu();
        return;
      }
      if (!ensureLayer()) return;
      buttonsWrap.replaceChildren();
      for (const inputEl of activeFields) {
        const rect = inputEl.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > win.innerHeight || rect.right < 0 || rect.left > win.innerWidth) {
          continue;
        }
        let rightOffset = 28;
        try {
          const probeX = rect.right - 14;
          const probeY = rect.top + rect.height / 2;
          const stack = doc.elementsFromPoint?.(probeX, probeY) || [];
          const hasNativeBtn = stack.some(
            n => n !== inputEl && n !== hostLayer && (n.tagName === "BUTTON" || n.getAttribute?.("role") === "button")
          );
          if (hasNativeBtn) {
            rightOffset = 58;
          }
        } catch {
          // Ignore elementsFromPoint failures on transient nodes
        }
        const btn = doc.createElement("button");
        btn.type = "button";
        btn.className = "kxc-btn";
        btn.title = "Autofill from Sanctuary Vault";
        btn.setAttribute("aria-label", "Autofill from Sanctuary Vault");
        btn.style.left = `${Math.round(Math.max(rect.left + 4, rect.right - rightOffset))}px`;
        btn.style.top = `${Math.round(rect.top + (rect.height - 24) / 2)}px`;
        btn.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/></svg>';
        btnToInput.set(btn, inputEl);
        btn.addEventListener("mousedown", ev => {
          if (ev.isTrusted) ev.preventDefault();
        });
        btn.addEventListener("click", ev => {
          void handleTriggerClick(ev, btn);
        });
        buttonsWrap.appendChild(btn);
      }
    };

    const scheduleRender = () => {
      if (rafId || this.contentWindow !== win) return;
      rafId = win.requestAnimationFrame(renderButtons);
    };

    const onOutsidePointer = ev => {
      if (!menuEl || menuEl.hidden) return;
      if (ev.target !== hostLayer) {
        closeMenu();
      }
    };

    const onEscape = ev => {
      if (ev.key === "Escape" && menuEl && !menuEl.hidden) {
        closeMenu();
      }
    };

    win.addEventListener("DOMContentLoaded", scheduleRender);
    win.addEventListener("load", scheduleRender);
    win.addEventListener("resize", scheduleRender);
    win.addEventListener("scroll", scheduleRender, true);
    doc.addEventListener("focusin", scheduleRender, true);
    doc.addEventListener("pointerdown", onOutsidePointer, true);
    doc.addEventListener("keydown", onEscape, true);

    if (typeof win.MutationObserver === "function") {
      observer = new win.MutationObserver(scheduleRender);
      const startObserve = () => {
        if (doc.documentElement) {
          observer.observe(doc.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["type", "style", "class", "hidden"],
          });
        }
      };
      if (doc.documentElement) {
        startObserve();
      } else {
        win.addEventListener("DOMContentLoaded", startObserve, { once: true });
      }
    }

    scheduleRender();
    this.#autofillCleanup = () => {
      if (rafId) {
        win.cancelAnimationFrame?.(rafId);
        rafId = 0;
      }
      closeMenu();
      observer?.disconnect();
      win.removeEventListener("DOMContentLoaded", scheduleRender);
      win.removeEventListener("load", scheduleRender);
      win.removeEventListener("resize", scheduleRender);
      win.removeEventListener("scroll", scheduleRender, true);
      doc.removeEventListener("focusin", scheduleRender, true);
      doc.removeEventListener("pointerdown", onOutsidePointer, true);
      doc.removeEventListener("keydown", onEscape, true);
      hostLayer?.remove();
    };
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
    if (message?.name === "SanctuaryHost:FillCredentials") {
      return this.#fillPageCredentials(this.contentWindow, message.data || {});
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
    this.#autofillCleanup?.();
    this.#autofillCleanup = null;
    this.#listeners.clear();
  }
}
