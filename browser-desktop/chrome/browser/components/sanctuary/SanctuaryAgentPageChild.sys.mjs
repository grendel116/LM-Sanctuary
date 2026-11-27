/* SPDX-License-Identifier: AGPL-3.0-or-later */

const REF_ATTR = "data-sanctuary-ref";
const MAX_SNAPSHOT_CHARS = 24000;

function isElementVisible(win, el) {
  if (!el || el.nodeType !== 1) {
    return false;
  }
  if (el.hidden || el.getAttribute("aria-hidden") === "true") {
    return false;
  }
  try {
    const style = win.getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  } catch {
    return true;
  }
}

function isInViewport(win, el) {
  try {
    const rect = el.getBoundingClientRect();
    const vw = win.innerWidth || win.document?.documentElement?.clientWidth || 1280;
    const vh = win.innerHeight || win.document?.documentElement?.clientHeight || 800;
    return rect.bottom >= 0 && rect.right >= 0 && rect.top <= vh && rect.left <= vw;
  } catch {
    return true;
  }
}

function inferRole(el) {
  const explicit = String(el.getAttribute("role") || "").trim().toLowerCase();
  if (explicit) {
    return explicit;
  }
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "a" && el.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "input") {
    const type = String(el.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }
  return "";
}

function elementLabel(el) {
  const aria = String(el.getAttribute("aria-label") || "").trim();
  if (aria) return aria;
  const placeholder = String(el.getAttribute("placeholder") || "").trim();
  if (placeholder) return placeholder;
  const title = String(el.getAttribute("title") || "").trim();
  if (title) return title;
  const alt = String(el.getAttribute("alt") || "").trim();
  if (alt) return alt;
  const text = String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 140);
  const val = typeof el.value === "string" ? el.value.trim() : "";
  return val.slice(0, 140);
}

/**
 * Content-process JSWindowActor for Sanctuary Browser agent page inspection and interaction.
 */
