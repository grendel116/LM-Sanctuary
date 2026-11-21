import { canonicalizeActorHandle } from './schema/unifiedItem.js';

export const SLIDER_SPECS = Object.freeze({
  recencyHalfLifeHours: { min: 0, max: 48, step: 1, defaultValue: 0 },
  smallWeb: { min: -100, max: 100, step: 5, defaultValue: 0 },
  authorDiversity: { min: 0, max: 100, step: 5, defaultValue: 0 },
  reposts: { min: -100, max: 100, step: 5, defaultValue: 0 },
  longform: { min: -100, max: 100, step: 5, defaultValue: 0 },
  media: { min: -100, max: 100, step: 5, defaultValue: 0 },
  reciprocity: { min: 0, max: 100, step: 5, defaultValue: 0 },
  commercial: { min: -100, max: 100, step: 5, defaultValue: 0 },
  bourgeoisPolitics: { min: -100, max: 100, step: 5, defaultValue: 0 },
  matureContent: { min: -100, max: 100, step: 5, defaultValue: 0 },
});

export const SLIDER_DEFINITIONS = Object.freeze([
  {
    key: 'recencyHalfLifeHours',
    group: 'Stream Structure',
    label: 'Recency Window',
    description: '0 keeps newest-first order; higher hours give older high-match posts room to rise.',
    zeroLabel: 'Strict',
    unit: 'h',
  },
  {
    key: 'smallWeb',
    group: 'Stream Structure',
    label: 'Small Web vs Viral',
    description: 'Positive lifts quieter personal accounts and penalizes mega-viral outrage or dunk bait.',
  },
  {
    key: 'authorDiversity',
    group: 'Stream Structure',
    label: 'Author Diversity',
    description: 'Spreads consecutive posts from the same author apart across the stream.',
  },
  {
    key: 'reciprocity',
    group: 'Stream Structure',
    label: 'Local Reciprocity',
    description: 'Boosts authors you have liked, replied to, bookmarked, or shared to chat.',
  },
  {
    key: 'reposts',
    group: 'Format & Activity',
    label: 'Boosts & Reposts',
    description: '-100 hides boosts/reposts completely; positive lifts shared posts.',
    hideAtMin: true,
  },
  {
    key: 'longform',
    group: 'Format & Activity',
    label: 'Long-Form & Articles',
    description: 'Positive favors multi-sentence writing and linked articles over one-liners.',
  },
  {
    key: 'media',
    group: 'Format & Activity',
    label: 'Media & Visuals',
    description: 'Negative favors text-first posts; positive lifts photos and videos (bonus for alt text).',
  },
  {
    key: 'commercial',
    group: 'Content Balances',
    label: 'Commercial',
    description: 'Sponsored promos, storefronts, affiliate links, and hustle pitches (-100 hides).',
    hideAtMin: true,
  },
  {
    key: 'bourgeoisPolitics',
    group: 'Content Balances',
    label: 'Bourgeois Politics',
    description: 'Electoral horse-race punditry, establishment party spectacle, and campaign spin (-100 hides).',
    hideAtMin: true,
  },
  {
    key: 'matureContent',
    group: 'Content Balances',
    label: 'Mature Content',
    description: 'Sensitive CWs, NSFW flags, and adult-labeled media (-100 hides).',
    hideAtMin: true,
  },
]);

export const DEFAULT_FEED_TUNING = Object.freeze({
  version: 1,
  updatedAt: 0,
  updatedBy: 'default',
  sliders: Object.freeze({
    recencyHalfLifeHours: 0,
    smallWeb: 0,
    authorDiversity: 0,
    reposts: 0,
    longform: 0,
    media: 0,
    reciprocity: 0,
    commercial: 0,
    bourgeoisPolitics: 0,
    matureContent: 0,
  }),
  discoveryChannels: Object.freeze([]),
  discoveryInstances: Object.freeze([]),
});

