import {
  DEFAULT_SENSITIVE_CONTENT_TRIGGERS,
  canonicalizeActorHandle,
  isReplyUnifiedItem,
  toUnifiedItem,
} from './schema/unifiedItem.js';

export const DEFAULT_FEED_TUNING = Object.freeze({
  version: 2,
  updatedAt: 0,
  updatedBy: 'default',
  discoveryChannels: Object.freeze([]),
  discoveryInstances: Object.freeze([]),
});

function cleanConceptArray(raw, maxItems = 24) {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.replace(/;/g, ',').split(',')
      : [];
  const out = [];
  const seen = new Set();
  for (const entry of arr) {
    const clean = String(entry ?? '').replace(/\s+/g, ' ').slice(0, 160).trim();
    if (!clean) continue;
    const low = clean.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function cleanInstanceArray(raw, maxItems = 12) {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.replace(/;/g, ',').split(',')
      : [];
  const out = [];
  const seen = new Set();
  for (const entry of arr) {
    let host = String(entry ?? '').trim().toLowerCase();
    if (!host) continue;
    host = host.replace(/^(?:https?:\/\/|:\/\/|\/\/)/, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
    if (!host || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(host)) continue;
    if (/^\d+(?:\.\d+){3}$/.test(host) || host === 'localhost' || /\.(?:local|ts\.net)$/i.test(host)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(host);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeFeedTuning(raw) {
  const discoveryChannels = cleanConceptArray(raw?.discoveryChannels, 24);
  const discoveryInstances = cleanInstanceArray(raw?.discoveryInstances, 12);
  const updatedAt = Math.max(0, Math.round(Number(raw?.updatedAt) || 0));
  const updatedBy = String(raw?.updatedBy || 'default').trim().slice(0, 64) || 'default';
  return {
    version: 2,
    updatedAt,
    updatedBy,
    discoveryChannels,
    discoveryInstances,
  };
}

export function isDefaultFeedTuning(rawProfile) {
  const profile = normalizeFeedTuning(rawProfile);
  return profile.discoveryChannels.length === 0 && profile.discoveryInstances.length === 0;
}

const COMMERCIAL_DOMAINS = [
  'amazon.', 'amzn.to', 'a.co', 'shopify.', 'gumroad.com', 'etsy.com', 'ebay.',
  'walmart.com', 'target.com', 'kickstarter.com', 'indiegogo.com', 'patreon.com',
  'ko-fi.com', 'buymeacoffee.com', 'gofundme.com', 'redbubble.com', 'teespring.com',
  'spring.com', 'fourthwall.', 'fourthwall.com', 'ticketmaster.com', 'eventbrite.com',
  'linktr.ee', 'stan.store', 'lemonsqueezy.com',
];

const COMMERCIAL_STRONG_RE = /\b(#ad|#sponsored|#affiliate|sponsored\s+post|paid\s+partnership|affiliate\s+link|use\s+(?:promo\s+)?code|promo\s+code|discount\s+code|coupon\s+code|shop\s+now|buy\s+now|order\s+now|pre-?order\s+now|limited\s+drop|merch\s+drop|link\s+in\s+bio|paid\s+subscribers|subscribe\s+now|grab\s+yours|on\s+sale\s+now)\b/i;
const COMMERCIAL_MEDIUM_RE = /\b(merch|merchandise|storefront|product\s+launch|black\s+friday|cyber\s+monday|flash\s+sale|giveaway|crowdfunding|upgrade\s+to\s+paid|tier\s+perk|sponsor(?:ed|ship)?|brand\s+deal)\b|\b\d{1,2}%\s+off\b|(?:^|\s)\$\d+(?:\.\d{2})?(?:\s*(?:usd|off|only))?\b/i;

const POLITICS_DOMAINS = [
  'cnn.com', 'msnbc.com', 'foxnews.com', 'politico.com', 'thehill.com', 'axios.com',
  'rawstory.com', 'mediamatters.org', 'breitbart.com', 'dailywire.com', 'punchbowl.news',
  'realclearpolitics.com', 'fivethirtyeight.com', 'thedailybeast.com', 'newrepublic.com',
  'huffpost.com', 'motherjones.com', 'washingtonexaminer.com', 'townhall.com',
  'nytimes.com', 'washingtonpost.com', 'wsj.com', 'bloomberg.com', 'ft.com', 'economist.com',
  'theatlantic.com', 'newyorker.com', 'vox.com', 'slate.com', 'salon.com', 'forbes.com',
  'fortune.com', 'businessinsider.com', 'semafor.com', 'thebulwark.com', 'thefp.com',
  'nationalreview.com', 'nypost.com', 'dailymail.co.uk', 'telegraph.co.uk', 'thetimes.com',
  'spectator.co.uk', 'newsweek.com', 'time.com', 'usatoday.com', 'nbcnews.com',
  'cbsnews.com', 'abcnews.go.com', 'foreignpolicy.com', 'foreignaffairs.com',
  'atlanticcouncil.org', 'brookings.edu', 'csis.org', 'heritage.org', 'cato.org',
  'aei.org', 'timesofisrael.com', 'jpost.com', 'ynetnews.com', 'bellingcat.com',
  'oann.com', 'newsmax.com',
];

const POLITICS_STRONG_RE = /\b(democrat|democrats|democratic\s+party|republican|republicans|gop|maga|dnc|rnc|white\s+house|capitol\s+hill|senate|congressman|congresswoman|congressional|swing\s+state|electoral\s+college|midterms|primary\s+election|bipartisan|approval\s+rating|campaign\s+trail|super\s+pac|beltway|polling\s+numbers|presidential\s+race|trump|biden|kamala\s+harris|desantis|pelosi|schumer|mcconnell|vance|newsom|pete\s+buttigieg|impeachment)\b/i;
const POLITICS_MEDIUM_RE = /\b(senator|governor|cabinet\s+pick|executive\s+order|filibuster|electorate|voters|ballot|pundit|talking\s+points|partisan|political\s+donors|house\s+speaker)\b/i;
const HEGEMONIC_PSYOP_RE = /\b(vote\s+blue|blue\s+no\s+matter\s+who|resist\s+libs?|tankies?|red\s+fash|rules-based\s+(?:international\s+)?order|leader\s+of\s+the\s+free\s+world|authoritarian\s+regimes?|kremlin\s+talking\s+points?|putler|ruzzia|nafo|slava\s+ukraini|ccp\s+(?:shills?|bots?|threat)|israel\s+has\s+a\s+right\s+to\s+defend|stand\s+with\s+israel|khamas|project\s+2025)\b/i;
const REACTIONARY_BAIT_RE = /\b(woke\s+mind\s+virus|anti-?woke|dei\s+hires?|cultural\s+marxis[mt]|great\s+replacement|illegal\s+aliens|border\s+czar|libtards?|demonrats?|marxist\s+democrats?|radical\s+left\s+democrats?|elon\s+musk|doge\s+department)\b/i;
const MATERIALIST_ANALYSIS_RE = /\b(mode\s+of\s+production|means\s+of\s+production|surplus\s+value|labou?r[\s-]+power|wage[\s-]+slav(?:e|ery)|proletari(?:at|an)|bourgeoisie|capitalist\s+class|ruling\s+class|working[\s-]+class|class\s+struggle|class\s+consciousness|dialectical|historical\s+materialism|worker\s+co-?op(?:erative)?s?|workers?'?\s+councils?|mutual\s+aid|general\s+strike|rank[\s-]+and[\s-]+file|shop\s+steward|tenant\s+unions?|abolish\s+(?:the\s+)?commodity|use[\s-]+value|exchange[\s-]+value|anti[\s-]+imperialis[mt]|settler[\s-]+colonial(?:ism)?|neoliberal\s+capitalism|dictatorship\s+of\s+(?:capital|the\s+bourgeoisie))\b/i;

const MATURE_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'nsfw', 'adult', 'suggestive']);
const MATURE_STRONG_RE = /\b(nsfw|18\+|adults?\s+only|explicit\s+content|porn(?:ography)?|erotic(?:a)?|onlyfans|fansly|lewd|nudes?|nudity|fetish|bdsm|kink(?:y)?|smut)\b/i;
const MATURE_CW_RE = /\b(nsfw|18\+|adult|sexual|nudity|explicit|gore|self-harm|violence|spoiler\s*nsfw)\b/i;

export function buildItemSignalText(item) {
  if (!item || typeof item !== 'object') return '';
  const parts = [
    item.content_text || item.text || '',
    item._meta?.mastodon?.spoilerText || item.spoilerText || '',
    item._meta?.linkCard?.title || item.linkCard?.title || '',
    item._meta?.linkCard?.description || item.linkCard?.description || '',
    item._meta?.quotePost?.text || item.quotePost?.text || '',
    item._meta?.threads?.topicTag || '',
  ];
  for (const att of (Array.isArray(item.attachments) ? item.attachments : [])) {
    if (att?.alt_text) parts.push(att.alt_text);
  }
  return parts.filter(Boolean).join(' \n ');
}

function getLinkDomains(item) {
  const candidates = [
    item?._meta?.linkCard?.url || item?.linkCard?.url || '',
    item?.url || '',
  ];
  const text = String(item?.content_text || item?.text || '');
  for (const m of text.matchAll(/https?:\/\/[^\s<>()]+/gi)) {
    candidates.push(m[0]);
  }
  const hosts = [];
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (host) hosts.push(host);
    } catch {
      // Ignore malformed URL fragments
    }
  }
  return hosts;
}

/**
 * Determine whether a UnifiedItem carries an external URL (excluding its own native permalink).
 */
export function hasPostExternalLink(item) {
  if (!item || typeof item !== 'object') return false;
  if (item._meta?.linkCard?.url || item.linkCard?.url) return true;
  if (/https?:\/\/\S+/i.test(String(item.content_text || item.text || ''))) return true;
  const facets = Array.isArray(item._meta?.bluesky?.facets) ? item._meta.bluesky.facets : [];
  return facets.some(
    (f) => Array.isArray(f?.features) && f.features.some((ft) => ft?.$type === 'app.bsky.richtext.facet#link' && ft?.uri)
  );
}

function isVisualAttachment(att) {
  if (!att || typeof att !== 'object') return false;
  const t = String(att.type || 'image').toLowerCase();
  const mime = String(att.mime_type || att.mimeType || '').toLowerCase();
  if (t === 'audio' || mime.startsWith('audio/')) return false;
  return true;
}

/**
 * Determine whether a UnifiedItem (or its quoted post) carries any image, video, or GIF attachment.
 */
export function hasVisualMediaAttachment(item) {
  if (!item || typeof item !== 'object') return false;
  if (Array.isArray(item.attachments) && item.attachments.some(isVisualAttachment)) return true;
  const quote = item._meta?.quotePost || item.quotePost || null;
  if (quote && typeof quote === 'object') {
    if (quote.thumbUrl || quote.image || (Array.isArray(quote.attachments) && quote.attachments.some(isVisualAttachment))) {
      return true;
    }
  }
  const replyCtx = item._meta?.replyContext || item.replyContext || null;
  if (replyCtx && typeof replyCtx === 'object') {
    if (replyCtx.thumbUrl || replyCtx.image || (Array.isArray(replyCtx.attachments) && replyCtx.attachments.some(isVisualAttachment))) {
      return true;
    }
  }
  return false;
}

const NEWSLETTER_FUNNEL_DOMAINS = [
  'substack.com', 'beehiiv.com', 'buttondown.email', 'buttondown.com',
  'medium.com', 'ghost.io', 'revue.email', 'mailchi.mp', 'convertkit.com',
  'linkedin.com', 'flipboard.com',
];

const NEWSLETTER_FUNNEL_RE = /\b(my\s+substack|new\s+substack|on\s+substack|subscribe\s+to\s+my\s+newsletter|new\s+newsletter|new\s+post\s+(?:is\s+)?(?:up|live|out)|new\s+essay\s+(?:is\s+)?(?:up|live|out)|read\s+(?:the\s+rest|more|my\s+latest)\s+(?:at|on|here|below))\b/i;

const SYNDICATION_HOST_RE = /(?:^|[@.])(?:rss\.|anyfeed\.cc|press\.coop|flipboard\.com|newsmast\.|newsbots?\.|botsin\.space|rssbridge\.|dlvr\.it|ifttt\.com|zapier\.com|federatedreader\.)/i;
const BOT_HANDLE_LOCAL_RE = /(?:^|[_.-])(?:rss|newsbot|feedbot|autobot|mirrorbot|federated[_.-]?reader|reader[_.-]?bot|syndicat(?:e|or))(?:$|[_.-])/i;
const SYNDICATION_NAME_RE = /\b(?:federated\s+reader|rss\s*(?:feed|bot|reader|bridge)|feed\s*(?:bot|reader)|news\s*(?:bot|wire|feed)|auto\s*post(?:er)?|mirror\s*bot|syndicat(?:or|ion))\b/i;
const NEWS_WIRE_TEXT_RE = /#(?:news|breaking|breakingnews|worldnews|ukrainewar|politics)\b|\b(?:breaking:|wire\s+report)\b/i;

export const DEFAULT_RANKING_MANIFEST = Object.freeze({
  version: 1,
  name: 'Sanctuary Default Commons Manifest',
  weights: Object.freeze({
    freshnessScale: 4.0,
    defaultHalfLifeHours: 18,
    followingProvenanceBonus: 0.4,
    secondDegreeProvenanceBonus: 0.6,
    peerVouchWeight: 2.8,
    commercialPenaltyWeight: 2.6,
    rageDunkPenaltyWeight: 2.4,
    linkSpamPenaltyWeight: 4.8,
    replyAndQuotePenaltyWeight: 3.2,
    textOnlyFeedBonus: 1.2,
    maxPositiveAuthorAffinity: 1.35,
    maxNegativeAuthorAffinity: 2.8,
    tasteScoreWeight: 2.6,
    velocityWeight: 0.45,
    diversityPriorAuthorPenalty: 1.45,
    diversityConsecutivePenalty: 1.25,
  }),
  caps: Object.freeze({
    maxDiscoveryPerAuthor: 2,
    maxBoostsPerBooster: 2,
    maxFollowingPerAuthor: 6,
    maxDiscoveryLinksPerAuthor: 1,
    maxDiscoveryLinkShare: 0.08,
    minDiscoveryLinkBudget: 1,
    minUnfollowedLinkProseChars: 45,
    linkSyndicatorBurstThreshold: 3,
    consecutiveAuthorScanWindow: 24,
    filterDiscoveryBotsByDefault: true,
  }),
  syndicationBotPatterns: Object.freeze({
    respectBotAccountFlag: true,
    hostRegex: SYNDICATION_HOST_RE.source,
    handleLocalRegex: BOT_HANDLE_LOCAL_RE.source,
    displayNameRegex: SYNDICATION_NAME_RE.source,
    newsWireZeroEngRegex: NEWS_WIRE_TEXT_RE.source,
  }),
  sensitiveContentTriggers: DEFAULT_SENSITIVE_CONTENT_TRIGGERS,
});

const manifestRegexCache = new Map();

function compileManifestRegex(pattern, fallbackRegex) {
  if (typeof pattern !== 'string') return fallbackRegex;
  if (!pattern.trim()) return null;
  if (manifestRegexCache.has(pattern)) return manifestRegexCache.get(pattern);
  try {
    const compiled = new RegExp(pattern, 'i');
    if (manifestRegexCache.size > 64) manifestRegexCache.clear();
    manifestRegexCache.set(pattern, compiled);
    return compiled;
  } catch {
    return fallbackRegex;
  }
}

function clampManifestNumber(raw, fallback, min, max, integer = false) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(min, Math.min(max, n));
  return integer ? Math.round(clamped) : Number(clamped.toFixed(4));
}

/**
 * Normalize a user-editable / forkable RankingManifest JSON object onto safe defaults.
 * Preserves intentional empty regex strings ("") and empty blurLabels ({}) so users
 * retain full sovereign control over all ranking and moderation rules.
 * @param {object | null} [raw]
 * @returns {object}
 */
export function normalizeRankingManifest(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const dw = DEFAULT_RANKING_MANIFEST.weights;
  const dc = DEFAULT_RANKING_MANIFEST.caps;
  const db = DEFAULT_RANKING_MANIFEST.syndicationBotPatterns;
  const ds = DEFAULT_RANKING_MANIFEST.sensitiveContentTriggers;

  const rw = src.weights && typeof src.weights === 'object' ? src.weights : {};
  const rc = src.caps && typeof src.caps === 'object' ? src.caps : {};
  const rb = src.syndicationBotPatterns && typeof src.syndicationBotPatterns === 'object' ? src.syndicationBotPatterns : {};
  const rs = src.sensitiveContentTriggers && typeof src.sensitiveContentTriggers === 'object' ? src.sensitiveContentTriggers : {};

  let blurLabels;
  if (rs.blurLabels && typeof rs.blurLabels === 'object' && !Array.isArray(rs.blurLabels)) {
    blurLabels = {};
    for (const [k, v] of Object.entries(rs.blurLabels)) {
      const cleanKey = String(k || '').trim().toLowerCase();
      const cleanVal = String(v || '').trim();
      if (cleanKey && cleanVal) blurLabels[cleanKey] = cleanVal;
    }
  } else {
    blurLabels = { ...ds.blurLabels };
  }

  const blockedSelf = Array.isArray(rs.jetstreamBlockedSelfLabels)
    ? [...new Set(rs.jetstreamBlockedSelfLabels.map((l) => String(l || '').trim().toLowerCase()).filter(Boolean))]
    : [...ds.jetstreamBlockedSelfLabels];

  return {
    version: Number(src.version) === 1 ? 1 : 1,
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim().slice(0, 80) : DEFAULT_RANKING_MANIFEST.name,
    weights: {
      freshnessScale: clampManifestNumber(rw.freshnessScale, dw.freshnessScale, 0, 20),
      defaultHalfLifeHours: clampManifestNumber(rw.defaultHalfLifeHours, dw.defaultHalfLifeHours, 1, 72),
      followingProvenanceBonus: clampManifestNumber(rw.followingProvenanceBonus, dw.followingProvenanceBonus, 0, 10),
      secondDegreeProvenanceBonus: clampManifestNumber(rw.secondDegreeProvenanceBonus, dw.secondDegreeProvenanceBonus, 0, 10),
      peerVouchWeight: clampManifestNumber(rw.peerVouchWeight, dw.peerVouchWeight, 0, 10),
      commercialPenaltyWeight: clampManifestNumber(rw.commercialPenaltyWeight, dw.commercialPenaltyWeight, 0, 10),
      rageDunkPenaltyWeight: clampManifestNumber(rw.rageDunkPenaltyWeight, dw.rageDunkPenaltyWeight, 0, 10),
      linkSpamPenaltyWeight: clampManifestNumber(rw.linkSpamPenaltyWeight, dw.linkSpamPenaltyWeight, 0, 10),
      replyAndQuotePenaltyWeight: clampManifestNumber(rw.replyAndQuotePenaltyWeight, dw.replyAndQuotePenaltyWeight, 0, 10),
      textOnlyFeedBonus: clampManifestNumber(rw.textOnlyFeedBonus, dw.textOnlyFeedBonus, 0, 10),
      maxPositiveAuthorAffinity: clampManifestNumber(rw.maxPositiveAuthorAffinity, dw.maxPositiveAuthorAffinity, 0, 10),
      maxNegativeAuthorAffinity: clampManifestNumber(rw.maxNegativeAuthorAffinity, dw.maxNegativeAuthorAffinity, 0, 10),
      tasteScoreWeight: clampManifestNumber(rw.tasteScoreWeight, dw.tasteScoreWeight, 0, 10),
      velocityWeight: clampManifestNumber(rw.velocityWeight, dw.velocityWeight, 0, 5),
      diversityPriorAuthorPenalty: clampManifestNumber(rw.diversityPriorAuthorPenalty, dw.diversityPriorAuthorPenalty, 0, 10),
      diversityConsecutivePenalty: clampManifestNumber(rw.diversityConsecutivePenalty, dw.diversityConsecutivePenalty, 0, 10),
    },
    caps: {
      maxDiscoveryPerAuthor: clampManifestNumber(rc.maxDiscoveryPerAuthor, dc.maxDiscoveryPerAuthor, 1, 25, true),
      maxBoostsPerBooster: clampManifestNumber(rc.maxBoostsPerBooster, dc.maxBoostsPerBooster, 1, 25, true),
      maxFollowingPerAuthor: clampManifestNumber(rc.maxFollowingPerAuthor, dc.maxFollowingPerAuthor, 1, 50, true),
      maxDiscoveryLinksPerAuthor: clampManifestNumber(rc.maxDiscoveryLinksPerAuthor, dc.maxDiscoveryLinksPerAuthor, 0, 25, true),
      maxDiscoveryLinkShare: clampManifestNumber(rc.maxDiscoveryLinkShare, dc.maxDiscoveryLinkShare, 0, 1),
      minDiscoveryLinkBudget: clampManifestNumber(rc.minDiscoveryLinkBudget, dc.minDiscoveryLinkBudget, 0, 50, true),
      minUnfollowedLinkProseChars: clampManifestNumber(rc.minUnfollowedLinkProseChars, dc.minUnfollowedLinkProseChars, 0, 500, true),
      linkSyndicatorBurstThreshold: clampManifestNumber(rc.linkSyndicatorBurstThreshold, dc.linkSyndicatorBurstThreshold, 2, 20, true),
      consecutiveAuthorScanWindow: clampManifestNumber(rc.consecutiveAuthorScanWindow, dc.consecutiveAuthorScanWindow, 1, 100, true),
      filterDiscoveryBotsByDefault: rc.filterDiscoveryBotsByDefault !== false,
    },
    syndicationBotPatterns: {
      respectBotAccountFlag: rb.respectBotAccountFlag !== false,
      hostRegex: typeof rb.hostRegex === 'string' ? rb.hostRegex : db.hostRegex,
      handleLocalRegex: typeof rb.handleLocalRegex === 'string' ? rb.handleLocalRegex : db.handleLocalRegex,
      displayNameRegex: typeof rb.displayNameRegex === 'string' ? rb.displayNameRegex : db.displayNameRegex,
      newsWireZeroEngRegex: typeof rb.newsWireZeroEngRegex === 'string' ? rb.newsWireZeroEngRegex : db.newsWireZeroEngRegex,
    },
    sensitiveContentTriggers: {
      respectAuthorSensitiveFlag: rs.respectAuthorSensitiveFlag !== false,
      blurLabels,
      keywordRegex: typeof rs.keywordRegex === 'string' ? rs.keywordRegex : ds.keywordRegex,
      jetstreamBlockedSelfLabels: blockedSelf,
    },
  };
}

/**
 * Score how strongly a post pushes external newsletter / Substack / essay link funnels (0..1).
 */
export function scoreLinkAndSubstackSignal(item) {
  if (!item || typeof item !== 'object') return 0;
  const hosts = getLinkDomains(item);
  const text = buildItemSignalText(item);
  let score = 0;
  if (hosts.some((h) => NEWSLETTER_FUNNEL_DOMAINS.some((dom) => h === dom || h.endsWith(`.${dom}`)))) {
    score += 0.7;
  }
  if (NEWSLETTER_FUNNEL_RE.test(text)) {
    score += 0.55;
  }
  if (hasPostExternalLink(item)) {
    const proseLen = String(item.content_text || item.text || '').replace(/https?:\/\/\S+/gi, '').trim().length;
    score += proseLen < 90 ? 0.45 : 0.25;
  }
  return Math.min(1, score);
}

/**
 * Detect automated RSS/news-wire/mirror bots unsuited for a human-first discovery Feed
 * using the user's editable local RankingManifest rules.
 */
export function isAutomatedSyndicationOrBotItem(rawItem, rawManifest = null) {
  if (!rawItem || typeof rawItem !== 'object') return false;
  const item = rawItem._meta ? rawItem : toUnifiedItem(rawItem);
  const botCfg = normalizeRankingManifest(rawManifest).syndicationBotPatterns;
  if (botCfg.respectBotAccountFlag && (item.author?.bot || item._meta?.mastodon?.bot)) return true;

  const hostRe = compileManifestRegex(botCfg.hostRegex, SYNDICATION_HOST_RE);
  const localRe = compileManifestRegex(botCfg.handleLocalRegex, BOT_HANDLE_LOCAL_RE);
  const nameRe = compileManifestRegex(botCfg.displayNameRegex, SYNDICATION_NAME_RE);
  const newsWireRe = compileManifestRegex(botCfg.newsWireZeroEngRegex, NEWS_WIRE_TEXT_RE);

  const handle = String(item.author?.handle || '').trim().replace(/^@/, '').toLowerCase();
  const localPart = handle.split('@')[0] || '';
  if ((hostRe && hostRe.test(handle)) || (localRe && localRe.test(localPart))) return true;
  const authorName = String(item.author?.name || '').trim();
  if (nameRe && (nameRe.test(authorName) || nameRe.test(handle))) return true;
  const authorUrl = String(item.author?.url || '').toLowerCase();
  if (hostRe && authorUrl && hostRe.test(authorUrl)) return true;
  const feedSource = item._meta?.feedSource || '';
  if (newsWireRe && feedSource === 'discovery' && hasPostExternalLink(item)) {
    const m = item.metrics || {};
    const totalEng = Number(m.likes || 0) + Number(m.replies || 0) + Number(m.reposts || 0);
    if (totalEng === 0 && newsWireRe.test(buildItemSignalText(item))) {
      return true;
    }
  }
  return false;
}

export function scoreCommercialSignal(item) {
  const text = buildItemSignalText(item);
  const hosts = getLinkDomains(item);
  let score = 0;
  if (hosts.some((h) => COMMERCIAL_DOMAINS.some((dom) => h.includes(dom)))) {
    score += 0.55;
  }
  if (COMMERCIAL_STRONG_RE.test(text)) {
    score += 0.55;
  }
  if (COMMERCIAL_MEDIUM_RE.test(text)) {
    score += 0.35;
  }
  const newsletterSig = scoreLinkAndSubstackSignal(item);
  if (newsletterSig >= 0.7 && (NEWSLETTER_FUNNEL_RE.test(text) || hosts.some((h) => NEWSLETTER_FUNNEL_DOMAINS.some((dom) => h === dom || h.endsWith(`.${dom}`))))) {
    score = Math.max(score, 0.55);
  }
  return Math.min(1, score);
}

export function scoreBourgeoisPoliticsSignal(item) {
  const text = buildItemSignalText(item);
  const hosts = getLinkDomains(item);
  let score = 0;
  const hasHegemonicDomain = hosts.some((h) => POLITICS_DOMAINS.some((dom) => h === dom || h.endsWith(`.${dom}`)));
  if (hasHegemonicDomain) {
    score += 0.55;
  }
  const hasPsyop = HEGEMONIC_PSYOP_RE.test(text);
  const hasReactionary = REACTIONARY_BAIT_RE.test(text);
  if (hasPsyop) score += 0.6;
  if (hasReactionary) score += 0.6;

  const strongMatches = text.match(new RegExp(POLITICS_STRONG_RE.source, 'gi')) || [];
  if (strongMatches.length >= 2) {
    score += 0.6;
  } else if (strongMatches.length === 1) {
    score += 0.4;
  }
  if (POLITICS_MEDIUM_RE.test(text)) {
    score += 0.25;
  }
  if (MATERIALIST_ANALYSIS_RE.test(text) && !hasHegemonicDomain && !hasPsyop && !hasReactionary) {
    score = Math.max(0, score - 0.65);
  }
  return Math.min(1, score);
}

export function isLowEffortRageDunk(item) {
  if (!item || typeof item !== 'object') return false;
  const m = item.metrics || {};
  const likes = Number(m.likes || 0);
  const replies = Number(m.replies || 0);
  const reposts = Number(m.reposts || 0);
  const textLen = String(item.content_text || '').trim().length;
  if (Boolean(item._meta?.quotePost) && textLen < 45 && likes + reposts >= 200) {
    return true;
  }
  return replies >= 14 && replies > Math.max(likes, 1) * 1.6;
}

export function scoreMatureSignal(item, rawManifest = null) {
  let score = 0;
  const triggers = rawManifest?.sensitiveContentTriggers;
  const labelMap =
    triggers?.blurLabels && typeof triggers.blurLabels === 'object' && !Array.isArray(triggers.blurLabels)
      ? triggers.blurLabels
      : null;
  const respectSensitive = triggers ? triggers.respectAuthorSensitiveFlag !== false : true;
  const kwRe = triggers && Object.prototype.hasOwnProperty.call(triggers, 'keywordRegex')
    ? compileManifestRegex(triggers.keywordRegex, MATURE_STRONG_RE)
    : MATURE_STRONG_RE;

  const bskyLabels = Array.isArray(item?._meta?.bluesky?.labels) ? item._meta.bluesky.labels : [];
  if (
    bskyLabels.some((l) => {
      const k = String(l).toLowerCase();
      return labelMap ? Object.prototype.hasOwnProperty.call(labelMap, k) : MATURE_LABELS.has(k);
    })
  ) {
    score = Math.max(score, 1);
  }
  const mastoSensitive = respectSensitive && Boolean(item?._meta?.mastodon?.sensitive);
  const spoilerText = String(item?._meta?.mastodon?.spoilerText || item?.spoilerText || '');
  if (mastoSensitive) {
    score += MATURE_CW_RE.test(spoilerText) ? 0.9 : 0.55;
  } else if (spoilerText && MATURE_CW_RE.test(spoilerText)) {
    score += 0.65;
  }
  const text = buildItemSignalText(item);
  if (kwRe && kwRe.test(text)) {
    score += 0.65;
  }
  return Math.min(1, score);
}

export function resolvePoleCoordinates(item, semEntry = null, rawManifest = null) {
  const sem = semEntry && typeof semEntry === 'object' ? semEntry : null;
  const lexComm = scoreCommercialSignal(item);
  const lexNews = scoreBourgeoisPoliticsSignal(item);
  const lexMat = scoreMatureSignal(item, rawManifest);

  const commercial = sem && Number.isFinite(Number(sem.commercial))
    ? Math.max(-1, Math.min(1, Math.max(Number(sem.commercial), lexComm)))
    : lexComm;

  const newsPolitics = sem && Number.isFinite(Number(sem.newsPolitics))
    ? Math.max(-1, Math.min(1, Math.max(Number(sem.newsPolitics), lexNews)))
    : lexNews;

  const matureContent = sem && Number.isFinite(Number(sem.matureContent))
    ? Math.max(-1, Math.min(1, Math.max(Number(sem.matureContent), lexMat)))
    : lexMat;

  let scienceTheory;
  if (sem && Number.isFinite(Number(sem.scienceTheory))) {
    scienceTheory = Math.max(-1, Math.min(1, Number(sem.scienceTheory)));
  } else {
    const rawText = String(item?.content_text || item?.text || '').trim();
    const charLen = rawText.length;
    const hasParagraphs = rawText.includes('\n');
    const hasNonCommercialArticle = Boolean(item?._meta?.linkCard?.url) && lexComm < 0.45 && scoreLinkAndSubstackSignal(item) < 0.7;
    const sigText = buildItemSignalText(item);
    const hasMaterialist = MATERIALIST_ANALYSIS_RE.test(sigText);
    const hasScienceTerms = /\b(?:study|methodology|experiment|research|scientific?|physics|quantum|biology|chemistry|mathematics|engineering|algorithm|empirical|calibration|observator(?:y|ies)|hypothesis)\b/i.test(sigText);
    scienceTheory = Math.max(
      -1,
      Math.min(
        1,
        (charLen >= 220 ? 0.55 : charLen >= 100 ? 0.2 : -0.35) +
          (hasParagraphs ? 0.2 : 0) +
          (hasNonCommercialArticle ? 0.35 : 0) +
          (hasMaterialist ? 0.4 : 0) +
          (hasScienceTerms ? 0.45 : 0) -
          lexComm * 0.4
      )
    );
  }

  let everydayChatter;
  if (sem && Number.isFinite(Number(sem.everydayChatter))) {
    const m = item?.metrics || {};
    const likes = Number(m.likes || 0);
    const replies = Number(m.replies || 0);
    const dunkPenalty = isLowEffortRageDunk(item) || (replies >= 6 && replies > Math.max(likes, 1) * 1.35) ? 0.65 : 0;
    everydayChatter = Math.max(-1, Math.min(1, Number(sem.everydayChatter) - dunkPenalty));
  } else {
    const rawText = String(item?.content_text || item?.text || '').trim();
    const tagCount = (rawText.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) || []).length;
    const m = item?.metrics || {};
    const likes = Number(m.likes || 0);
    const replies = Number(m.replies || 0);
    const dunkPenalty = isLowEffortRageDunk(item) || (replies >= 6 && replies > Math.max(likes, 1) * 1.35) ? 0.8 : 0;
    const isConversational =
      !isAutomatedSyndicationOrBotItem(item, rawManifest) &&
      !hasPostExternalLink(item) &&
      rawText.length >= 18 &&
      rawText.length <= 320 &&
      tagCount <= 2 &&
      lexComm < 0.4 &&
      lexNews < 0.35;
    everydayChatter = Math.max(-1, Math.min(1, (isConversational ? 0.65 : -0.1) - dunkPenalty));
  }

  return { everydayChatter, scienceTheory, newsPolitics, commercial, matureContent };
}

const TASTE_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'almost', 'alone', 'along', 'already', 'also',
  'although', 'always', 'among', 'another', 'around', 'because', 'before', 'being',
  'below', 'between', 'both', 'bsky', 'could', 'didn', 'does', 'doesn', 'doing',
  'during', 'each', 'else', 'even', 'every', 'everyone', 'first', 'from', 'good',
  'great', 'have', 'here', 'hers', 'herself', 'himself', 'http', 'https', 'into',
  'just', 'know', 'like', 'make', 'many', 'mastodon', 'more', 'most', 'much', 'must',
  'myself', 'never', 'only', 'other', 'others', 'ours', 'over', 'people', 'post',
  'posts', 'really', 'right', 'same', 'self', 'should', 'since', 'some', 'someone',
  'something', 'still', 'such', 'than', 'that', 'their', 'theirs', 'them', 'then',
  'there', 'these', 'they', 'thing', 'things', 'think', 'this', 'those', 'though',
  'thread', 'threads', 'through', 'today', 'under', 'until', 'very', 'want', 'were',
  'what', 'when', 'where', 'which', 'while', 'whom', 'will', 'with', 'without',
  'would', 'year', 'years', 'your', 'yours',
]);

function tokenizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9\p{L}]+/u)
    .filter((w) => w.length >= 2);
}

function buildTasteTokenWeights(tasteMemory) {
  const weights = new Map();
  const addExamples = (examples, sign) => {
    for (const entry of Array.isArray(examples) ? examples : []) {
      const txt = typeof entry === 'string' ? entry : entry?.text || '';
      const rawW = typeof entry === 'object' ? Number(entry?.weight ?? 1) : 1;
      const w = Math.max(0.1, Math.min(5, Number.isFinite(rawW) ? rawW : 1));
      const seen = new Set(tokenizeWords(txt));
      for (const tok of seen) {
        if (tok.length < 4 || /^\d+$/.test(tok) || TASTE_STOPWORDS.has(tok)) continue;
        weights.set(tok, (weights.get(tok) || 0) + sign * w);
      }
    }
  };
  addExamples(tasteMemory?.positive, 1);
  addExamples(tasteMemory?.negative, -0.9);
  return weights;
}

/**
 * Extract top positive recurring keywords from learned local taste memory for discovery queries.
 * @param {{ positive?: Array<object>, negative?: Array<object> }} [tasteMemory]
 * @param {number} [maxTopics]
 * @returns {Array<string>}
 */
export function extractLearnedTasteTopics(tasteMemory, maxTopics = 4) {
  if (!tasteMemory || (!Array.isArray(tasteMemory.positive) && !Array.isArray(tasteMemory.negative))) {
    return [];
  }
  const weights = buildTasteTokenWeights(tasteMemory);
  return [...weights.entries()]
    .filter(([, score]) => score >= 1.1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTopics)
    .map(([tok]) => tok);
}

