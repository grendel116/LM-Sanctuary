const FALLBACK_LANGUAGE_NAMES = Object.freeze({
  ar: 'Arabic',
  be: 'Belarusian',
  bg: 'Bulgarian',
  ca: 'Catalan',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  et: 'Estonian',
  eu: 'Basque',
  fa: 'Persian',
  fi: 'Finnish',
  fr: 'French',
  gl: 'Galician',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  kk: 'Kazakh',
  ko: 'Korean',
  lt: 'Lithuanian',
  lv: 'Latvian',
  mk: 'Macedonian',
  mr: 'Marathi',
  ne: 'Nepali',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  ps: 'Pashto',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sa: 'Sanskrit',
  sk: 'Slovak',
  sl: 'Slovenian',
  sr: 'Serbian',
  sv: 'Swedish',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  ur: 'Urdu',
  vi: 'Vietnamese',
  yi: 'Yiddish',
  yue: 'Cantonese',
  zh: 'Chinese',
});

const ENGLISH_FUNCTION_WORDS = new Set([
  'the',
  'and',
  'that',
  'with',
  'this',
  'from',
  'have',
  'they',
  'what',
  'about',
  'would',
  'there',
  'their',
  'your',
  'which',
  'when',
  'were',
  'been',
  'into',
]);

const LATIN_LANG_PROFILES = Object.freeze([
  {
    code: 'es',
    words: new Set([
      'que', 'para', 'pero', 'porque', 'está', 'están', 'también', 'cómo',
      'dónde', 'buenos', 'días', 'noticias', 'trabajadores', 'sobre', 'entre',
      'todos', 'todas', 'hola', 'gracias', 'muy', 'aquí', 'ahora', 'mañana',
      'nuestra', 'nuestro', 'contra', 'desde', 'cuando', 'como', 'esto', 'esta',
    ]),
    exclusiveCharsRe: /[ñ¿¡]/gi,
    diacriticRe: /[áéíóúü]/gi,
  },
  {
    code: 'fr',
    words: new Set([
      'pour', 'avec', 'dans', 'sont', 'cette', 'mais', 'nous', 'vous',
      'tout', 'tous', 'très', 'même', 'être', 'avoir', 'faire', 'quoi',
      'bonjour', 'merci', 'aujourd', 'travailleurs', 'comme', 'entre', 'sans',
      'aussi', 'notre', 'votre', 'chez', 'dont', 'plus', 'elles', 'ils',
    ]),
    exclusiveCharsRe: /[œæêèùîïâûëÿ]/gi,
    diacriticRe: /[àéç]/gi,
  },
  {
    code: 'de',
    words: new Set([
      'und', 'nicht', 'auch', 'sich', 'aber', 'noch', 'wird', 'sind',
      'oder', 'für', 'über', 'durch', 'wenn', 'dass', 'sehr', 'heute',
      'guten', 'danke', 'menschen', 'arbeiter', 'eine', 'einen', 'einem',
      'einer', 'der', 'die', 'das', 'dem', 'den', 'des', 'wir', 'ihr',
    ]),
    exclusiveCharsRe: /[äöüß]/gi,
    diacriticRe: /[äöüß]/gi,
  },
  {
    code: 'pt',
    words: new Set([
      'não', 'você', 'vocês', 'para', 'com', 'mais', 'muito', 'obrigado',
      'obrigada', 'está', 'estão', 'tudo', 'hoje', 'bem', 'sobre', 'também',
      'ainda', 'trabalhadores', 'nosso', 'nossa', 'entre', 'quando', 'como',
      'isso', 'aqui', 'agora', 'todos', 'pela', 'pelo', 'dos', 'das',
    ]),
    exclusiveCharsRe: /[ãõ]/gi,
    diacriticRe: /[çáéíóúâêô]/gi,
  },
  {
    code: 'it',
    words: new Set([
      'che', 'non', 'per', 'sono', 'della', 'delle', 'degli', 'questo',
      'questa', 'anche', 'molto', 'tutto', 'tutti', 'grazie', 'buongiorno',
      'lavoratori', 'come', 'quando', 'sempre', 'oggi', 'perché', 'nostro',
      'nostra', 'dalla', 'nella', 'nelle', 'con', 'tra', 'sulla', 'cosa',
    ]),
    exclusiveCharsRe: /[ìò]/gi,
    diacriticRe: /[àèéìíîòóùú]/gi,
  },
]);

let cachedDisplayNames = null;
let displayNamesChecked = false;

function getDisplayNames() {
  if (!displayNamesChecked) {
    displayNamesChecked = true;
    try {
      if (typeof globalThis.Intl?.DisplayNames === 'function') {
        cachedDisplayNames = new globalThis.Intl.DisplayNames(['en'], { type: 'language' });
      }
    } catch {
      cachedDisplayNames = null;
    }
  }
  return cachedDisplayNames;
}