export const FEED_TUNING_PRESETS = Object.freeze([
  {
    id: 'chronological',
    label: 'Chronological',
    sliders: {
      recencyHalfLifeHours: 0,
      smallWeb: 0,
      authorDiversity: 0,
      reposts: 0,
      longform: 0,
      media: 0,
      reciprocity: 0,
      commercial: 0,
      bourgeoisPolitics: 0,
      matureContent: 0,
    },
  },
  {
    id: 'sanctuary',
    label: 'Sanctuary',
    sliders: {
      recencyHalfLifeHours: 10,
      smallWeb: 80,
      authorDiversity: 65,
      reposts: -40,
      longform: 35,
      media: 0,
      reciprocity: 55,
      commercial: -100,
      bourgeoisPolitics: -100,
      matureContent: 0,
    },
  },
  {
    id: 'small_web',
    label: 'Small Web',
    sliders: {
      recencyHalfLifeHours: 8,
      smallWeb: 75,
      authorDiversity: 60,
      reposts: -35,
      longform: 25,
      media: 0,
      reciprocity: 50,
      commercial: -70,
      bourgeoisPolitics: -50,
      matureContent: 0,
    },
  },
  {
    id: 'deep_reading',
    label: 'Deep Reading',
    sliders: {
      recencyHalfLifeHours: 16,
      smallWeb: 45,
      authorDiversity: 50,
      reposts: -50,
      longform: 80,
      media: -25,
      reciprocity: 25,
      commercial: -80,
      bourgeoisPolitics: -40,
      matureContent: 0,
    },
  },
  {
    id: 'anti_noise',
    label: 'No Ads / Pundits',
    sliders: {
      recencyHalfLifeHours: 6,
      smallWeb: 55,
      authorDiversity: 65,
      reposts: -60,
      longform: 20,
      media: 0,
      reciprocity: 35,
      commercial: -100,
      bourgeoisPolitics: -100,
      matureContent: 0,
    },
  },
  {
    id: 'visual_art',
    label: 'Visual Focus',
    sliders: {
      recencyHalfLifeHours: 12,
      smallWeb: 35,
      authorDiversity: 45,
      reposts: 0,
      longform: -30,
      media: 85,
      reciprocity: 25,
      commercial: -60,
      bourgeoisPolitics: -40,
      matureContent: 0,
    },
  },
]);

