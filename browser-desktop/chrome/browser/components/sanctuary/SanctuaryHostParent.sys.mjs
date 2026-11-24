/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store */

import { SanctuaryWindowHost } from "moz-src:///browser/components/sanctuary/SanctuaryWindowHost.sys.mjs";

const KEEPASSXC_EXTENSION_ID = "keepassxc-browser@keepassxc.org";

/**
 * Parent actor bridging LM-Sanctuary's trusted shell window to native Gecko tabs & Sval protections.
 */
export class SanctuaryHostParent extends JSWindowActorParent {
  #topChromeWindow() {
    return this.browsingContext?.topChromeWindow ?? null;
  }

  #applyPrivacyPrefs(privacy = {}) {
    const level = ["off", "balanced", "strict"].includes(privacy.shieldLevel)
      ? privacy.shieldLevel
      : "balanced";
    Services.prefs.setStringPref("browser.sval.adblock.level", level);
    Services.prefs.setBoolPref("privacy.globalprivacycontrol.enabled", privacy.sendGpc !== false);

    const overrides = privacy.siteOverrides && typeof privacy.siteOverrides === "object"
      ? privacy.siteOverrides
      : {};
    const siteBranch = "browser.sval.javascript.site.";
    const activeHosts = new Map();
    for (const [host, rule] of Object.entries(overrides)) {
      const cleanHost = String(host || "").trim().toLowerCase();
      if (!cleanHost || typeof rule?.jsEnabled !== "boolean") {
        continue;
      }
      activeHosts.set(cleanHost, rule.jsEnabled);
    }

    if (typeof Services.prefs.getChildList === "function") {
      try {
        for (const prefName of Services.prefs.getChildList(siteBranch)) {
          const site = prefName.slice(siteBranch.length);
          if (site && !activeHosts.has(site.toLowerCase())) {
            Services.prefs.clearUserPref(prefName);
          }
        }
      } catch {
        // Ignore clear failures on locked or test prefs
      }
    }

    for (const [cleanHost, jsEnabled] of activeHosts.entries()) {
      try {
        Services.prefs.setStringPref(siteBranch + cleanHost, jsEnabled ? "allow" : "block");
      } catch {
        // Ignore Sval JS policy pref failures
      }
      try {
        const uri = Services.io.newURI(`https://${cleanHost}/`);
        const perm = jsEnabled
          ? Services.perms.ALLOW_ACTION
          : Services.perms.DENY_ACTION;
        Services.perms.addFromPrincipal(
          Services.scriptSecurityManager.createContentPrincipal(uri, {}),
          "script",
          perm
        );
      } catch {
        // Skip invalid host override
      }
    }
  }

  async #isKeePassInstalled() {
    return true;
  }

  async #connectKeePassXC() {
    const win = this.#topChromeWindow();
    const rawSpec = String(
      this.browsingContext?.top?.currentWindowGlobal?.documentURI?.spec || ""
    ).trim();
    SanctuaryWindowHost.notifyShellEvent(win, {
      type: "vault-open-requested",
      url: rawSpec,
    });
    return true;
  }

  #saveSearchConfig(searchConfig) {
    if (!searchConfig || typeof searchConfig !== "object") {
      return;
    }
    try {
      Services.prefs.setStringPref(
        "browser.sanctuary.searchConfig",
        JSON.stringify({
          engine: String(searchConfig.engine || ""),
          searxngUrl: String(searchConfig.searxngUrl || ""),
          customTemplate: String(searchConfig.customTemplate || ""),
        })
      );
    } catch {
      // Ignore searchConfig pref serialization failures
    }
  }

  #getSearchConfig() {
    try {
      const raw = Services.prefs.getStringPref("browser.sanctuary.searchConfig", "");
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  #loadPrivateUrl(rawUrl) {
    const clean = String(rawUrl || "").trim();
    if (!/^https?:\/\//i.test(clean)) {
      return;
    }
    const browser = this.browsingContext?.top?.embedderElement;
    if (!browser) {
      return;
    }
    try {
      browser.loadURI(Services.io.newURI(clean), {
        triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal(
          browser.browsingContext?.originAttributes || {}
        ),
      });
    } catch {
      // Ignore invalid private navigation URI
    }
  }

  #getShellApiOrigin() {
    try {
      const configured = Services.prefs.getStringPref(
        "browser.sanctuary.shellUrl",
        "http://127.0.0.1:5000"
      );
      return new URL(configured).origin;
    } catch {
      return "http://127.0.0.1:5000";
    }
  }

  async #requestPageLogins() {
    const rawSpec = String(
      this.browsingContext?.top?.currentWindowGlobal?.documentURI?.spec ||
        this.browsingContext?.currentWindowGlobal?.documentURI?.spec ||
        ""
    ).trim();
    let parsedUrl = null;
    try {
      parsedUrl = new URL(rawSpec);
    } catch {
      return { ok: false, entries: [], error: "Unsupported page URL." };
    }
    const proto = parsedUrl.protocol.toLowerCase();
    const host = parsedUrl.hostname.toLowerCase();
    const isLocalHttp = proto === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(host);
    if (
      !host ||
      host === "lm-sanctuary.local" ||
      host.endsWith(".lm-sanctuary.local") ||
      (proto !== "https:" && !isLocalHttp)
    ) {
      return { ok: false, entries: [], error: "KeePassXC autofill requires an HTTPS site." };
    }

    const origin = this.#getShellApiOrigin();
    const queryLogins = async () => {
      const resp = await fetch(`${origin}/api/keepassxc/logins`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rawSpec }),
      });
      let data = {};
      try {
        data = await resp.json();
      } catch {
        data = {};
      }
      return { resp, data };
    };

    try {
      const { resp, data } = await queryLogins();
      if (resp.status === 503 || resp.status === 409) {
        const win = this.#topChromeWindow();
        SanctuaryWindowHost.notifyShellEvent(win, {
          type: "vault-unlock-requested",
          url: rawSpec,
        });
        return {
          ok: false,
          entries: [],
          locked: Boolean(data?.locked),
          openedModal: true,
          error: String(data?.error || ""),
        };
      }
      return {
        ok: resp.ok,
        entries: Array.isArray(data?.entries) ? data.entries : [],
        locked: Boolean(data?.locked),
        error: String(data?.error || ""),
      };
    } catch (err) {
      return {
        ok: false,
        entries: [],
        locked: false,
        error: String(err?.message || "Unable to reach Sanctuary Vault service."),
      };
    }
  }

  #openVaultForPage() {
    const win = this.#topChromeWindow();
    const rawSpec = String(
      this.browsingContext?.top?.currentWindowGlobal?.documentURI?.spec ||
        this.browsingContext?.currentWindowGlobal?.documentURI?.spec ||
        ""
    ).trim();
    SanctuaryWindowHost.notifyShellEvent(win, {
      type: "vault-open-requested",
      url: rawSpec,
    });
    return { ok: true };
  }

  async receiveMessage(message) {
    const data = message?.data || {};
    const win = this.#topChromeWindow();

    switch (message?.name) {
      case "SanctuaryHost:ShellReset":
        SanctuaryWindowHost.mount(win);
        SanctuaryWindowHost.resetPanes(win, this);
        return null;
      case "SanctuaryHost:LoadTab":
        return SanctuaryWindowHost.loadTab(win, this, data);
      case "SanctuaryHost:CloseTab":
        SanctuaryWindowHost.closeTab(win, data.tabId);
        return null;
      case "SanctuaryHost:SyncLayout":
        SanctuaryWindowHost.syncLayout(win, this, data);
        return null;
      case "SanctuaryHost:ExtractTabContent":
        return SanctuaryWindowHost.extractTabContent(win, data);
      case "SanctuaryHost:CaptureTabPreview":
        return SanctuaryWindowHost.captureTabPreview(win, data);
      case "SanctuaryHost:AutofillTab":
        return SanctuaryWindowHost.autofillTab(win, data);
      case "SanctuaryHost:RequestPageLogins":
        return this.#requestPageLogins();
      case "SanctuaryHost:OpenVaultForPage":
        return this.#openVaultForPage();
      case "SanctuaryHost:ActOnTab":
        return SanctuaryWindowHost.actOnTab(win, data);
      case "SanctuaryHost:StepHistory":
        return SanctuaryWindowHost.stepHistory(win, data);
      case "SanctuaryHost:ClearHistory":
        return SanctuaryWindowHost.clearHistory(win);
      case "SanctuaryHost:SetPrivacy":
        this.#applyPrivacyPrefs(data.privacy || {});
        return null;
      case "SanctuaryHost:SetTheme":
        SanctuaryWindowHost.applyProgramTheme(win, data.tokens || {});
        return null;
      case "SanctuaryHost:SetSearchConfig":
        this.#saveSearchConfig(data.searchConfig);
        return null;
      case "SanctuaryHost:OpenPrivateWindow":
        if (data.searchConfig) {
          this.#saveSearchConfig(data.searchConfig);
        }
        return SanctuaryWindowHost.openPrivateWindow(win, { url: data.url });
      case "SanctuaryHost:GetPrivateSearchConfig":
        return this.#getSearchConfig();
      case "SanctuaryHost:LoadPrivateUrl":
        this.#loadPrivateUrl(data.url);
        return null;
      case "SanctuaryHost:IsKeePassConnected":
        return this.#isKeePassInstalled();
      case "SanctuaryHost:InstallOrOpenKeePassXC":
        return this.#connectKeePassXC();
      default:
        return null;
    }
  }
}