export class SanctuaryAgentPageChild extends JSWindowActorChild {
  #findRefElement(doc, ref) {
    const cleanRef = String(ref || "").trim().replace(/^\[|\]$/g, "");
    if (!cleanRef || !doc) {
      return null;
    }
    return doc.querySelector(`[${REF_ATTR}="${cleanRef.replace(/"/g, '\\"')}"]`);
  }

  #detectChallenge(doc) {
    if (!doc) {
      return { frames: [], markers: { turnstile: false, recaptcha: false, hcaptcha: false } };
    }
    const frames = [];
    for (const frame of doc.querySelectorAll("iframe")) {
      const src = String(frame.getAttribute("src") || "").toLowerCase();
      if (
        src.includes("challenges.cloudflare.com") ||
        src.includes("turnstile") ||
        src.includes("google.com/recaptcha") ||
        src.includes("recaptcha.net") ||
        src.includes("hcaptcha.com")
      ) {
        frames.push(src);
      }
    }
    const turnstile = Boolean(
      doc.querySelector(".cf-turnstile, [data-sitekey][class*='turnstile'], #challenge-running, #cf-challenge-running")
    );
    const recaptcha = Boolean(doc.querySelector(".g-recaptcha, [data-sitekey][class*='recaptcha']"));
    const hcaptcha = Boolean(doc.querySelector(".h-captcha, [data-sitekey][class*='hcaptcha']"));
    return {
      frames,
      markers: { turnstile, recaptcha, hcaptcha },
    };
  }

  #buildSnapshot(win, doc, opts = {}) {
    if (!doc || !doc.body) {
      return { text: "", refs: 0, truncated: false };
    }
    const root = opts.ref ? this.#findRefElement(doc, opts.ref) || doc.body : doc.body;
    const viewportOnly = Boolean(opts.viewportOnly);
    const candidates = root.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, a[href], button, input, select, textarea, [role='button'], [role='link'], [role='textbox'], [role='checkbox'], [role='tab'], [role='menuitem']"
    );
    const lines = [];
    let refCounter = 0;
    for (const el of candidates) {
      if (!isElementVisible(win, el)) {
        continue;
      }
      if (viewportOnly && !isInViewport(win, el)) {
        continue;
      }
      const role = inferRole(el);
      if (!role) {
        continue;
      }
      const label = elementLabel(el);
      if (!label && role === "heading") {
        continue;
      }
      refCounter += 1;
      const refId = `e${refCounter}`;
      el.setAttribute(REF_ATTR, refId);
      const safeLabel = label.replace(/"/g, "'");
      lines.push(`${role} "${safeLabel}" [${refId}]`);
    }
    const full = lines.join("\n");
    const truncated = full.length > MAX_SNAPSHOT_CHARS;
    return {
      text: truncated ? full.slice(0, MAX_SNAPSHOT_CHARS) : full,
      refs: refCounter,
      truncated,
    };
  }

  #extractText(doc, opts = {}) {
    if (!doc || !doc.body) {
      return { text: "", total: 0, nextOffset: null };
    }
    const root = opts.ref ? this.#findRefElement(doc, opts.ref) || doc.body : doc.body;
    const raw = String(root.innerText || root.textContent || "").trim();
    const total = raw.length;
    const offset = Math.max(0, Number(opts.offset || 0));
    const chunk = Math.max(1, Number(opts.chunk || 20000));
    const slice = raw.slice(offset, offset + chunk);
    const nextOffset = offset + chunk < total ? offset + chunk : null;
    return { text: slice, total, nextOffset };
  }

  #clickRef(win, doc, opts = {}) {
    const el = this.#findRefElement(doc, opts.ref);
    if (!el) {
      throw Object.assign(new Error(`Element ref not found: ${opts.ref}`), { code: "ref_not_found" });
    }
    el.scrollIntoView?.({ block: "center", inline: "center" });
    el.focus?.();
    if (typeof el.click === "function") {
      el.click();
    } else {
      el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
    }
    return { ref: String(opts.ref || "") };
  }

  #typeRef(win, doc, opts = {}) {
    const el = this.#findRefElement(doc, opts.ref);
    if (!el) {
      throw Object.assign(new Error(`Element ref not found: ${opts.ref}`), { code: "ref_not_found" });
    }
    el.scrollIntoView?.({ block: "center", inline: "center" });
    el.focus?.();
    const nextText = String(opts.text ?? "");
    const shouldClear = opts.clear !== false;
    if ("value" in el) {
      el.value = shouldClear ? nextText : String(el.value || "") + nextText;
    } else if (el.isContentEditable) {
      el.textContent = shouldClear ? nextText : String(el.textContent || "") + nextText;
    }
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    return { value: String("value" in el ? el.value : el.textContent || "") };
  }

  #selectRef(win, doc, opts = {}) {
    const el = this.#findRefElement(doc, opts.ref);
    if (!el) {
      throw Object.assign(new Error(`Element ref not found: ${opts.ref}`), { code: "ref_not_found" });
    }
    const values = Array.isArray(opts.values) ? opts.values.map(v => String(v)) : [];
    if (el.options) {
      for (const opt of el.options) {
        const match = values.includes(String(opt.value)) || values.includes(String(opt.text).trim());
        opt.selected = match;
      }
    } else if ("value" in el && values.length > 0) {
      el.value = values[0];
    }
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    return { values };
  }

  #pressKeys(win, doc, opts = {}) {
    const keys = Array.isArray(opts.keys) ? opts.keys.map(k => String(k)) : ["Enter"];
    const target = doc?.activeElement || doc?.body || win;
    for (const key of keys) {
      target.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      target.dispatchEvent(new win.KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
      if (key === "Enter" && target?.form && typeof target.form.requestSubmit === "function") {
        target.form.requestSubmit();
      }
    }
    return { keys };
  }

  #scrollPage(win, doc, opts = {}) {
    if (opts.ref) {
      const el = this.#findRefElement(doc, opts.ref);
      el?.scrollIntoView?.({ behavior: "instant", block: "center" });
      return { ok: true };
    }
    const dir = String(opts.direction || "down").toLowerCase();
    const amount = Number(opts.amount ?? 3) * 240;
    const dx = dir === "left" ? -amount : dir === "right" ? amount : 0;
    const dy = dir === "up" ? -amount : dir === "down" ? amount : 0;
    win.scrollBy?.(dx, dy);
    return { ok: true };
  }

  async #waitForText(win, doc, opts = {}) {
    const needle = String(opts.text || "").trim().toLowerCase();
    const timeoutMs = Math.min(15000, Math.max(100, Number(opts.timeoutMs || 5000)));
    if (!needle || !doc) {
      return { found: false };
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const bodyText = String(doc.body?.innerText || doc.body?.textContent || "").toLowerCase();
      if (bodyText.includes(needle)) {
        return { found: true };
      }
      await new Promise(resolve => win.setTimeout(resolve, 100));
    }
    return { found: false };
  }

  async receiveMessage(message) {
    const win = this.contentWindow;
    const doc = this.document || win?.document;
    const data = message?.data || {};
    switch (message?.name) {
      case "SanctuaryAgentPage:Challenge":
        return this.#detectChallenge(doc);
      case "SanctuaryAgentPage:Snapshot":
        return this.#buildSnapshot(win, doc, data);
      case "SanctuaryAgentPage:Text":
        return this.#extractText(doc, data);
      case "SanctuaryAgentPage:Click":
        return this.#clickRef(win, doc, data);
      case "SanctuaryAgentPage:Type":
        return this.#typeRef(win, doc, data);
      case "SanctuaryAgentPage:Select":
        return this.#selectRef(win, doc, data);
      case "SanctuaryAgentPage:Press":
        return this.#pressKeys(win, doc, data);
      case "SanctuaryAgentPage:Scroll":
        return this.#scrollPage(win, doc, data);
      case "SanctuaryAgentPage:WaitForText":
        return this.#waitForText(win, doc, data);
      default:
        return null;
    }
  }
}
