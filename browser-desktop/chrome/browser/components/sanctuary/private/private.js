/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store */
"use strict";

const ENGINES = [
  { id: "duckduckgo", label: "DuckDuckGo", aliases: ["ddg", "duckduckgo"], template: "https://duckduckgo.com/?q=%s" },
  { id: "ecosia", label: "Ecosia", aliases: ["eco", "ecosia"], template: "https://www.ecosia.org/search?q=%s" },
  { id: "startpage", label: "Startpage", aliases: ["sp", "startpage"], template: "https://www.startpage.com/sp/search?query=%s" },
  { id: "brave", label: "Brave", aliases: ["br", "brave"], template: "https://search.brave.com/search?q=%s" },
  { id: "kagi", label: "Kagi", aliases: ["kagi"], template: "https://kagi.com/search?q=%s" },
  { id: "qwant", label: "Qwant", aliases: ["qw", "qwant"], template: "https://www.qwant.com/?q=%s" },
  { id: "wikipedia", label: "Wikipedia", aliases: ["w", "wikipedia"], template: "https://en.wikipedia.org/wiki/Special:Search?search=%s" },
];

const SITE_PREFIXES = {
  github: "https://github.com/search?q=%s",
  gh: "https://github.com/search?q=%s",
  arxiv: "https://arxiv.org/search/?query=%s&searchtype=all",
  hn: "https://hn.algolia.com/?q=%s",
  wikipedia: "https://en.wikipedia.org/w/index.php?search=%s",
  yt: "https://www.youtube.com/results?search_query=%s",
  youtube: "https://www.youtube.com/results?search_query=%s",
  maps: "https://www.openstreetmap.org/search?query=%s",
};

const TRACKING_EXACT = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid",
  "mc_cid", "mc_eid", "igsh", "igshid", "si", "_hsenc", "_hsmi",
]);

let searchConfig = { engine: "", searxngUrl: "", customTemplate: "" };
let nativeBridgeActive = false;

const form = document.querySelector(".private-search-form");
const input = document.getElementById("private-query-input");
const feedback = document.getElementById("search-feedback");
const engineStatus = document.getElementById("engine-status");
const enginePills = document.getElementById("engine-pills");

