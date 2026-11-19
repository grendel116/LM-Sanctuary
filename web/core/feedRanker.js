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
  boostConcepts: Object.freeze([]),
  dampenConcepts: Object.freeze([]),
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

export function normalizeFeedTuning(raw) {
  const sliders = {};
  const rawSliders = raw?.sliders && typeof raw.sliders === 'object' ? raw.sliders : {};
  for (const [key, spec] of Object.entries(SLIDER_SPECS)) {
    sliders[key] = clampInt(rawSliders[key], spec.min, spec.max, spec.defaultValue);
  }
  const boostConcepts = cleanConceptArray(raw?.boostConcepts);
  const boostLower = new Set(boostConcepts.map((c) => c.toLowerCase()));
  const dampenConcepts = cleanConceptArray(raw?.dampenConcepts).filter((c) => !boostLower.has(c.toLowerCase()));
  const updatedAt = Math.max(0, Math.round(Number(raw?.updatedAt) || 0));
  const updatedBy = String(raw?.updatedBy || 'default').trim().slice(0, 64) || 'default';
  return {
    version: 1,
    updatedAt,
    updatedBy,
    sliders,
    boostConcepts,
    dampenConcepts,
  };
}

export function isDefaultFeedTuning(rawProfile) {
  const profile = normalizeFeedTuning(rawProfile);
  if (profile.boostConcepts.length > 0 || profile.dampenConcepts.length > 0) return false;
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
];

const POLITICS_STRONG_RE = /\b(democrat|democrats|democratic\s+party|republican|republicans|gop|maga|dnc|rnc|white\s+house|capitol\s+hill|senate|congressman|congresswoman|congressional|swing\s+state|electoral\s+college|midterms|primary\s+election|bipartisan|approval\s+rating|campaign\s+trail|super\s+pac|beltway|polling\s+numbers|presidential\s+race|trump|biden|kamala\s+harris|desantis|pelosi|schumer|mcconnell|vance|newsom|pete\s+buttigieg|impeachment)\b/i;
const POLITICS_MEDIUM_RE = /\b(senator|governor|cabinet\s+pick|executive\s+order|filibuster|electorate|voters|ballot|pundit|talking\s+points|partisan|political\s+donors|house\s+speaker)\b/i;

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
  if (hosts.some((h) => POLITICS_DOMAINS.some((dom) => h === dom || h.endsWith(`.${dom}`)))) {
    score += 0.5;
  }
  const strongMatches = text.match(new RegExp(POLITICS_STRONG_RE.source, 'gi')) || [];
  if (strongMatches.length >= 2) {
    score += 0.6;
  } else if (strongMatches.length === 1) {
    score += 0.4;
  }
  if (POLITICS_MEDIUM_RE.test(text)) {
    score += 0.25;
  }
  return Math.min(1, score);
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

function tokenizeWords(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9\p{L}]+/u)
    .filter((w) => w.length >= 2);
}

function matchConceptScore(haystackLower, haystackTokens, concept) {
  const clean = String(concept || '').trim().toLowerCase();
  if (!clean) return 0;
  if (haystackLower.includes(clean)) return 1;
  const cTokens = tokenizeWords(clean);
  if (cTokens.length === 0) return 0;
  let hits = 0;
  for (const tok of cTokens) {
    if (haystackTokens.has(tok) || [...haystackTokens].some((h) => h.startsWith(tok) || (h.length >= 4 && tok.startsWith(h)))) {
      hits += 1;
    }
  }
  const ratio = hits / cTokens.length;
  return ratio >= 0.5 ? ratio * 0.8 : 0;
}