/**
 * Score an item (-1..1) lexically against learned positive and negative taste exemplars.
 */
export function scorePersonalTasteLexical(item, tasteMemory) {
  const weights = buildTasteTokenWeights(tasteMemory);
  if (weights.size === 0) return 0;
  const hay = `${buildItemSignalText(item)} ${item?.author?.name || ''}`;
  const tokens = new Set(tokenizeWords(hay));
  let rawSum = 0;
  for (const tok of tokens) {
    const w = weights.get(tok);
    if (w) rawSum += w;
  }
  if (rawSum === 0) return 0;
  return Number(Math.tanh(rawSum / 3.5).toFixed(4));
}

/**
 * Score active conversation velocity while penalizing low-effort reply dunks.
 */
export function scoreConversationVelocity(item, nowMs = Date.now()) {
  if (!item || typeof item !== 'object') return 0;
  if (isLowEffortRageDunk(item)) return -0.9;
  const m = item.metrics || {};
  const likes = Number(m.likes || 0);
  const replies = Number(m.replies || 0);
  const reposts = Number(m.reposts || 0);
  if (replies >= 8 && replies > Math.max(likes, 1) * 1.35) {
    return -0.7;
  }
  if (replies >= 4 && replies > likes) {
    return 0;
  }
  const publishedMs = parseTimestampMs(item);
  const ageHours = Math.max(0.5, publishedMs > 0 ? (nowMs - publishedMs) / 3_600_000 : 1);
  const healthyReplies = Math.min(replies, Math.max(2, likes * 0.5));
  const replyDepth = healthyReplies > 0 ? Math.min(1.0, Math.log2(1 + healthyReplies) * 0.36) : 0;
  const velocity = healthyReplies >= 2 ? Math.min(0.45, (healthyReplies / ageHours) * 0.12) : 0;
  const organic = Math.min(0.8, Math.log10(1 + likes * 1.4 + reposts) * 0.34);
  return Math.max(-0.9, Math.min(2.0, replyDepth + velocity + organic));
}