function cleanBcp47Tag(rawLang) {
  const clean = String(rawLang || '').trim().replace(/_/g, '-').toLowerCase();
  if (!clean) return '';
  if (clean === 'und' || clean.startsWith('und-') || clean === 'zxx' || clean === 'mul' || clean === 'mis') {
    return '';
  }
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(clean)) return '';
  return clean;
}

function getPrimarySubtag(tag) {
  const clean = cleanBcp47Tag(tag);
  if (!clean) return '';
  const primary = clean.split('-')[0];
  return primary === 'iw' ? 'he' : primary;
}

/**
 * Convert a BCP-47 language code into a human-readable English display name.
 * Returns an empty string for undetermined or unrecognized tags.
 * @param {string} langCode
 * @returns {string}
 */
export function resolveLanguageDisplayName(langCode) {
  const clean = cleanBcp47Tag(langCode);
  if (!clean) return '';
  const primary = getPrimarySubtag(clean);
  if (FALLBACK_LANGUAGE_NAMES[clean]) return FALLBACK_LANGUAGE_NAMES[clean];
  if (FALLBACK_LANGUAGE_NAMES[primary]) return FALLBACK_LANGUAGE_NAMES[primary];
  const intlNames = getDisplayNames();
  if (intlNames) {
    try {
      const label = intlNames.of(clean);
      if (label && label.toLowerCase() !== clean && label.toLowerCase() !== primary) {
        return label;
      }
      const primaryLabel = intlNames.of(primary);
      if (primaryLabel && primaryLabel.toLowerCase() !== primary) {
        return primaryLabel;
      }
    } catch {
      // Fall through
    }
  }
  return '';
}