export function scoreConceptLexical(item, boostConcepts = [], dampenConcepts = []) {
  const boostList = Array.isArray(boostConcepts) ? boostConcepts : [];
  const dampenList = Array.isArray(dampenConcepts) ? dampenConcepts : [];
  if (boostList.length === 0 && dampenList.length === 0) return 0;

  const haystack = `${buildItemSignalText(item)} ${item?.author?.name || ''} ${item?.author?.handle || ''}`.toLowerCase();
  const tokens = new Set(tokenizeWords(haystack));

  let boostMax = 0;
  for (const c of boostList) {
    boostMax = Math.max(boostMax, matchConceptScore(haystack, tokens, c));
  }
  let dampenMax = 0;
  for (const c of dampenList) {
    dampenMax = Math.max(dampenMax, matchConceptScore(haystack, tokens, c));
  }
  return Math.max(-1, Math.min(1, boostMax - dampenMax));
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

export function getCanonicalAuthorKey(item) {
  if (!item?.author) return String(item?.id || '');
  const proto = item.protocol || 'mastodon';
  const handle = canonicalizeActorHandle(item.author.handle || item.author.acct || '', proto);
  if (handle && handle !== `${proto}:`) return handle;
  return `${proto}:${item.author.id || item.author.name || item.id || ''}`;
}

/**
 * Deterministically filter and re-rank UnifiedItem[] according to local feed tuning weights.
 * @param {Array<object>} items
 * @param {object} rawProfile
 * @param {{ nowMs?: number, interactedAuthors?: Record<string, number>, semanticScores?: Record<string, number> }} [context]
 * @returns {Array<object>}
 */
export function rankFeedItems(items = [], rawProfile = null, context = {}) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return [];
  const profile = normalizeFeedTuning(rawProfile);
  if (isDefaultFeedTuning(profile)) {
    return list;
  }

  const s = profile.sliders;
  const nowMs = Number(context.nowMs) || Date.now();
  const interactedAuthors = context.interactedAuthors && typeof context.interactedAuthors === 'object'
    ? context.interactedAuthors
    : {};
  const semanticScores = context.semanticScores && typeof context.semanticScores === 'object'
    ? context.semanticScores
    : {};

  const effectiveHalfLife = s.recencyHalfLifeHours > 0 ? s.recencyHalfLifeHours : 6;
  const hasConceptAnchors = profile.boostConcepts.length > 0 || profile.dampenConcepts.length > 0;
  const diversityStrength = s.authorDiversity / 100;

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

    // 1. Small Web vs Viral (boost quieter accounts, penalize viral scale & rage/dunk ratio)
    if (s.smallWeb !== 0) {
      const m = item.metrics || {};
      const likes = Number(m.likes || 0);
      const replies = Number(m.replies || 0);
      const repostsCount = Number(m.reposts || 0);
      const totalReach = likes + repostsCount * 2 + replies;
      const viralScale = Math.min(2.2, Math.log10(1 + totalReach / 35));
      const dunkRatio = replies >= 8 && replies > likes * 1.35 ? 1.2 : 0;
      const smallSignal = 1.0 - viralScale - dunkRatio; // +1 for quiet/organic, negative for mega-viral/dunk
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

    // 5. Local Reciprocity
    const authorKey = getCanonicalAuthorKey(item);
    if (s.reciprocity > 0 && authorKey) {
      const count = Number(interactedAuthors[authorKey] || 0);
      if (count > 0) {
        delta += (s.reciprocity / 100) * Math.min(2.6, Math.log2(1 + count) * 1.25);
      }
    }

    // 6. Content Balances (Commercial, Bourgeois Politics, Mature Content)
    if (s.commercial !== 0 && commercialSig > 0) {
      delta += (s.commercial / 100) * commercialSig * 3.2;
    }
    if (s.bourgeoisPolitics !== 0 && politicsSig > 0) {
      delta += (s.bourgeoisPolitics / 100) * politicsSig * 3.2;
    }
    if (s.matureContent !== 0 && matureSig > 0) {
      delta += (s.matureContent / 100) * matureSig * 3.2;
    }

    // 7. Semantic Concept Anchors (Lexical offline + optional local CPU vector blend)
    if (hasConceptAnchors) {
      const lex = scoreConceptLexical(item, profile.boostConcepts, profile.dampenConcepts);
      const vec = Number(semanticScores[item.id] ?? 0);
      let conceptSig = lex;
      if (Number.isFinite(vec) && vec !== 0) {
        conceptSig = lex !== 0 ? lex * 0.45 + vec * 0.55 : vec;
      }
      delta += conceptSig * 3.0;
    }

    scored.push({
      item,
      authorKey,
      publishedMs,
      baseScore: freshness + delta,
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