function parseTimestampMs(item) {
  if (typeof item?.createdAtMs === 'number') return item.createdAtMs;
  const parsed = Date.parse(item?.date_published || item?.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function isItemRepost(item) {
  return Boolean(
    item?._meta?.mastodon?.rebloggedBy ||
    item?._meta?.bluesky?.rebloggedBy ||
    item?._meta?.threads?.isRepost
  );
}

function isViewerAlreadyInteracted(item) {
  return Boolean(
    item?._meta?.mastodon?.favourited ||
    item?._meta?.mastodon?.reblogged ||
    item?._meta?.bluesky?.likeUri ||
    item?._meta?.bluesky?.repostUri
  );
}

/**
 * Nudge feed tuning sliders slightly from explicit "Interested" or "Not Interested" post feedback.
 * @param {Record<string, number>} [rawSliders]
 * @param {object} [rawItem]
 * @param {'interested' | 'not_interested'} [direction]
 * @returns {Record<string, number>}
 */
export function getCanonicalAuthorKey(item) {
  if (!item?.author) return String(item?.id || '');
  const proto = item.protocol || 'mastodon';
  const handle = canonicalizeActorHandle(item.author.handle || item.author.acct || '', proto);
  if (handle && handle !== `${proto}:`) return handle;
  return `${proto}:${item.author.id || item.author.name || item.id || ''}`;
}

export function getCanonicalBoosterKey(item) {
  if (!item || typeof item !== 'object') return '';
  const proto = item.protocol || 'mastodon';
  const booster =
    item._meta?.mastodon?.rebloggedBy
    || item._meta?.bluesky?.rebloggedBy
    || (Array.isArray(item._meta?.boosters) ? item._meta.boosters[0] : null);
  const raw = booster?.handle || booster?.acct || booster?.id || booster?.did || item._meta?.endorsedBy || '';
  if (!raw) return '';
  const canon = canonicalizeActorHandle(String(raw), proto);
  return canon && canon !== `${proto}:` ? canon : `${proto}:${String(raw).toLowerCase()}`;
}

/**
 * Prevent back-to-back items from the same author or booster using a bounded lookahead window.
 * @param {Array<object>} items
 * @param {number} [scanWindow]
 * @returns {Array<object>}
 */
export function spreadConsecutiveAuthors(items = [], scanWindow = 24) {
  const pool = Array.isArray(items) ? items.filter(Boolean) : [];
  if (pool.length <= 2) return pool;
  const remaining = [...pool];
  const out = [];
  let lastAuthorKey = '';
  let lastBoosterKey = '';
  while (remaining.length > 0) {
    let pickIdx = 0;
    const firstKey = getCanonicalAuthorKey(remaining[0]);
    const firstBooster = getCanonicalBoosterKey(remaining[0]);
    const conflicts = (ak, bk) =>
      Boolean((lastAuthorKey && ak && ak === lastAuthorKey) || (lastBoosterKey && bk && bk === lastBoosterKey));
    if (conflicts(firstKey, firstBooster)) {
      const limit = Math.min(remaining.length, scanWindow);
      for (let i = 1; i < limit; i += 1) {
        const candKey = getCanonicalAuthorKey(remaining[i]);
        const candBooster = getCanonicalBoosterKey(remaining[i]);
        if (!conflicts(candKey, candBooster)) {
          pickIdx = i;
          break;
        }
      }
    }
    const [picked] = remaining.splice(pickIdx, 1);
    out.push(picked);
    const k = getCanonicalAuthorKey(picked);
    if (k) lastAuthorKey = k;
    lastBoosterKey = getCanonicalBoosterKey(picked);
  }
  return out;
}

function computeSeededJitter(id, seed) {
  const seedStr = String(seed || '').trim();
  if (!seedStr) return 0;
  const input = `${seedStr}:${String(id || '')}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295 - 0.5;
}

/**
 * Distribute external-link posts evenly through the text stream (after a leading
 * run of pure text posts) so deweighted links never clump into a consecutive block.
 */
function interleaveLinkClusters(items = []) {
  const list = Array.isArray(items) ? items : [];
  if (list.length <= 2) return list;
  const nonLinks = [];
  const links = [];
  for (const item of list) {
    if (hasPostExternalLink(item)) links.push(item);
    else nonLinks.push(item);
  }
  if (links.length === 0 || nonLinks.length < 3) return list;

  const lead = Math.min(Math.max(3, Math.floor(nonLinks.length / (links.length + 1))), nonLinks.length);
  const stride = Math.max(1, Math.floor((nonLinks.length - lead) / links.length));
  const out = [];
  let linkIdx = 0;
  for (let i = 0; i < nonLinks.length; i += 1) {
    out.push(nonLinks[i]);
    if (linkIdx < links.length && i + 1 >= lead && ((i + 1 - lead) % stride === 0)) {
      out.push(links[linkIdx]);
      linkIdx += 1;
    }
  }
  while (linkIdx < links.length) {
    out.push(links[linkIdx]);
    linkIdx += 1;
  }
  return out;
}

/**
 * Deterministically filter and re-rank UnifiedItem[] for Discovery (`Feed`) using an 18h
 * recency half-life, 2-hop peer vouches with mega-viral dampening, baseline spam/rage
 * guardrails, explicit taste memory, and author/booster diversity. Non-discovery streams
 * preserve chronological order.
 */
export function rankFeedItems(items = [], rawProfile = null, context = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return [];
  normalizeFeedTuning(rawProfile);
  const manifest = normalizeRankingManifest(context.manifest);
  const w = manifest.weights;
  const shuffleSeed = typeof context.shuffleSeed === 'string' ? context.shuffleSeed.trim() : '';
  const deprioritizeSet = context.deprioritizeIds instanceof Set
    ? (context.deprioritizeIds.size > 0 ? context.deprioritizeIds : null)
    : (Array.isArray(context.deprioritizeIds) && context.deprioritizeIds.length > 0
        ? new Set(context.deprioritizeIds.map((id) => String(id || '')).filter(Boolean))
        : null);
  const isFeedMode = (context.streamMode || 'feed') === 'feed';
  const partitionDeprioritized = (ranked) => {
    const hasDeprioritize = Boolean(deprioritizeSet && deprioritizeSet.size > 0);
    if (ranked.length <= 1 || (!hasDeprioritize && !isFeedMode)) return ranked;
    const unseen = [];
    const seen = [];
    for (const item of ranked) {
      const k = String(item?.id || item?.key || '');
      if ((k && deprioritizeSet?.has(k)) || (isFeedMode && isViewerAlreadyInteracted(item))) {
        seen.push(item);
      } else {
        unseen.push(item);
      }
    }
    return unseen.length > 0 ? [...unseen, ...seen] : ranked;
  };

  if (!isFeedMode) {
    return partitionDeprioritized(list);
  }

  const interactedAuthors = context.interactedAuthors && typeof context.interactedAuthors === 'object'
    ? context.interactedAuthors
    : {};
  const tasteScores = context.tasteScores && typeof context.tasteScores === 'object'
    ? context.tasteScores
    : {};
  const semanticScores = context.semanticScores && typeof context.semanticScores === 'object'
    ? context.semanticScores
    : {};
  const tasteMemory = context.tasteMemory && typeof context.tasteMemory === 'object'
    ? context.tasteMemory
    : null;

  const nowMs = Number(context.nowMs) || Date.now();
  const effectiveHalfLife = w.defaultHalfLifeHours || 18;
  const filterBots = manifest.caps.filterDiscoveryBotsByDefault !== false;
  const isTextFeed = !context.discoveryMode || context.discoveryMode === 'default' || context.discoveryMode === 'feed';

  const scored = [];
  for (const item of list) {
    const feedSource = item?._meta?.feedSource || '';
    if (filterBots && feedSource !== 'following' && isAutomatedSyndicationOrBotItem(item, manifest)) continue;
    if (isTextFeed && hasVisualMediaAttachment(item)) continue;

    const semRaw = semanticScores[item.id] ?? semanticScores[item.key] ?? null;
    const sem = semRaw && typeof semRaw === 'object' ? semRaw : null;
    const semChannel = typeof semRaw === 'number' ? semRaw : Number(sem?.channelMatch ?? NaN);

    const publishedMs = parseTimestampMs(item);
    const ageHours = Math.max(0, (nowMs - publishedMs) / 3_600_000);
    const freshness = Math.pow(0.5, ageHours / effectiveHalfLife) * w.freshnessScale;

    let delta = 0;

    // 1. 2-Hop Peer Vouches with Mega-Viral Dampening: peerVouches / log2(10 + globalLikes)
    const rawVouches = Math.max(
      Number(item?._meta?.peerVouches || 0),
      Array.isArray(item?._meta?.boosters) ? item._meta.boosters.length : 0,
      feedSource === 'second_degree' ? 1 : 0
    );
    if (rawVouches > 0) {
      const globalLikes = Math.max(0, Number(item?.metrics?.likes || 0));
      delta += ((1 + Math.log2(rawVouches)) / Math.log2(10 + globalLikes)) * Math.log2(10) * w.peerVouchWeight;
    }

    // 2. Always-on Baseline Guardrails (commercial spam, rage-dunks, bare link funnels)
    const commSig = scoreCommercialSignal(item);
    if (commSig >= 0.35) {
      delta -= commSig * w.commercialPenaltyWeight;
    }
    if (isLowEffortRageDunk(item)) {
      delta -= w.rageDunkPenaltyWeight;
    }
    const hasExtLink = hasPostExternalLink(item);
    const substackLinkSig = scoreLinkAndSubstackSignal(item);
    const proseLen = String(item.content_text || '').replace(/https?:\/\/\S+/gi, '').trim().length;
    const hasQuotePost = Boolean(item._meta?.quotePost || item.quotePost);
    const isReply = isReplyUnifiedItem(item);
    if (isReply || hasQuotePost) {
      delta -= w.replyAndQuotePenaltyWeight;
    }
    if (hasExtLink || substackLinkSig >= 0.45) {
      const linkMult = proseLen < 140 ? 1.0 : 0.75;
      delta -= w.linkSpamPenaltyWeight * linkMult + substackLinkSig;
    } else if (isTextFeed && proseLen > 0 && !isReply && !hasQuotePost) {
      delta += w.textOnlyFeedBonus;
    }

    // 3. Custom Channel Semantic Match
    if (Number.isFinite(semChannel) && semChannel !== 0) {
      delta += semChannel * 1.8;
    }

    // 4. Explicit Learned Taste (lexical + vector) & Explicit Author Affinity
    const lexTaste = scorePersonalTasteLexical(item, tasteMemory);
    const rawVecTaste = tasteScores[item.id] ?? tasteScores[item.key];
    const vecTaste = rawVecTaste !== undefined && rawVecTaste !== null ? Number(rawVecTaste) : NaN;
    let tasteSig = lexTaste;
    if (Number.isFinite(vecTaste) && vecTaste !== 0) {
      tasteSig = lexTaste !== 0 ? lexTaste * 0.2 + vecTaste * 0.8 : vecTaste;
    }
    if (tasteSig !== 0) {
      delta += tasteSig * w.tasteScoreWeight;
    }

    if (feedSource === 'second_degree') {
      delta += w.secondDegreeProvenanceBonus;
    }

    const authorKey = getCanonicalAuthorKey(item);
    if (authorKey) {
      const explicitAff = Number(interactedAuthors[authorKey] || 0);
      if (explicitAff > 0) {
        delta += Math.min(w.maxPositiveAuthorAffinity, Math.log2(1 + explicitAff) * 0.45);
      } else if (explicitAff < 0) {
        delta -= Math.min(w.maxNegativeAuthorAffinity, Math.log2(1 + Math.abs(explicitAff)) * 0.9);
      }
    }

    // 5. Healthy Conversation Velocity
    delta += scoreConversationVelocity(item, nowMs) * w.velocityWeight;

    scored.push({
      item,
      authorKey,
      boosterKey: getCanonicalBoosterKey(item),
      hasExtLink,
      publishedMs,
      baseScore: freshness + delta + (shuffleSeed ? computeSeededJitter(item?.id || item?.key || '', shuffleSeed) * 0.35 : 0),
    });
  }

  scored.sort((a, b) => {
    if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
    if (b.publishedMs !== a.publishedMs) return b.publishedMs - a.publishedMs;
    return String(b.item.id || '').localeCompare(String(a.item.id || ''));
  });

  if (scored.length <= 2) {
    return partitionDeprioritized(scored.map((entry) => entry.item));
  }

  // Iterative greedy diversity pass: prevent prolific authors, prolific boosters, and consecutive links from clustering
  const diversityStrength = 0.55;
  const remaining = [...scored];
  const ordered = [];
  const seenAuthorCounts = new Map();
  const seenBoosterCounts = new Map();
  let lastAuthorKey = '';
  let lastBoosterKey = '';
  let lastWasLink = false;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestAdjusted = -Infinity;
    const scanLimit = Math.min(remaining.length, 60);
    for (let i = 0; i < scanLimit; i += 1) {
      const candidate = remaining[i];
      const priorAuthorCount = seenAuthorCounts.get(candidate.authorKey) || 0;
      const priorBoosterCount = candidate.boosterKey ? (seenBoosterCounts.get(candidate.boosterKey) || 0) : 0;
      const consecutiveAuthorPenalty =
        candidate.authorKey && candidate.authorKey === lastAuthorKey ? w.diversityConsecutivePenalty : 0;
      const consecutiveBoosterPenalty =
        candidate.boosterKey && candidate.boosterKey === lastBoosterKey ? w.diversityConsecutivePenalty : 0;
      const consecutiveLinkPenalty =
        lastWasLink && candidate.hasExtLink ? w.diversityConsecutivePenalty * 2 : 0;
      const adjusted =
        candidate.baseScore
        - diversityStrength * (
          priorAuthorCount * w.diversityPriorAuthorPenalty
          + priorBoosterCount * w.diversityPriorAuthorPenalty
          + consecutiveAuthorPenalty
          + consecutiveBoosterPenalty
        )
        - consecutiveLinkPenalty;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    ordered.push(picked.item);
    lastWasLink = Boolean(picked.hasExtLink);
    if (picked.authorKey) {
      seenAuthorCounts.set(picked.authorKey, (seenAuthorCounts.get(picked.authorKey) || 0) + 1);
      lastAuthorKey = picked.authorKey;
    }
    if (picked.boosterKey) {
      seenBoosterCounts.set(picked.boosterKey, (seenBoosterCounts.get(picked.boosterKey) || 0) + 1);
      lastBoosterKey = picked.boosterKey;
    } else {
      lastBoosterKey = '';
    }
  }

  const spaced = isTextFeed ? interleaveLinkClusters(ordered) : ordered;
  return partitionDeprioritized(spaced);
}
