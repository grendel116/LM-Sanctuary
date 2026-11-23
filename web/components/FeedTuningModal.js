import {
  isDefaultFeedTuning,
  normalizeFeedTuning,
} from '../core/feedRanker.js';
import { searchBskyFeedGenerators } from '../queries/bluesky.js';
import { fetchDynamicFediverseInstances, searchFediverse } from '../queries/fediverse.js';
import { getAuthenticatedAccount } from '../state/authStore.js';
import {
  clearLearnedTasteMemory,
  exportRankingManifest,
  feedStore,
  importRankingManifest,
  resetFeedBlankSlate,
  resetRankingManifest,
  updateFeedTuning,
} from '../state/feedStore.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';
import { attachSearchSuggestions } from './SearchSuggestions.js';
import { createClassicModalDialog } from './sanctuary/SanctuaryDialog.js';

const TUNE_MODAL_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--primary-accent)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"></line><circle cx="9" cy="6" r="2.2" fill="var(--bg-color, #121214)"></circle><line x1="4" y1="12" x2="20" y2="12"></line><circle cx="15" cy="12" r="2.2" fill="var(--bg-color, #121214)"></circle><line x1="4" y1="18" x2="20" y2="18"></line><circle cx="8" cy="18" r="2.2" fill="var(--bg-color, #121214)"></circle></svg>`;
const CHANNEL_LABELS_KV_KEY = 'sanctuary_feed_channel_labels_v1';
const DEFAULT_PUBLIC_MASTO_HOST = 'https://mastodon.world';
const channelLabelCache = new Map();

function formatChannelLabel(entry) {
  const raw = String(entry || '').trim();
  const cached = channelLabelCache.get(raw.toLowerCase());
  if (cached) return cached;
  if (raw.toLowerCase().startsWith('at://')) {
    const slug = raw.split('/').pop() || raw;
    return `Feed: ${slug}`;
  }
  return raw;
}

/**
 * Open the Communities & Feeds modal with a unified search-as-you-type dropdown.
 */
export function openFeedTuningModal() {
  const doc = globalThis.document;
  let closed = false;
  let lastLocalEditAt = 0;

  void kvGet(CHANNEL_LABELS_KV_KEY, null).then((saved) => {
    if (!saved || typeof saved !== 'object' || closed) return;
    for (const [k, v] of Object.entries(saved)) {
      if (typeof v === 'string' && v.trim()) {
        channelLabelCache.set(k.toLowerCase(), v.trim());
      }
    }
    lastChipSig = '';
    syncFromStore();
  }).catch(() => {});

  function rememberChannelLabel(uri, displayName, creatorHandle) {
    const key = String(uri || '').trim().toLowerCase();
    if (!key || !displayName) return;
    const label = creatorHandle ? `${displayName} (@${creatorHandle.replace(/^@/, '')})` : displayName;
    channelLabelCache.set(key, label);
    const snapshot = {};
    for (const [k, v] of channelLabelCache.entries()) snapshot[k] = v;
    void kvSet(CHANNEL_LABELS_KV_KEY, snapshot).catch(() => {});
  }

  function subscribeChannel(rawVal, { displayName = '', creatorHandle = '' } = {}) {
    const clean = String(rawVal || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    lastLocalEditAt = Date.now();
    if (clean.toLowerCase().startsWith('at://') && displayName) {
      rememberChannelLabel(clean, displayName, creatorHandle);
    }
    const cur = normalizeFeedTuning(feedStore.get().tuning);
    const low = clean.toLowerCase();
    if (!cur.discoveryChannels.some((c) => c.toLowerCase() === low)) {
      void updateFeedTuning({ discoveryChannels: [...cur.discoveryChannels, clean] });
    }
  }

  const modal = createClassicModalDialog({
    id: 'feed-tuning-dialog',
    maxWidth: '580px',
    onClose: () => {
      closed = true;
      communitySuggest.destroy();
      serverSuggest.destroy();
      unsubFeed();
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.innerHTML = `${TUNE_MODAL_SVG}<span>Communities &amp; Feeds</span>`;

  const desc = doc.createElement('p');
  desc.className = 'classic-modal-desc';
  desc.textContent = 'Type to search and subscribe to Bluesky custom feeds, Mastodon #hashtags, or trusted servers. Direct posts from accounts you follow stay in Following.';

  const scrollBody = doc.createElement('div');
  scrollBody.className = 'classic-modal-scroll-body';

  // 1. Unified Communities, Hashtags & Feeds Search-as-you-type Dropdown
  const browserSection = doc.createElement('div');
  browserSection.className = 'feed-tuning-section';
  const browserLabel = doc.createElement('label');
  browserLabel.setAttribute('for', 'feed-community-search-input');
  browserLabel.className = 'feed-concept-heading';
  browserLabel.textContent = 'Communities, Hashtags & Feeds';

  const searchForm = doc.createElement('form');
  searchForm.id = 'feed-community-search-form';
  searchForm.className = 'list-create-row feed-concept-form';

  const searchInput = doc.createElement('input');
  searchInput.type = 'search';
  searchInput.id = 'feed-community-search-input';
  searchInput.className = 'onboarding-input';
  searchInput.placeholder = 'Type a topic, #hashtag, or paste an at:// feed URI…';
  searchInput.setAttribute('autocomplete', 'off');
  searchInput.setAttribute('autocorrect', 'off');
  searchInput.setAttribute('autocapitalize', 'none');
  searchInput.setAttribute('spellcheck', 'false');

  const addDirectBtn = doc.createElement('button');
  addDirectBtn.type = 'submit';
  addDirectBtn.className = 'btn-sleek-pill';
  addDirectBtn.textContent = '+ Add';
  searchForm.append(searchInput, addDirectBtn);

  const activeChipsWrap = doc.createElement('div');
  activeChipsWrap.className = 'moderation-filter-chips feed-concept-chips';
  activeChipsWrap.dataset.sourceKind = 'channels';

  const communitySuggest = attachSearchSuggestions(searchInput, {
    anchorEl: searchForm,
    debounceMs: 220,
    minChars: 1,
    maxItems: 9,
    getLocalSuggestions: (rawQ) => {
      const clean = String(rawQ || '').replace(/\s+/g, ' ').trim();
      if (!clean) return [];
      if (clean.toLowerCase().startsWith('at://')) {
        return [{
          kind: 'feed',
          icon: 'feed',
          label: `Subscribe to feed URI`,
          sublabel: clean,
          value: clean,
        }];
      }
      const tagForm = `#${clean.replace(/^#+/, '')}`;
      const items = [
        {
          kind: 'hashtag',
          icon: 'hashtag',
          label: tagForm,
          sublabel: 'Subscribe to #hashtag',
          value: tagForm,
        },
      ];
      if (!clean.startsWith('#')) {
        items.push({
          kind: 'search',
          icon: 'search',
          label: clean,
          sublabel: 'Subscribe to topic keyword',
          value: clean,
        });
      }
      return items;
    },
    fetchRemoteSuggestions: async (rawQ) => {
      const clean = String(rawQ || '').replace(/\s+/g, ' ').trim();
      if (!clean || clean.toLowerCase().startsWith('at://')) return [];
      const cleanQuery = clean.replace(/^#+/, '');
      if (!cleanQuery) return [];

      const [bskyAuth, fediAuth] = await Promise.all([
        getAuthenticatedAccount('bluesky').catch(() => null),
        getAuthenticatedAccount('fediverse').catch(() => null),
      ]);
      if (closed) return [];

      const [feeds, fediRes] = await Promise.all([
        searchBskyFeedGenerators({
          query: cleanQuery,
          limit: 6,
          ...(bskyAuth?.secrets?.accessJwt
            ? { serviceUrl: bskyAuth.meta?.serviceUrl, accessJwt: bskyAuth.secrets.accessJwt }
            : {}),
        }).catch(() => []),
        searchFediverse({
          instanceUrl: fediAuth?.meta?.instanceUrl || DEFAULT_PUBLIC_MASTO_HOST,
          accessToken: fediAuth?.secrets?.accessToken || '',
          query: cleanQuery,
          type: 'hashtags',
          limit: 5,
        }).catch(() => ({ hashtags: [] })),
      ]);

      const curChannels = new Set(
        normalizeFeedTuning(feedStore.get().tuning).discoveryChannels.map((c) => c.toLowerCase())
      );
      const remoteItems = [];
      for (const g of Array.isArray(feeds) ? feeds : []) {
        const title = g.displayName || g.uri.split('/').pop() || 'Bluesky Feed';
        const isSub = curChannels.has(String(g.uri || '').toLowerCase());
        const likesLabel = g.likeCount > 0 ? ` · ${g.likeCount.toLocaleString()} likes` : '';
        const creator = g.creatorHandle ? `by @${g.creatorHandle}` : '';
        const descSnippet = g.description ? ` — ${g.description.replace(/\s+/g, ' ').slice(0, 75)}` : '';
        const baseSub = `${creator}${likesLabel}${descSnippet}`.trim() || g.uri;
        remoteItems.push({
          kind: 'feed',
          icon: 'feed',
          label: title,
          sublabel: isSub ? `Subscribed · ${baseSub}` : baseSub,
          value: g.uri,
          displayName: title,
          creatorHandle: g.creatorHandle || '',
        });
      }
      for (const t of Array.isArray(fediRes?.hashtags) ? fediRes.hashtags : []) {
        const name = String(t?.name || '').trim().replace(/^#+/, '');
        if (!name) continue;
        const tagVal = `#${name}`;
        const isSub = curChannels.has(tagVal.toLowerCase());
        remoteItems.push({
          kind: 'hashtag',
          icon: 'hashtag',
          label: tagVal,
          sublabel: isSub ? 'Subscribed · Mastodon hashtag timeline' : 'Mastodon hashtag timeline',
          value: tagVal,
        });
      }
      return remoteItems;
    },
    mergeSuggestions: (localItems, remoteItems) =>
      remoteItems.length > 0 ? [...remoteItems, ...localItems] : localItems,
    onSelect: (item) => {
      searchInput.value = '';
      subscribeChannel(item.value, {
        displayName: item.displayName || '',
        creatorHandle: item.creatorHandle || '',
      });
    },
  });

  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = searchInput.value.replace(/\s+/g, ' ').trim();
    if (!raw) return;
    searchInput.value = '';
    communitySuggest.close();
    subscribeChannel(raw);
  });

  browserSection.append(browserLabel, searchForm, activeChipsWrap);
  scrollBody.appendChild(browserSection);

  // 2. Trusted Fediverse / Lemmy Servers
  const serversSection = doc.createElement('div');
  serversSection.className = 'classic-section-divider feed-tuning-section';
  const srvLabel = doc.createElement('label');
  srvLabel.setAttribute('for', 'feed-instance-input');
  srvLabel.className = 'feed-concept-heading';
  srvLabel.textContent = 'Trusted Fediverse / Lemmy Servers';

  const srvForm = doc.createElement('form');
  srvForm.className = 'list-create-row feed-concept-form';
  const srvInput = doc.createElement('input');
  srvInput.type = 'search';
  srvInput.id = 'feed-instance-input';
  srvInput.name = 'feed-instance-input';
  srvInput.className = 'onboarding-input';
  srvInput.placeholder = 'e.g. fosstodon.org, hachyderm.io, hexbear.net...';
  srvInput.setAttribute('autocomplete', 'off');
  srvInput.setAttribute('autocorrect', 'off');
  srvInput.setAttribute('autocapitalize', 'none');
  srvInput.setAttribute('spellcheck', 'false');
  srvInput.setAttribute('enterkeyhint', 'done');
  const srvAddBtn = doc.createElement('button');
  srvAddBtn.type = 'submit';
  srvAddBtn.className = 'btn-sleek-pill';
  srvAddBtn.textContent = '+ Server';
  srvForm.append(srvInput, srvAddBtn);

  const srvChipsWrap = doc.createElement('div');
  srvChipsWrap.className = 'moderation-filter-chips feed-concept-chips';
  srvChipsWrap.dataset.sourceKind = 'instances';

  function addTrustedInstance(rawVal) {
    const clean = String(rawVal || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    lastLocalEditAt = Date.now();
    const cur = normalizeFeedTuning(feedStore.get().tuning);
    void updateFeedTuning({ discoveryInstances: [...cur.discoveryInstances, clean] });
  }

  const serverSuggest = attachSearchSuggestions(srvInput, {
    anchorEl: srvForm,
    debounceMs: 180,
    minChars: 1,
    maxItems: 7,
    getLocalSuggestions: (rawQ) => {
      const host = String(rawQ || '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
      if (!host || !host.includes('.')) return [];
      return [{
        kind: 'server',
        icon: 'server',
        label: host,
        sublabel: 'Add server domain',
        value: host,
      }];
    },
    fetchRemoteSuggestions: async (rawQ) => {
      const q = String(rawQ || '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
      if (!q) return [];
      const pool = await fetchDynamicFediverseInstances().catch(() => []);
      if (closed) return [];
      const curSet = new Set(normalizeFeedTuning(feedStore.get().tuning).discoveryInstances);
      return pool
        .filter((e) => e?.domain && e.domain.includes(q))
        .slice(0, 7)
        .map((e) => ({
          kind: 'server',
          icon: 'server',
          label: e.domain,
          sublabel: curSet.has(e.domain) ? `Added · ${e.software || 'fediverse'} server` : `${e.software || 'fediverse'} server`,
          value: e.domain,
        }));
    },
    mergeSuggestions: (localItems, remoteItems) => [...localItems, ...remoteItems],
    onSelect: (item) => {
      srvInput.value = '';
      addTrustedInstance(item.value);
    },
  });

  srvForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = srvInput.value.replace(/\s+/g, ' ').trim();
    if (!raw) return;
    srvInput.value = '';
    serverSuggest.close();
    addTrustedInstance(raw);
  });

  serversSection.append(srvLabel, srvForm, srvChipsWrap);
  scrollBody.appendChild(serversSection);

  // 3. Explicit Taste Memory section
  const tasteSection = doc.createElement('div');
  tasteSection.className = 'classic-section-divider feed-tuning-concepts-section';
  const th = doc.createElement('h4');
  th.className = 'modal-sub-header';
  th.textContent = 'Explicit Taste';
  const tasteSummaryEl = doc.createElement('p');
  tasteSummaryEl.className = 'classic-card-subtext';
  const clearTasteBtn = doc.createElement('button');
  clearTasteBtn.type = 'button';
  clearTasteBtn.className = 'edit-btn';
  clearTasteBtn.textContent = 'Reset Learned Taste';
  clearTasteBtn.addEventListener('click', () => {
    void clearLearnedTasteMemory();
  });
  tasteSection.append(th, tasteSummaryEl, clearTasteBtn);
  scrollBody.appendChild(tasteSection);

  // 4. Forkable User-Sovereign Ranking Manifest (JSON)
  const manifestSection = doc.createElement('div');
  manifestSection.className = 'classic-section-divider feed-tuning-section';
  const mh = doc.createElement('h4');
  mh.className = 'modal-sub-header';
  mh.textContent = 'Ranking Manifest (JSON)';
  const mDesc = doc.createElement('p');
  mDesc.className = 'classic-card-subtext';
  mDesc.textContent = 'Export or import your local ranking settings directly as portable JSON.';
  const mStatus = doc.createElement('p');
  mStatus.className = 'classic-card-subtext ranking-manifest-status';
  mStatus.setAttribute('role', 'status');

  const mActions = doc.createElement('div');
  mActions.className = 'feed-tuning-presets';

  const exportManifestBtn = doc.createElement('button');
  exportManifestBtn.type = 'button';
  exportManifestBtn.className = 'edit-btn ranking-manifest-export-btn';
  exportManifestBtn.textContent = 'Export JSON';
  exportManifestBtn.addEventListener('click', async () => {
    const jsonText = exportRankingManifest({ pretty: true });
    try {
      const blob = new Blob([jsonText], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = 'sanctuary-ranking-manifest.json';
      a.click();
      URL.revokeObjectURL(url);
      mStatus.textContent = 'Exported sanctuary-ranking-manifest.json.';
    } catch {
      await globalThis.navigator?.clipboard?.writeText?.(jsonText);
      mStatus.textContent = 'Manifest JSON copied to clipboard.';
    }
  });

  const importFileIn = doc.createElement('input');
  importFileIn.type = 'file';
  importFileIn.accept = '.json,application/json';
  importFileIn.hidden = true;
  importFileIn.addEventListener('change', async () => {
    const file = importFileIn.files?.[0];
    importFileIn.value = '';
    if (!file) return;
    try {
      const txt = await file.text();
      await importRankingManifest(txt);
      mStatus.textContent = `Imported ${file.name || 'manifest.json'}.`;
    } catch (err) {
      mStatus.textContent = `Import failed: ${err?.message || 'Invalid JSON.'}`;
    }
  });

  const importManifestBtn = doc.createElement('button');
  importManifestBtn.type = 'button';
  importManifestBtn.className = 'edit-btn ranking-manifest-import-btn';
  importManifestBtn.textContent = 'Import File';
  importManifestBtn.addEventListener('click', () => importFileIn.click());

  const resetManifestBtn = doc.createElement('button');
  resetManifestBtn.type = 'button';
  resetManifestBtn.className = 'edit-btn ranking-manifest-reset-btn';
  resetManifestBtn.textContent = 'Reset Manifest';
  resetManifestBtn.addEventListener('click', async () => {
    await resetRankingManifest();
    mStatus.textContent = 'Restored default manifest.';
  });

  mActions.append(exportManifestBtn, importManifestBtn, resetManifestBtn);
  manifestSection.append(mh, mDesc, mActions, mStatus, importFileIn);
  scrollBody.appendChild(manifestSection);

  // Footer actions
  const footer = doc.createElement('div');
  footer.className = 'feed-tuning-footer';

  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'edit-btn';
  resetBtn.textContent = 'Reset All';
  resetBtn.addEventListener('click', () => {
    lastLocalEditAt = Date.now();
    void resetFeedBlankSlate();
  });

  const doneBtn = doc.createElement('button');
  doneBtn.type = 'button';
  doneBtn.className = 'btn-sleek-pill';
  doneBtn.textContent = 'Done';
  doneBtn.addEventListener('click', () => modal.close());
  footer.append(resetBtn, doneBtn);

  modal.card.append(heading, desc, scrollBody, footer);

  function renderChipList(chipsWrap, list, { emptyText, chipClass, ariaPrefix, formatLabel, onRemove }) {
    chipsWrap.replaceChildren();
    if (!Array.isArray(list) || list.length === 0) {
      const empty = doc.createElement('span');
      empty.className = 'classic-card-subtext';
      empty.textContent = emptyText;
      chipsWrap.appendChild(empty);
      return;
    }
    for (const entry of list) {
      const chip = doc.createElement('div');
      chip.className = `moderation-filter-chip feed-concept-chip ${chipClass}`;
      const lbl = doc.createElement('span');
      lbl.className = 'moderation-filter-chip-label';
      lbl.textContent = formatLabel ? formatLabel(entry) : entry;
      if (formatLabel) lbl.title = entry;
      const rmBtn = doc.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'moderation-filter-chip-remove';
      rmBtn.setAttribute('aria-label', `${ariaPrefix} ${entry}`);
      rmBtn.textContent = '×';
      rmBtn.addEventListener('click', () => {
        lastLocalEditAt = Date.now();
        onRemove(entry);
      });
      chip.append(lbl, rmBtn);
      chipsWrap.appendChild(chip);
    }
  }

  let lastChipSig = '';
  function syncFromStore() {
    if (closed) return;
    const tuning = normalizeFeedTuning(feedStore.get().tuning);
    const st = feedStore.get();
    const posCount = Array.isArray(st.tasteMemory?.positive) ? st.tasteMemory.positive.length : 0;
    const negCount = Array.isArray(st.tasteMemory?.negative) ? st.tasteMemory.negative.length : 0;
    const authorCount = st.interactedAuthors ? Object.keys(st.interactedAuthors).length : 0;
    const tasteModeLabel = Object.keys(st.tasteScores || {}).length > 0 ? 'semantic embeddings active' : 'local memory';
    tasteSummaryEl.textContent = `${posCount} liked / interested · ${negCount} not interested (${tasteModeLabel})`;
    clearTasteBtn.disabled = posCount === 0 && negCount === 0;
    resetBtn.disabled = isDefaultFeedTuning(tuning) && posCount === 0 && negCount === 0 && authorCount === 0;

    const nextSig = JSON.stringify([
      tuning.discoveryChannels,
      tuning.discoveryInstances,
    ]);
    if (nextSig !== lastChipSig) {
      lastChipSig = nextSig;
      renderChipList(activeChipsWrap, tuning.discoveryChannels, {
        emptyText: 'No manual subscriptions yet (auto-syncing your saved Bluesky feeds, Mastodon followed hashtags/lists, and explicit taste).',
        chipClass: 'feed-source-chip',
        ariaPrefix: 'Remove channel',
        formatLabel: formatChannelLabel,
        onRemove: (entry) => {
          const cur = normalizeFeedTuning(feedStore.get().tuning);
          const low = entry.toLowerCase();
          void updateFeedTuning({ discoveryChannels: cur.discoveryChannels.filter((c) => c.toLowerCase() !== low) });
        },
      });
      renderChipList(srvChipsWrap, tuning.discoveryInstances, {
        emptyText: 'None added (querying /api/v1/trends/statuses strictly on your connected home server).',
        chipClass: 'feed-source-chip',
        ariaPrefix: 'Remove instance',
        onRemove: (entry) => {
          const cur = normalizeFeedTuning(feedStore.get().tuning);
          const low = entry.toLowerCase();
          void updateFeedTuning({ discoveryInstances: cur.discoveryInstances.filter((c) => c.toLowerCase() !== low) });
        },
      });
    }
  }

  const unsubFeed = feedStore.subscribe(() => {
    syncFromStore();
  });

  syncFromStore();
  modal.open();
  return modal;
}