function stripNonLinguisticTokens(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi, ' ')
    .replace(/(?:^|\s)@[\w.-]+(?:@[\w.-]+)?/g, ' ')
    .replace(/(?:^|\s)#[\p{L}\p{N}_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectNonLatinScript(cleanText, declaredPrimary, totalLetters) {
  const countMatches = (re) => (cleanText.match(re) || []).length;
  const kanaCount = countMatches(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangulCount = countMatches(/\p{Script=Hangul}/gu);
  const hanCount = countMatches(/\p{Script=Han}/gu);
  const greekCount = countMatches(/\p{Script=Greek}/gu);
  const hebrewCount = countMatches(/\p{Script=Hebrew}/gu);
  const thaiCount = countMatches(/\p{Script=Thai}/gu);
  const cyrillicCount = countMatches(/\p{Script=Cyrillic}/gu);
  const arabicCount = countMatches(/\p{Script=Arabic}/gu);
  const devanagariCount = countMatches(/\p{Script=Devanagari}/gu);

  const isDominant = (n) => n >= 2 && n / totalLetters >= 0.25;

  if (isDominant(kanaCount + (kanaCount > 0 ? hanCount : 0)) && kanaCount >= 2) {
    return { shouldOfferTranslate: true, langTag: 'ja', sourceHint: 'ja', languageName: resolveLanguageDisplayName('ja') };
  }
  if (isDominant(hangulCount)) {
    return { shouldOfferTranslate: true, langTag: 'ko', sourceHint: 'ko', languageName: resolveLanguageDisplayName('ko') };
  }
  if (isDominant(hanCount) && kanaCount === 0 && hangulCount === 0) {
    const tag = declaredPrimary === 'ja' || declaredPrimary === 'zh' || declaredPrimary === 'yue' ? declaredPrimary : 'zh';
    return { shouldOfferTranslate: true, langTag: tag, sourceHint: tag, languageName: resolveLanguageDisplayName(tag) };
  }
  if (isDominant(greekCount)) {
    return { shouldOfferTranslate: true, langTag: 'el', sourceHint: 'el', languageName: resolveLanguageDisplayName('el') };
  }
  if (isDominant(hebrewCount)) {
    const tag = declaredPrimary === 'he' || declaredPrimary === 'yi' ? declaredPrimary : 'he';
    return { shouldOfferTranslate: true, langTag: tag, sourceHint: tag, languageName: resolveLanguageDisplayName(tag) };
  }
  if (isDominant(thaiCount)) {
    return { shouldOfferTranslate: true, langTag: 'th', sourceHint: 'th', languageName: resolveLanguageDisplayName('th') };
  }
  if (isDominant(cyrillicCount)) {
    if (/[іїєґІЇЄҐ]/.test(cleanText)) {
      return { shouldOfferTranslate: true, langTag: 'uk', sourceHint: 'uk', languageName: resolveLanguageDisplayName('uk') };
    }
    if (['ru', 'uk', 'bg', 'sr', 'be', 'mk', 'kk'].includes(declaredPrimary)) {
      return { shouldOfferTranslate: true, langTag: declaredPrimary, sourceHint: declaredPrimary, languageName: resolveLanguageDisplayName(declaredPrimary) };
    }
    return { shouldOfferTranslate: true, langTag: '', sourceHint: 'auto', languageName: '' };
  }
  if (isDominant(arabicCount)) {
    if (['ar', 'fa', 'ur', 'ps', 'ku'].includes(declaredPrimary)) {
      return { shouldOfferTranslate: true, langTag: declaredPrimary, sourceHint: declaredPrimary, languageName: resolveLanguageDisplayName(declaredPrimary) };
    }
    return { shouldOfferTranslate: true, langTag: '', sourceHint: 'auto', languageName: '' };
  }
  if (isDominant(devanagariCount)) {
    if (['hi', 'mr', 'ne', 'sa'].includes(declaredPrimary)) {
      return { shouldOfferTranslate: true, langTag: declaredPrimary, sourceHint: declaredPrimary, languageName: resolveLanguageDisplayName(declaredPrimary) };
    }
    return { shouldOfferTranslate: true, langTag: '', sourceHint: 'auto', languageName: '' };
  }
  return null;
}

/**
 * Inspect a UnifiedItem or raw post to determine whether an inline translate button should be shown
 * alongside its BCP-47 language tag and human-readable display name.
 * @param {object} rawPost
 * @param {string} [targetLang='en']
 * @returns {{ shouldOfferTranslate: boolean, langTag: string, sourceHint: string, languageName: string }}
 */
export function detectPostLanguageInfo(rawPost, targetLang = 'en') {
  const empty = { shouldOfferTranslate: false, langTag: '', sourceHint: '', languageName: '' };
  if (!rawPost || typeof rawPost !== 'object') return empty;

  const targetPrimary = getPrimarySubtag(targetLang) || 'en';
  const spoilerText = rawPost?._meta?.mastodon?.spoilerText || rawPost?.spoilerText || '';
  const bodyText = rawPost?.content_text || rawPost?.text || '';
  const combinedText = [spoilerText, bodyText].filter(Boolean).join(' ');
  const cleanText = stripNonLinguisticTokens(combinedText);
  const letters = cleanText.match(/\p{L}/gu) || [];
  if (letters.length < 3) return empty;

  const declaredRaw =
    rawPost.language
    || (Array.isArray(rawPost.langs) ? rawPost.langs[0] : '')
    || rawPost._meta?.mastodon?.language
    || rawPost._meta?.bluesky?.language
    || '';
  const declaredTag = cleanBcp47Tag(declaredRaw);
  const declaredPrimary = getPrimarySubtag(declaredTag);

  const nonLatin = detectNonLatinScript(cleanText, declaredPrimary, letters.length);
  if (nonLatin) {
    return nonLatin.langTag && getPrimarySubtag(nonLatin.langTag) === targetPrimary ? empty : nonLatin;
  }

  const words = (cleanText.toLowerCase().match(/\p{L}[\p{L}'’]*/gu) || []).map((w) => w.replace(/['’]/g, ''));
  const englishHits = new Set(words.filter((w) => ENGLISH_FUNCTION_WORDS.has(w))).size;
  const hasNonAsciiLetter = letters.some((ch) => ch.charCodeAt(0) > 127);

  if (declaredPrimary && declaredPrimary !== targetPrimary) {
    if (words.length >= 6 && !hasNonAsciiLetter && englishHits >= 3) {
      return empty;
    }
    return {
      shouldOfferTranslate: true,
      langTag: declaredTag,
      sourceHint: declaredPrimary,
      languageName: resolveLanguageDisplayName(declaredTag),
    };
  }

  if (words.length >= 4) {
    let bestCode = '';
    let bestScore = 0;
    for (const profile of LATIN_LANG_PROFILES) {
      if (profile.code === targetPrimary) continue;
      let score = 0;
      for (const w of words) {
        if (profile.words.has(w)) score += 1;
      }
      if (profile.exclusiveCharsRe.test(cleanText)) {
        score += 1.5;
      } else if (score >= 1 && profile.diacriticRe.test(cleanText)) {
        score += 0.5;
      }
      profile.exclusiveCharsRe.lastIndex = 0;
      profile.diacriticRe.lastIndex = 0;
      if (score > bestScore) {
        bestScore = score;
        bestCode = profile.code;
      }
    }
    if (bestCode && bestScore >= 2 && (englishHits === 0 || bestScore >= englishHits * 3)) {
      return {
        shouldOfferTranslate: true,
        langTag: bestCode,
        sourceHint: bestCode,
        languageName: resolveLanguageDisplayName(bestCode),
      };
    }
  }

  return empty;
}