function clampInt(raw, min, max, fallback) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function cleanConceptArray(raw, maxItems = 16) {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.replace(/;/g, ',').split(',')
      : [];
  const out = [];
  const seen = new Set();
  for (const entry of arr) {
    const clean = String(entry ?? '').replace(/\s+/g, ' ').slice(0, 80).trim();
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
  const sliders = {};
  const rawSliders = raw?.sliders && typeof raw.sliders === 'object' ? raw.sliders : {};
  for (const [key, spec] of Object.entries(SLIDER_SPECS)) {
    sliders[key] = clampInt(rawSliders[key], spec.min, spec.max, spec.defaultValue);
  }
  const discoveryChannels = cleanConceptArray(raw?.discoveryChannels, 16);
  const discoveryInstances = cleanInstanceArray(raw?.discoveryInstances, 12);
  const updatedAt = Math.max(0, Math.round(Number(raw?.updatedAt) || 0));
  const updatedBy = String(raw?.updatedBy || 'default').trim().slice(0, 64) || 'default';
  return {
    version: 1,
    updatedAt,
    updatedBy,
    sliders,
    discoveryChannels,
    discoveryInstances,
  };
}

export function isDefaultFeedTuning(rawProfile) {
  const profile = normalizeFeedTuning(rawProfile);
  if (
    profile.discoveryChannels.length > 0
    || profile.discoveryInstances.length > 0
  ) {
    return false;
  }
  return Object.values(profile.sliders).every((v) => Number(v) === 0);
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

export function scoreMatureSignal(item) {
  let score = 0;
  const bskyLabels = Array.isArray(item?._meta?.bluesky?.labels) ? item._meta.bluesky.labels : [];
  if (bskyLabels.some((l) => MATURE_LABELS.has(String(l).toLowerCase()))) {
    score = Math.max(score, 1);
  }
  const mastoSensitive = Boolean(item?._meta?.mastodon?.sensitive);
  const spoilerText = String(item?._meta?.mastodon?.spoilerText || item?.spoilerText || '');
  if (mastoSensitive) {
    score += MATURE_CW_RE.test(spoilerText) ? 0.9 : 0.55;
  } else if (spoilerText && MATURE_CW_RE.test(spoilerText)) {
    score += 0.65;
  }
  const text = buildItemSignalText(item);
  if (MATURE_STRONG_RE.test(text)) {
    score += 0.65;
  }
  return Math.min(1, score);
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
  const publishedMs = parseTimestampMs(item);
  const ageHours = Math.max(0.5, publishedMs > 0 ? (nowMs - publishedMs) / 3_600_000 : 1);
  const replyDepth = replies > 0 ? Math.min(1.35, Math.log2(1 + replies) * 0.42) : 0;
  const velocity = replies >= 2 ? Math.min(0.55, (replies / ageHours) * 0.14) : 0;
  const organic = Math.min(0.45, Math.log10(1 + likes + reposts) * 0.22);
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

/**
 * Nudge feed tuning sliders slightly from explicit "Interested" or "Not Interested" post feedback.
 * @param {Record<string, number>} [rawSliders]
 * @param {object} [rawItem]
 * @param {'interested' | 'not_interested'} [direction]
 * @returns {Record<string, number>}
 */
export function computeFeedbackSliderNudge(rawSliders = {}, rawItem = null, direction = 'interested') {
  const next = { ...normalizeFeedTuning({ sliders: rawSliders }).sliders };
  const sign = direction === 'not_interested' ? -1 : 1;
  const bump = (key, delta) => {
    const spec = SLIDER_SPECS[key];
    next[key] = clampInt((next[key] || 0) + delta, spec.min, spec.max, spec.defaultValue);
  };

  if (next.recencyHalfLifeHours === 0) next.recencyHalfLifeHours = 4;
  if (next.reciprocity < 25) bump('reciprocity', 10);

  if (rawItem && typeof rawItem === 'object') {
    if (isItemRepost(rawItem)) bump('reposts', sign * 5);
    const commSig = scoreCommercialSignal(rawItem);
    if (commSig >= 0.35) bump('commercial', sign * 10);
    if (scoreBourgeoisPoliticsSignal(rawItem) >= 0.3) bump('bourgeoisPolitics', sign * 10);
    if (scoreMatureSignal(rawItem) >= 0.4) bump('matureContent', sign * 10);

    const hasMedia = Array.isArray(rawItem.attachments) && rawItem.attachments.length > 0;
    if (hasMedia) bump('media', sign * 5);

    const charLen = String(rawItem.content_text || rawItem.text || '').trim().length;
    const hasArticle = Boolean(rawItem._meta?.linkCard?.url || rawItem.linkCard?.url) && commSig < 0.45;
    if (charLen >= 200 || hasArticle) {
      bump('longform', sign * 5);
    } else if (charLen > 0 && charLen < 90 && !hasMedia) {
      bump('longform', -sign * 5);
    }

    const m = rawItem.metrics || {};
    const reach = Number(m.likes || 0) + Number(m.reposts || 0) * 2 + Number(m.replies || 0);
    if (reach >= 150 || isLowEffortRageDunk(rawItem)) {
      bump('smallWeb', -sign * 5);
    } else if (reach <= 25) {
      bump('smallWeb', sign * 5);
    }
  }

  return next;
}

export function getCanonicalAuthorKey(item) {
  if (!item?.author) return String(item?.id || '');
  const proto = item.protocol || 'mastodon';
  const handle = canonicalizeActorHandle(item.author.handle || item.author.acct || '', proto);
  if (handle && handle !== `${proto}:`) return handle;
  return `${proto}:${item.author.id || item.author.name || item.id || ''}`;
}

/**
 * Deterministically filter and re-rank UnifiedItem[] according to local feed tuning weights,
 * social graph provenance, personal MiniLM/lexical taste, and conversation velocity.
 * @param {Array<object>} items
 * @param {object} rawProfile
 * @param {{
 *   nowMs?: number,
 *   streamMode?: string,
 *   interactedAuthors?: Record<string, number>,
 *   implicitAuthors?: Record<string, number>,
 *   semanticScores?: Record<string, number>,
 *   tasteScores?: Record<string, number>,
 *   tasteMemory?: { positive?: Array<object>, negative?: Array<object> } | null,
 * }} [context]
 * @returns {Array<object>}
 */
export function rankFeedItems(items = [], rawProfile = null, context = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return [];
  const profile = normalizeFeedTuning(rawProfile);
  const s = profile.sliders;
  const interactedAuthors = context.interactedAuthors && typeof context.interactedAuthors === 'object'
    ? context.interactedAuthors
    : {};
  const implicitAuthors = context.implicitAuthors && typeof context.implicitAuthors === 'object'
    ? context.implicitAuthors
    : {};
  const semanticScores = context.semanticScores && typeof context.semanticScores === 'object'
    ? context.semanticScores
    : {};
  const tasteScores = context.tasteScores && typeof context.tasteScores === 'object'
    ? context.tasteScores
    : {};
  const tasteMemory = context.tasteMemory && typeof context.tasteMemory === 'object'
    ? context.tasteMemory
    : null;

  const isExplicitChronological =
    profile.updatedBy === 'preset:chronological' &&
    Object.values(s).every((v) => Number(v) === 0);
  if (isExplicitChronological) {
    return [...list].sort(
      (a, b) => (Date.parse(b?.date_published || '') || 0) - (Date.parse(a?.date_published || '') || 0)
    );
  }
  if (context.streamMode === 'following' && isDefaultFeedTuning(profile)) {
    return list;
  }

  const isFeedMode = context.streamMode === 'feed';
  const hasPersonalTaste =
    Object.keys(implicitAuthors).length > 0 ||
    Object.keys(tasteScores).length > 0 ||
    (Array.isArray(tasteMemory?.positive) && tasteMemory.positive.length > 0) ||
    (Array.isArray(tasteMemory?.negative) && tasteMemory.negative.length > 0);
  if (!isFeedMode && !hasPersonalTaste && isDefaultFeedTuning(profile)) {
    return list;
  }

  const nowMs = Number(context.nowMs) || Date.now();
  const effectiveHalfLife = s.recencyHalfLifeHours > 0
    ? s.recencyHalfLifeHours
    : (isFeedMode ? 8 : 6);
  const diversityStrength = (isFeedMode && s.authorDiversity === 0 ? 55 : s.authorDiversity) / 100;
  const reciprocityScale = (isFeedMode && s.reciprocity === 0 ? 60 : s.reciprocity) / 100;
  const usePersonalSignals = isFeedMode || hasPersonalTaste;

  const scored = [];
  for (const item of list) {
    const repost = isItemRepost(item);
    if (s.reposts <= -100 && repost) continue;

    const commercialSig = scoreCommercialSignal(item);
    if (s.commercial <= -100 && commercialSig >= 0.45) continue;

    const politicsSig = scoreBourgeoisPoliticsSignal(item);
    if (s.bourgeoisPolitics <= -100 && politicsSig >= 0.35) continue;

    const matureSig = scoreMatureSignal(item);
    if (s.matureContent <= -100 && matureSig >= 0.4) continue;

    const publishedMs = parseTimestampMs(item);
    const ageHours = Math.max(0, (nowMs - publishedMs) / 3_600_000);
    const freshness = Math.pow(0.5, ageHours / effectiveHalfLife) * 4.0;

    let delta = 0;

    // 0. Graph inventory provenance (blended Following + 2nd-degree endorsements)
    const feedSource = item?._meta?.feedSource || '';
    if (usePersonalSignals) {
      if (feedSource === 'following') delta += 1.35;
      else if (feedSource === 'second_degree') delta += 0.95;
    }

    // 1. Small Web vs Viral (boost quieter accounts, penalize viral scale & rage/dunk ratio)
    if (s.smallWeb !== 0) {
      const m = item.metrics || {};
      const likes = Number(m.likes || 0);
      const replies = Number(m.replies || 0);
      const repostsCount = Number(m.reposts || 0);
      const totalReach = likes + repostsCount * 2 + replies;
      const viralScale = Math.min(2.2, Math.log10(1 + totalReach / 35));
      const dunkRatio = replies >= 8 && replies > likes * 1.35 ? 1.2 : 0;
      const smallSignal = 1.0 - viralScale - dunkRatio;
      delta += (s.smallWeb / 100) * smallSignal * 2.2;
    }

    // 2. Boosts & Reposts
    if (s.reposts !== 0 && repost) {
      delta += (s.reposts / 100) * 2.2;
    }

    // 3. Long-Form & Linked Writing
    if (s.longform !== 0) {
      const charLen = String(item.content_text || '').trim().length;
      const hasParagraphs = String(item.content_text || '').includes('\n');
      const hasNonCommercialArticle = Boolean(item._meta?.linkCard?.url) && commercialSig < 0.45;
      const depthSignal =
        (charLen >= 220 ? 0.9 : charLen >= 130 ? 0.3 : -0.6) +
        (hasParagraphs ? 0.3 : 0) +
        (hasNonCommercialArticle ? 0.7 : 0);
      delta += (s.longform / 100) * depthSignal * 1.4;
    }

    // 4. Media & Accessibility Balance
    if (s.media !== 0) {
      const atts = Array.isArray(item.attachments) ? item.attachments : [];
      if (atts.length > 0) {
        const allAlt = atts.every((a) => String(a?.alt_text || '').trim().length > 0);
        delta += (s.media / 100) * (allAlt ? 2.1 : 1.7);
      } else {
        delta -= (s.media / 100) * 0.6;
      }
    }

    // 5. Combined Explicit + Implicit Author Affinity
    const authorKey = getCanonicalAuthorKey(item);
    if (authorKey) {
      const explicitAff = Number(interactedAuthors[authorKey] || 0);
      const implicitAff = Number(implicitAuthors[authorKey] || 0) * 0.65;
      const totalAffinity = explicitAff + implicitAff;
      if (totalAffinity > 0 && (reciprocityScale > 0 || (isFeedMode && implicitAff > 0))) {
        const posScale = reciprocityScale > 0 ? reciprocityScale : 0.6;
        delta += posScale * Math.min(2.8, Math.log2(1 + totalAffinity) * 1.25);
      } else if (totalAffinity < 0) {
        const negScale = Math.max(0.45, reciprocityScale);
        delta -= negScale * Math.min(2.8, Math.log2(1 + Math.abs(totalAffinity)) * 1.35);
      }
    }

    // 6. Content Balances (Commercial, Bourgeois Politics, Mature Content)
    if (s.commercial !== 0 && commercialSig > 0) {
      delta += (s.commercial / 100) * commercialSig * 3.2;
    } else if (isFeedMode && s.commercial === 0 && commercialSig >= 0.45) {
      delta -= commercialSig * 2.0;
    }

    if (s.bourgeoisPolitics !== 0 && politicsSig > 0) {
      delta += (s.bourgeoisPolitics / 100) * politicsSig * 3.2;
    } else if (isFeedMode && s.bourgeoisPolitics === 0 && politicsSig >= 0.45) {
      delta -= politicsSig * 1.6;
    }

    if (s.matureContent !== 0 && matureSig > 0) {
      delta += (s.matureContent / 100) * matureSig * 3.2;
    }

    // 7. Personal Taste Exemplars (lexical taste blend) & Conversation Velocity
    if (usePersonalSignals) {
      const lexTaste = scorePersonalTasteLexical(item, tasteMemory);
      const rawVecTaste = tasteScores[item.id];
      const vecTaste = rawVecTaste !== undefined && rawVecTaste !== null ? Number(rawVecTaste) : NaN;
      let tasteSig = lexTaste;
      if (Number.isFinite(vecTaste) && vecTaste !== 0) {
        tasteSig = lexTaste !== 0 ? lexTaste * 0.35 + vecTaste * 0.65 : vecTaste;
      }
      if (tasteSig !== 0) {
        delta += tasteSig * 2.6;
      }
      delta += scoreConversationVelocity(item, nowMs) * 0.85;
    }

    let shuffleJitter = 0;
    if (isFeedMode && context.shuffleSeed) {
      const seedText = `${context.shuffleSeed}:${item.id || item.key || ''}`;
      let hash = 2166136261;
      for (let i = 0; i < seedText.length; i += 1) {
        hash ^= seedText.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const unit = ((hash >>> 0) % 10000) / 10000;
      shuffleJitter = (unit - 0.5) * 1.8;
    }
    scored.push({
      item,
      authorKey,
      publishedMs,
      baseScore: freshness + delta + shuffleJitter,
    });
  }

  scored.sort((a, b) => {
    if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
    if (b.publishedMs !== a.publishedMs) return b.publishedMs - a.publishedMs;
    return String(b.item.id || '').localeCompare(String(a.item.id || ''));
  });

  if (diversityStrength <= 0 || scored.length <= 2) {
    return scored.map((entry) => entry.item);
  }

  // Iterative greedy diversity pass to prevent prolific accounts from clustering
  const remaining = [...scored];
  const ordered = [];
  const seenAuthorCounts = new Map();
  let lastAuthorKey = '';

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestAdjusted = -Infinity;
    const scanLimit = Math.min(remaining.length, 60);
    for (let i = 0; i < scanLimit; i += 1) {
      const candidate = remaining[i];
      const priorCount = seenAuthorCounts.get(candidate.authorKey) || 0;
      const consecutivePenalty = candidate.authorKey && candidate.authorKey === lastAuthorKey ? 1.15 : 0;
      const adjusted =
        candidate.baseScore - diversityStrength * (priorCount * 1.45 + consecutivePenalty);
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }
    const [picked] = remaining.splice(bestIdx, 1);
    ordered.push(picked.item);
    if (picked.authorKey) {
      seenAuthorCounts.set(picked.authorKey, (seenAuthorCounts.get(picked.authorKey) || 0) + 1);
      lastAuthorKey = picked.authorKey;
    }
  }

  return ordered;
}