function stripTrackers(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return rawUrl;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      const low = key.toLowerCase();
      if (TRACKING_EXACT.has(low) || low.startsWith("utm_") || low.startsWith("pk_")) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

function looksLikeHost(text) {
  if (!text || /\s/.test(text)) return false;
  if (/^https?:\/\//i.test(text)) return true;
  if (/^localhost(?::\d+)?(?:[/?#].*)?$/i.test(text)) return true;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d+)?(?:[/?#].*)?$/i.test(text);
}

function resolveTarget(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return { kind: "empty" };

  const atMatch = /^@([a-z0-9_-]+)\s+(.+)$/i.exec(trimmed);
  if (atMatch) {
    const alias = atMatch[1].toLowerCase();
    const query = atMatch[2].trim();
    const eng = ENGINES.find(item => item.aliases.includes(alias));
    if (eng) {
      return { kind: "url", url: eng.template.replace("%s", encodeURIComponent(query)) };
    }
    if (SITE_PREFIXES[alias]) {
      return { kind: "url", url: SITE_PREFIXES[alias].replace("%s", encodeURIComponent(query)) };
    }
  }

  const colonMatch = /^(github|arxiv|hn|wikipedia):\s*(.+)$/i.exec(trimmed);
  if (colonMatch) {
    const tmpl = SITE_PREFIXES[colonMatch[1].toLowerCase()];
    if (tmpl) {
      return { kind: "url", url: tmpl.replace("%s", encodeURIComponent(colonMatch[2].trim())) };
    }
  }

  if (looksLikeHost(trimmed)) {
    const candidate = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `${/^(?:localhost|127\.|10\.|192\.168\.)/i.test(trimmed) ? "http://" : "https://"}${trimmed}`;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return { kind: "url", url: stripTrackers(parsed.toString()) };
      }
    } catch {
      // Fall through to search
    }
  }

  const encoded = encodeURIComponent(trimmed);
  if (searchConfig.engine === "searxng" && /^https?:\/\/\S+$/i.test(searchConfig.searxngUrl || "")) {
    return { kind: "url", url: `${searchConfig.searxngUrl.replace(/\/+$/, "")}/search?q=${encoded}` };
  }
  if (searchConfig.engine === "custom" && /^https?:\/\/\S+$/i.test(searchConfig.customTemplate || "") && searchConfig.customTemplate.includes("%s")) {
    return { kind: "url", url: searchConfig.customTemplate.replaceAll("%s", encoded) };
  }
  const activeEngine = ENGINES.find(e => e.id === searchConfig.engine);
  if (activeEngine) {
    return { kind: "url", url: activeEngine.template.replace("%s", encoded) };
  }
  return { kind: "needs_engine" };
}

function renderEnginePills() {
  enginePills.replaceChildren();
  const active = ENGINES.find(e => e.id === searchConfig.engine);
  if (active) {
    engineStatus.textContent = `Active Search Engine: ${active.label}`;
  } else if (searchConfig.engine === "searxng" && searchConfig.searxngUrl) {
    engineStatus.textContent = "Active Search Engine: SearXNG";
  } else if (searchConfig.engine === "custom" && searchConfig.customTemplate) {
    engineStatus.textContent = "Active Search Engine: Custom";
  } else {
    engineStatus.textContent = "Select a private search engine or use @eco / @ddg / @gh";
  }

  for (const eng of ENGINES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "engine-pill";
    btn.textContent = eng.label;
    btn.setAttribute("aria-pressed", searchConfig.engine === eng.id ? "true" : "false");
    btn.addEventListener("click", () => {
      searchConfig = { ...searchConfig, engine: eng.id };
      feedback.hidden = true;
      renderEnginePills();
      input.focus();
    });
    enginePills.appendChild(btn);
  }
}

function navigateTo(url) {
  if (nativeBridgeActive) {
    window.dispatchEvent(new CustomEvent("SanctuaryPrivate:Navigate", { detail: { url } }));
    return;
  }
  window.location.assign(url);
}

const suggestBox = document.createElement("div");
suggestBox.className = "private-suggest-dropdown";
suggestBox.setAttribute("role", "listbox");
suggestBox.hidden = true;
form.appendChild(suggestBox);

const PREFIX_HINTS = [
  ...ENGINES.map(e => ({ prefix: `@${e.aliases[0]}`, label: `@${e.aliases[0]} — ${e.label}`, desc: `Search privately on ${e.label}` })),
  { prefix: "@gh", label: "@gh — GitHub", desc: "Search GitHub repositories" },
  { prefix: "github:", label: "github: — GitHub", desc: "Search GitHub repositories" },
  { prefix: "arxiv:", label: "arxiv: — arXiv", desc: "Search arXiv papers" },
  { prefix: "hn:", label: "hn: — Hacker News", desc: "Search Hacker News" },
  { prefix: "wikipedia:", label: "wikipedia: — Wikipedia", desc: "Search Wikipedia" },
];

let activeSuggestIdx = -1;
let suggestItems = [];

function closeSuggest() {
  suggestItems = [];
  activeSuggestIdx = -1;
  suggestBox.hidden = true;
  suggestBox.replaceChildren();
}

function syncSuggestActive() {
  const rows = suggestBox.querySelectorAll(".private-suggest-item");
  rows.forEach((r, idx) => r.classList.toggle("is-active", idx === activeSuggestIdx));
}

function applySuggest(item) {
  input.value = `${item.prefix} `;
  closeSuggest();
  input.focus();
}

input.addEventListener("input", () => {
  const q = String(input.value || "").trim().toLowerCase();
  if (!q || /\s/.test(q)) {
    closeSuggest();
    return;
  }
  suggestItems = PREFIX_HINTS.filter(
    h => h.prefix.toLowerCase().startsWith(q) || h.label.toLowerCase().includes(q)
  ).slice(0, 6);
  activeSuggestIdx = -1;
  suggestBox.replaceChildren();
  if (suggestItems.length === 0) {
    suggestBox.hidden = true;
    return;
  }
  for (const item of suggestItems) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "private-suggest-item";
    btn.setAttribute("role", "option");
    const lbl = document.createElement("span");
    lbl.className = "private-suggest-label";
    lbl.textContent = item.label;
    const sub = document.createElement("span");
    sub.className = "private-suggest-sub";
    sub.textContent = item.desc;
    btn.append(lbl, sub);
    btn.addEventListener("mousedown", ev => {
      ev.preventDefault();
      applySuggest(item);
    });
    suggestBox.appendChild(btn);
  }
  suggestBox.hidden = false;
});

input.addEventListener("keydown", ev => {
  if (suggestBox.hidden || suggestItems.length === 0) return;
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    activeSuggestIdx = (activeSuggestIdx + 1) % suggestItems.length;
    syncSuggestActive();
  } else if (ev.key === "ArrowUp") {
    ev.preventDefault();
    activeSuggestIdx = activeSuggestIdx <= 0 ? suggestItems.length - 1 : activeSuggestIdx - 1;
    syncSuggestActive();
  } else if (ev.key === "Enter" && activeSuggestIdx >= 0 && suggestItems[activeSuggestIdx]) {
    ev.preventDefault();
    applySuggest(suggestItems[activeSuggestIdx]);
  } else if (ev.key === "Escape") {
    ev.preventDefault();
    closeSuggest();
  }
});

input.addEventListener("blur", closeSuggest);

form.addEventListener("submit", event => {
  event.preventDefault();
  closeSuggest();
  feedback.hidden = true;
  const result = resolveTarget(input.value);
  if (result.kind === "url") {
    navigateTo(result.url);
    return;
  }
  if (result.kind === "needs_engine") {
    feedback.textContent = "Select a search engine below, or prefix your query with @eco, @ddg, or @gh.";
    feedback.hidden = false;
  }
});

window.addEventListener("SanctuaryPrivate:SearchConfig", event => {
  nativeBridgeActive = true;
  const cfg = event?.detail;
  if (cfg && typeof cfg === "object") {
    searchConfig = {
      engine: String(cfg.engine || ""),
      searxngUrl: String(cfg.searxngUrl || ""),
      customTemplate: String(cfg.customTemplate || ""),
    };
    renderEnginePills();
  }
});

renderEnginePills();
window.dispatchEvent(new CustomEvent("SanctuaryPrivate:Ready"));
