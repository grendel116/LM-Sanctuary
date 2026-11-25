import { createEmojiPicker } from '../components/EmojiPickerPopover.js';
import { createEmbedCard, resolvePostEmbedCard } from '../components/EmbedCard.js';
import { openFollowGraphModal } from '../components/FollowGraphModal.js';
import { createOfflineNotice } from '../components/OfflineNotice.js';
import { createPostCard, PROTOCOL_LOGO_SVGS, syncPostCardReactions } from '../components/PostCard.js';
import { createClassicModalDialog, showAlert, showConfirm } from '../components/sanctuary/SanctuaryDialog.js';
import { createLoadingState } from '../components/ui/index.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { MASTODON_MAX_CHARS } from '../constants/endpoints.js';
import { formatApiErrorMessage } from '../queries/fetch/fetchWrapper.js';
import { hasRenderablePostContent } from '../core/schema/unifiedItem.js';
import {
  cleanMastodonMediaUrl,
  decodeHtmlEntities,
  extractFieldLinkUrl,
  formatCompactLinkLabel,
  renderProfileLinksAndFields,
  renderSanitizedHtml,
  verifyCredentials,
} from '../queries/fediverse.js';
import {
  deleteUnified,
  dismissBridgeRetry,
  editUnified,
  enrichUnifiedItemsMetrics,
  fetchAuthorWithRelationship,
  fetchOwnStatuses,
  likeUnified,
  pinUnified,
  repostUnified,
  runBridgeRetry,
  syncConnectedBlueskyProfile,
  syncRecentUserPostsToSanctuary,
  updateMastodonProfileCredentials,
} from '../queries/socialClient.js';
import { authStore, getAuthenticatedAccount, upsertSocialAccount } from '../state/authStore.js';
import { computeRemainingCounts, prefillReply } from '../state/composeStore.js';
import { applyPostInterestFeedback, mutatePostAcrossStreams, removePostAcrossStreams } from '../state/feedStore.js';
import { applyKnownMetrics, dropLinkedSiblings, hydrateMetricsLedger, recordItemMetrics } from '../state/metricsLedger.js';
import { connectionStore } from '../state/sanctuary/connection.js';
import { findLocalLinkedPostGroup, kvGet, kvSet } from '../storage/nativeStore.js';
import { summarizeAccountIdentity, syncAutoHeight } from './composeModal.js';

const PROFILE_TABS_CACHE_KV_KEY = 'profile_tabs_cache_v1';

const PROFILE_TABS = [
  ['posts', 'Posts'],
  ['replies', 'Replies'],
  ['media', 'Media'],
  ['boosts', 'Boosts'],
];

function sortOwnPostsPinnedFirst(items = []) {
  return [...items].sort((a, b) => {
    const aPin = Boolean(a?._meta?.mastodon?.pinned) ? 1 : 0;
    const bPin = Boolean(b?._meta?.mastodon?.pinned) ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    return (Date.parse(b?.date_published || '') || 0) - (Date.parse(a?.date_published || '') || 0);
  });
}

const LANGUAGE_OPTIONS = [
  ['en', 'English (en)'],
  ['es', 'Spanish (es)'],
  ['fr', 'French (fr)'],
  ['de', 'German (de)'],
  ['pt', 'Portuguese (pt)'],
  ['it', 'Italian (it)'],
  ['nl', 'Dutch (nl)'],
  ['pl', 'Polish (pl)'],
  ['ru', 'Russian (ru)'],
  ['ja', 'Japanese (ja)'],
  ['ko', 'Korean (ko)'],
  ['zh', 'Chinese (zh)'],
  ['ar', 'Arabic (ar)'],
  ['hi', 'Hindi (hi)'],
];

/**
 * Open the consolidated native Profile Studio dialog
 * (Mastodon update_credentials + optional Bluesky app.bsky.actor.profile/link sync).
 */
export function openEditMastodonProfileModal({ accountMeta, onSaved } = {}) {
  const doc = globalThis.document;
  const meta = accountMeta || {};
  const isBskyConnected = Boolean(authStore.get().isBlueskyConnected);
  const bskyAccountMeta = (authStore.get().accounts || []).find((a) => a.platform === 'bluesky') || null;
  let closed = false;
  let activeTab = 'media';
  const objectUrls = [];
  let avatarPreviewUrl = cleanMastodonMediaUrl(meta.avatar);
  let bannerPreviewUrl = cleanMastodonMediaUrl(meta.header);
  let selectedAvatarFile = null;
  let selectedHeaderFile = null;
  let removeAvatar = false;
  let removeHeader = false;

  const modal = createClassicModalDialog({
    id: 'edit-mastodon-profile-dialog',
    maxWidth: '600px',
    onClose: () => {
      closed = true;
      for (const u of objectUrls) {
        try {
          globalThis.URL?.revokeObjectURL?.(u);
        } catch {
          // Ignore URL cleanup error in restricted runtimes
        }
      }
      modal.dialog.remove();
    },
  });

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'classic-modal-title';
  heading.textContent = isBskyConnected ? 'Edit Profile (Mastodon & Bluesky)' : 'Edit Profile';

  const tabBar = doc.createElement('div');
  tabBar.className = 'classic-modal-tabs';
  const tabButtons = new Map();
  for (const [tabId, label] of [
    ['media', 'Profile & Media'],
    ['privacy', 'Privacy & Posting'],
  ]) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `modal-tab-btn${tabId === activeTab ? ' active' : ''}`;
    btn.dataset.profileEditTab = tabId;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      activeTab = tabId;
      syncTabs();
    });
    tabBar.appendChild(btn);
    tabButtons.set(tabId, btn);
  }

  const form = doc.createElement('form');
  form.className = 'profile-edit-form';
  form.noValidate = true;

  const scrollBody = doc.createElement('div');
  scrollBody.className = 'classic-modal-scroll-body';

  const mkGroup = (id, label, inputEl) => {
    const grp = doc.createElement('div');
    grp.className = 'input-group';
    const lbl = doc.createElement('label');
    lbl.setAttribute('for', id);
    lbl.textContent = label;
    inputEl.id = id;
    grp.append(lbl, inputEl);
    return grp;
  };

  const mkSelectGroup = (id, label, optionsList, currentValue) => {
    const sel = doc.createElement('select');
    sel.className = 'onboarding-input glass-select';
    const list = [...optionsList];
    const cleanVal = String(currentValue || list[0]?.[0] || '');
    if (cleanVal && !list.some(([v]) => v === cleanVal)) {
      list.unshift([cleanVal, cleanVal]);
    }
    for (const [val, lbl] of list) {
      const opt = doc.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      opt.selected = cleanVal === val;
      sel.appendChild(opt);
    }
    sel.value = cleanVal;
    return { group: mkGroup(id, label, sel), select: sel };
  };

  const mkSwitchRow = ({ id, title, subtitle, checked }) => {
    const row = doc.createElement('label');
    row.className = 'switch-container';
    row.setAttribute('for', id);

    const textCol = doc.createElement('div');
    textCol.className = 'switch-label-group';
    const titleEl = doc.createElement('span');
    titleEl.className = 'switch-title';
    titleEl.textContent = title;
    const subEl = doc.createElement('span');
    subEl.className = 'switch-subtitle';
    subEl.textContent = subtitle;
    textCol.append(titleEl, subEl);

    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.className = 'switch-input';
    input.setAttribute('switch', '');
    const hasNativeSwitch = typeof globalThis.HTMLInputElement?.prototype === 'object'
      && 'switch' in globalThis.HTMLInputElement.prototype;
    if (!hasNativeSwitch) input.setAttribute('role', 'switch');
    input.checked = Boolean(checked);

    const track = doc.createElement('span');
    track.className = 'switch-track';
    track.setAttribute('aria-hidden', 'true');
    const thumb = doc.createElement('span');
    thumb.className = 'switch-thumb';
    track.appendChild(thumb);

    row.append(textCol, input, track);
    return { row, input };
  };

  // Panel 1: Profile & Media
  const mediaPanel = doc.createElement('div');
  mediaPanel.className = 'classic-cards-stack';

  const mediaHero = doc.createElement('div');
  mediaHero.className = 'profile-edit-media-hero';

  const bannerWrap = doc.createElement('div');
  bannerWrap.className = 'profile-edit-banner-wrap';

  const bannerImg = doc.createElement('img');
  bannerImg.className = 'profile-banner-img';
  bannerImg.alt = 'Header banner preview';

  const bannerPlaceholder = doc.createElement('div');
  bannerPlaceholder.className = 'profile-edit-banner-placeholder';
  bannerPlaceholder.textContent = 'No header banner set';

  const headerFileIn = doc.createElement('input');
  headerFileIn.type = 'file';
  headerFileIn.id = 'edit-masto-header';
  headerFileIn.accept = 'image/*';
  headerFileIn.hidden = true;

  const bannerActions = doc.createElement('div');
  bannerActions.className = 'profile-edit-banner-actions';
  const changeBannerBtn = doc.createElement('button');
  changeBannerBtn.type = 'button';
  changeBannerBtn.className = 'messages-header-pill';
  changeBannerBtn.textContent = 'Change Banner';
  changeBannerBtn.addEventListener('click', () => headerFileIn.click());

  const removeBannerBtn = doc.createElement('button');
  removeBannerBtn.type = 'button';
  removeBannerBtn.className = 'edit-btn edit-cancel-btn';
  removeBannerBtn.textContent = 'Remove';
  removeBannerBtn.addEventListener('click', () => {
    selectedHeaderFile = null;
    headerFileIn.value = '';
    bannerPreviewUrl = '';
    removeHeader = true;
    syncMediaPreviews();
  });
  bannerActions.append(changeBannerBtn, removeBannerBtn);
  bannerWrap.append(bannerImg, bannerPlaceholder, bannerActions, headerFileIn);

  const avatarRow = doc.createElement('div');
  avatarRow.className = 'profile-edit-avatar-row';

  const avatarPreviewImg = doc.createElement('img');
  avatarPreviewImg.className = 'profile-edit-avatar-preview';
  avatarPreviewImg.alt = 'Avatar preview';

  const avatarFileIn = doc.createElement('input');
  avatarFileIn.type = 'file';
  avatarFileIn.id = 'edit-masto-avatar';
  avatarFileIn.accept = 'image/*';
  avatarFileIn.hidden = true;

  const avatarControls = doc.createElement('div');
  avatarControls.className = 'profile-edit-avatar-controls';
  const avatarBtnRow = doc.createElement('div');
  avatarBtnRow.className = 'classic-card-actions';

  const changeAvatarBtn = doc.createElement('button');
  changeAvatarBtn.type = 'button';
  changeAvatarBtn.className = 'messages-header-pill';
  changeAvatarBtn.textContent = 'Change Avatar';
  changeAvatarBtn.addEventListener('click', () => avatarFileIn.click());

  const removeAvatarBtn = doc.createElement('button');
  removeAvatarBtn.type = 'button';
  removeAvatarBtn.className = 'edit-btn edit-cancel-btn';
  removeAvatarBtn.textContent = 'Remove';
  removeAvatarBtn.addEventListener('click', () => {
    selectedAvatarFile = null;
    avatarFileIn.value = '';
    avatarPreviewUrl = '';
    removeAvatar = true;
    syncMediaPreviews();
  });

  const mediaHint = doc.createElement('span');
  mediaHint.className = 'classic-card-subtext';
  mediaHint.textContent = 'PNG, GIF, or JPEG · 400×400 avatar / 1500×500 banner recommended';

  avatarBtnRow.append(changeAvatarBtn, removeAvatarBtn);
  avatarControls.append(avatarBtnRow, mediaHint);
  avatarRow.append(avatarPreviewImg, avatarControls, avatarFileIn);
  mediaHero.append(bannerWrap, avatarRow);

  function syncMediaPreviews() {
    if (bannerPreviewUrl) {
      bannerImg.src = bannerPreviewUrl;
      bannerImg.hidden = false;
      bannerPlaceholder.hidden = true;
      removeBannerBtn.hidden = false;
    } else {
      bannerImg.removeAttribute('src');
      bannerImg.hidden = true;
      bannerPlaceholder.hidden = false;
      removeBannerBtn.hidden = true;
    }
    const hasCustomAvatar = Boolean(avatarPreviewUrl);
    avatarPreviewImg.src = avatarPreviewUrl || DEFAULT_AVATAR_DATA_URI;
    removeAvatarBtn.hidden = !hasCustomAvatar;
  }

  avatarFileIn.addEventListener('change', () => {
    const file = avatarFileIn.files?.[0] || null;
    if (!file) return;
    selectedAvatarFile = file;
    removeAvatar = false;
    if (typeof globalThis.URL?.createObjectURL === 'function') {
      const url = globalThis.URL.createObjectURL(file);
      objectUrls.push(url);
      avatarPreviewUrl = url;
    }
    syncMediaPreviews();
  });

  headerFileIn.addEventListener('change', () => {
    const file = headerFileIn.files?.[0] || null;
    if (!file) return;
    selectedHeaderFile = file;
    removeHeader = false;
    if (typeof globalThis.URL?.createObjectURL === 'function') {
      const url = globalThis.URL.createObjectURL(file);
      objectUrls.push(url);
      bannerPreviewUrl = url;
    }
    syncMediaPreviews();
  });
  syncMediaPreviews();

  const identityCard = doc.createElement('div');
  identityCard.className = 'form-card-container';

  const nameIn = doc.createElement('input');
  nameIn.type = 'text';
  nameIn.name = 'display_name';
  nameIn.className = 'onboarding-input';
  nameIn.maxLength = 30;
  nameIn.value = meta.displayName || '';
  nameIn.placeholder = 'Your public display name';
  nameIn.setAttribute('autofocus', '');

  const bioIn = doc.createElement('textarea');
  bioIn.name = 'note';
  bioIn.rows = 4;
  bioIn.maxLength = 500;
  bioIn.className = 'onboarding-input';
  bioIn.value = decodeHtmlEntities(meta.noteText || '');
  bioIn.placeholder = 'Tell people who you are...';

  const bioGroup = mkGroup('edit-masto-note', 'Bio', bioIn);
  const bioCounter = doc.createElement('span');
  bioCounter.className = 'profile-bio-counter';
  const updateBioCounter = () => {
    bioCounter.textContent = isBskyConnected
      ? `${bioIn.value.length} / 500 · Bluesky syncs first 256 chars`
      : `${bioIn.value.length} / 500`;
  };
  bioIn.addEventListener('input', updateBioCounter);
  updateBioCounter();
  bioGroup.appendChild(bioCounter);

  // Compact consolidated Links editor right under Bio (up to 4 links or labels)
  const linksSection = doc.createElement('div');
  linksSection.className = 'profile-links-editor';
  const linksHead = doc.createElement('div');
  linksHead.className = 'profile-links-header';
  const linksLbl = doc.createElement('span');
  linksLbl.className = 'onboarding-label';
  linksLbl.textContent = isBskyConnected ? 'Links & Labels (Mastodon & Bluesky)' : 'Links & Labels';
  const addLinkBtn = doc.createElement('button');
  addLinkBtn.type = 'button';
  addLinkBtn.className = 'edit-btn profile-add-link-btn';
  addLinkBtn.textContent = '+ Add Link';
  linksHead.append(linksLbl, addLinkBtn);

  const linksRowsHost = doc.createElement('div');
  linksRowsHost.className = 'profile-links-rows';

  const existingFields = Array.isArray(meta.fields) ? meta.fields : [];
  const populatedFields = existingFields.filter((f) => String(f?.name || '').trim() || String(f?.value || '').trim());
  const linkRowModels = [];

  function syncAddLinkBtn() {
    addLinkBtn.hidden = linkRowModels.length >= 4;
  }

  function addLinkEditorRow(initial = { name: '', value: '', verified_at: null }) {
    if (linkRowModels.length >= 4) return;
    const rowIdx = linkRowModels.length;
    const rowEl = doc.createElement('div');
    rowEl.className = 'profile-link-edit-row';

    const kIn = doc.createElement('input');
    kIn.type = 'text';
    kIn.id = `edit-masto-field-name-${rowIdx}`;
    kIn.className = 'onboarding-input';
    kIn.placeholder = 'Label (e.g. Website)';
    kIn.maxLength = 255;
    kIn.value = decodeHtmlEntities(String(initial.name || ''));
    kIn.setAttribute('aria-label', `Link label ${rowIdx + 1}`);

    const vIn = doc.createElement('input');
    vIn.type = 'text';
    vIn.id = `edit-masto-field-val-${rowIdx}`;
    vIn.className = 'onboarding-input';
    vIn.placeholder = 'https://example.org';
    vIn.maxLength = 255;
    vIn.value = decodeHtmlEntities(String(initial.value || ''));
    vIn.setAttribute('aria-label', `Link URL or value ${rowIdx + 1}`);
    vIn.setAttribute('autocorrect', 'off');
    vIn.setAttribute('autocapitalize', 'none');
    vIn.setAttribute('spellcheck', 'false');

    const model = { rowEl, kIn, vIn };
    linkRowModels.push(model);
    rowEl.append(kIn, vIn);

    if (initial.verified_at) {
      const vBadge = doc.createElement('span');
      vBadge.className = 'profile-verified-check';
      vBadge.title = 'Verified via rel="me"';
      vBadge.textContent = '✓';
      rowEl.appendChild(vBadge);
    }

    const delBtn = doc.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'edit-btn edit-cancel-btn profile-link-remove-btn';
    delBtn.textContent = '×';
    delBtn.setAttribute('aria-label', `Remove link ${rowIdx + 1}`);
    delBtn.addEventListener('click', () => {
      const idx = linkRowModels.indexOf(model);
      if (idx >= 0) linkRowModels.splice(idx, 1);
      rowEl.remove();
      syncAddLinkBtn();
    });
    rowEl.appendChild(delBtn);

    linksRowsHost.appendChild(rowEl);
    syncAddLinkBtn();
  }

  addLinkBtn.addEventListener('click', () => addLinkEditorRow());

  if (populatedFields.length > 0) {
    for (const f of populatedFields.slice(0, 4)) {
      addLinkEditorRow(f);
    }
  } else {
    addLinkEditorRow();
  }

  linksSection.append(linksHead, linksRowsHost);

  identityCard.append(
    mkGroup('edit-masto-display-name', 'Display Name', nameIn),
    bioGroup,
    linksSection
  );
  mediaPanel.append(mediaHero, identityCard);

  // Panel 2: Privacy & Posting (includes collapsed Link Verification & Author Attribution)
  const privacyPanel = doc.createElement('div');
  privacyPanel.className = 'classic-cards-stack';

  const defaultsCard = doc.createElement('div');
  defaultsCard.className = 'form-card-container';
  const defaultsHead = doc.createElement('div');
  defaultsHead.className = 'modal-section-header';
  const defaultsTitle = doc.createElement('span');
  defaultsTitle.textContent = 'Posting Defaults';
  defaultsHead.appendChild(defaultsTitle);

  const { group: visGroup, select: visSelect } = mkSelectGroup(
    'edit-masto-visibility',
    'Default Post Visibility',
    [
      ['public', 'Public'],
      ['unlisted', 'Unlisted'],
      ['private', 'Followers only'],
      ['direct', 'Mentioned only'],
    ],
    meta.defaultVisibility || 'public'
  );
  visSelect.name = 'default_visibility';

  const { group: langGroup, select: langSelect } = mkSelectGroup(
    'edit-masto-language',
    'Default Post Language',
    LANGUAGE_OPTIONS,
    meta.defaultLanguage || 'en'
  );
  langSelect.name = 'default_language';

  const defaultsGrid = doc.createElement('div');
  defaultsGrid.className = 'classic-two-col';
  defaultsGrid.append(visGroup, langGroup);
  defaultsCard.append(defaultsHead, defaultsGrid);

  const prefsCard = doc.createElement('div');
  prefsCard.className = 'form-card-container';
  const prefsHead = doc.createElement('div');
  prefsHead.className = 'modal-section-header';
  const prefsTitle = doc.createElement('span');
  prefsTitle.textContent = 'Privacy, Discovery & ActivityPub Flags';
  prefsHead.appendChild(prefsTitle);

  const sensitiveSw = mkSwitchRow({
    id: 'edit-masto-sensitive',
    title: 'Always mark media as sensitive',
    subtitle: 'Hide attached media behind a content warning by default.',
    checked: Boolean(meta.defaultSensitive),
  });
  const lockedSw = mkSwitchRow({
    id: 'edit-masto-locked',
    title: 'Require follow requests (Locked account)',
    subtitle: 'Manually approve new followers before they receive private posts.',
    checked: Boolean(meta.locked),
  });
  const discSw = mkSwitchRow({
    id: 'edit-masto-discoverable',
    title: 'Feature account in directory discovery',
    subtitle: 'List your profile in server directories and suggestions.',
    checked: meta.discoverable !== false,
  });
  const indexSw = mkSwitchRow({
    id: 'edit-masto-indexable',
    title: 'Include public posts in search results',
    subtitle: 'Allow Mastodon full-text search to index your public posts.',
    checked: meta.indexable !== false,
  });
  const bskyPubSw = isBskyConnected
    ? mkSwitchRow({
        id: 'edit-bsky-public-visible',
        title: 'Allow logged-out & Jetstream public visibility (Bluesky)',
        subtitle: 'Let unauthenticated readers and public Bluesky streams view your profile and posts.',
        checked: bskyAccountMeta?.publicVisible !== false,
      })
    : null;
  const hideCollSw = mkSwitchRow({
    id: 'edit-masto-hide-collections',
    title: 'Hide follower and following lists',
    subtitle: 'Display follower counts without exposing the account lists.',
    checked: Boolean(meta.hideCollections),
  });
  const botSw = mkSwitchRow({
    id: 'edit-masto-bot',
    title: 'Automated account (Bot badge)',
    subtitle: 'Mark this profile as an automated ActivityPub account.',
    checked: Boolean(meta.bot),
  });

  prefsCard.append(
    prefsHead,
    sensitiveSw.row,
    lockedSw.row,
    discSw.row,
    indexSw.row,
    ...(bskyPubSw ? [bskyPubSw.row] : []),
    hideCollSw.row,
    botSw.row
  );

  // Collapsed disclosure for optional Website Verification & Author Attribution
  const verifyDetails = doc.createElement('details');
  verifyDetails.className = 'profile-advanced-disclosure';
  const verifySummary = doc.createElement('summary');
  verifySummary.className = 'profile-advanced-summary';
  verifySummary.textContent = 'Link Verification & Author Attribution (Optional)';
  const verifyBody = doc.createElement('div');
  verifyBody.className = 'profile-advanced-body';

  const verifyIntro = doc.createElement('p');
  verifyIntro.className = 'account-card-hint';
  verifyIntro.textContent = "Optional website ownership checks for Mastodon: paste the HTML tag into your personal site's <head> to show a green ✓ next to your link, or list domains allowed to credit your handle on shared articles (fediverse:creator).";
  verifyBody.appendChild(verifyIntro);

  const profileUrl = meta.url
    || (meta.instanceUrl && meta.handle
      ? `${String(meta.instanceUrl).replace(/\/+$/, '')}/@${String(meta.handle).replace(/^@/, '')}`
      : '');
  if (profileUrl) {
    const relTag = `<link rel="me" href="${profileUrl}">`;
    const copyRow = doc.createElement('div');
    copyRow.className = 'list-create-row';
    const tagInput = doc.createElement('input');
    tagInput.type = 'text';
    tagInput.readOnly = true;
    tagInput.className = 'onboarding-input';
    tagInput.value = relTag;
    tagInput.setAttribute('aria-label', 'Verification HTML tag');
    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-sleek-pill';
    copyBtn.textContent = 'Copy Tag';
    copyBtn.addEventListener('click', async () => {
      try {
        await globalThis.navigator?.clipboard?.writeText?.(relTag);
        copyBtn.textContent = 'Copied';
      } catch {
        tagInput.select?.();
      }
    });
    copyRow.append(tagInput, copyBtn);
    verifyBody.appendChild(copyRow);
  }

  const attrIn = doc.createElement('input');
  attrIn.type = 'text';
  attrIn.className = 'onboarding-input';
  attrIn.placeholder = 'e.g. institute.coop, example.org';
  attrIn.value = Array.isArray(meta.attributionDomains) ? meta.attributionDomains.join(', ') : '';
  attrIn.setAttribute('autocorrect', 'off');
  attrIn.setAttribute('autocapitalize', 'none');
  attrIn.setAttribute('spellcheck', 'false');
  verifyBody.appendChild(mkGroup('edit-masto-attribution-domains', 'Author Attribution Domains (fediverse:creator)', attrIn));

  verifyDetails.append(verifySummary, verifyBody);
  privacyPanel.append(defaultsCard, prefsCard, verifyDetails);

  scrollBody.append(mediaPanel, privacyPanel);

  function syncTabs() {
    for (const [id, btn] of tabButtons.entries()) {
      btn.classList.toggle('active', id === activeTab);
    }
    mediaPanel.hidden = activeTab !== 'media';
    privacyPanel.hidden = activeTab !== 'privacy';
  }
  syncTabs();

  const statusEl = doc.createElement('p');
  statusEl.className = 'classic-modal-status';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');
  statusEl.hidden = true;

  const actionsRow = doc.createElement('div');
  actionsRow.className = 'classic-modal-footer-end';
  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'edit-btn edit-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => modal.close());

  const saveBtn = doc.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn-sleek-pill';
  saveBtn.textContent = 'Save Profile';
  actionsRow.append(cancelBtn, saveBtn);

  form.append(scrollBody, statusEl, actionsRow);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    statusEl.hidden = false;
    statusEl.textContent = 'Saving profile...';
    const attributionDomains = attrIn.value
      .split(',')
      .map((d) => d.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    const submittedFields = linkRowModels
      .map(({ kIn, vIn }) => {
        const rawVal = vIn.value.trim();
        const rawName = kIn.value.trim();
        if (!rawName && !rawVal) return null;
        const href = extractFieldLinkUrl(rawVal);
        return {
          name: rawName || (href ? formatCompactLinkLabel('', href) : 'Link'),
          value: rawVal,
        };
      })
      .filter(Boolean)
      .slice(0, 4);
    const avatarFile = selectedAvatarFile || avatarFileIn.files?.[0] || null;
    const headerFile = selectedHeaderFile || headerFileIn.files?.[0] || null;
    try {
      const updated = await updateMastodonProfileCredentials({
        displayName: nameIn.value,
        note: bioIn.value,
        locked: lockedSw.input.checked,
        bot: botSw.input.checked,
        discoverable: discSw.input.checked,
        indexable: indexSw.input.checked,
        hideCollections: hideCollSw.input.checked,
        defaultVisibility: visSelect.value,
        defaultSensitive: sensitiveSw.input.checked,
        defaultLanguage: langSelect.value,
        fields: submittedFields,
        attributionDomains,
        avatarFile,
        headerFile,
        removeAvatar,
        removeHeader,
      });
      await upsertSocialAccount({
        id: meta.id || `fediverse:${updated.acct}`,
        platform: 'fediverse',
        instanceUrl: meta.instanceUrl,
        handle: updated.username,
        acct: updated.acct,
        displayName: updated.displayName,
        avatar: removeAvatar && !selectedAvatarFile ? '' : cleanMastodonMediaUrl(updated.avatar),
        header: removeHeader && !selectedHeaderFile ? '' : cleanMastodonMediaUrl(updated.header),
        url: updated.url,
        note: updated.note,
        noteText: updated.noteText,
        fields: updated.fields,
        locked: updated.locked,
        bot: updated.bot,
        discoverable: updated.discoverable,
        indexable: updated.indexable,
        hideCollections: updated.hideCollections,
        defaultVisibility: updated.defaultVisibility,
        defaultSensitive: updated.defaultSensitive,
        defaultLanguage: updated.defaultLanguage,
        attributionDomains: updated.attributionDomains || [],
        emojis: updated.emojis || [],
        followersCount: updated.followersCount,
        followingCount: updated.followingCount,
        statusesCount: updated.statusesCount,
        userId: updated.id,
      });

      let bskyWarning = '';
      if (isBskyConnected && !closed) {
        statusEl.textContent = 'Syncing profile with Bluesky...';
        try {
          await syncConnectedBlueskyProfile({
            displayName: nameIn.value,
            note: bioIn.value,
            fields: submittedFields,
            publicVisible: bskyPubSw ? bskyPubSw.input.checked : undefined,
            avatarFile,
            headerFile,
            removeAvatar,
            removeHeader,
          });
        } catch (bskyErr) {
          bskyWarning = bskyErr?.message || 'Bluesky sync failed.';
        }
      }

      if (!closed) {
        if (bskyWarning) {
          await onSaved?.(updated);
          statusEl.hidden = false;
          statusEl.textContent = `Mastodon profile saved, but Bluesky sync failed: ${bskyWarning}`;
        } else {
          modal.close();
          await onSaved?.(updated);
        }
      }
    } catch (err) {
      statusEl.hidden = false;
      statusEl.textContent = err?.message || 'Unable to update profile.';
    } finally {
      saveBtn.disabled = false;
    }
  });

  modal.card.append(heading, tabBar, form);
  modal.open();
  return modal;
}

export function openEditPostDialog(post, { onSaved } = {}) {
  const doc = globalThis.document;
  let emojiPicker = null;
  let closed = false;
  const modal = createClassicModalDialog({
    id: 'edit-post-dialog',
    maxWidth: '560px',
    closedBy: 'any',
    onClose: () => {
      closed = true;
      emojiPicker?.close?.();
      modal.dialog.remove();
    },
  });
  modal.closeBtn.hidden = true;
  modal.card.classList.add('compose-sheet-card');

  const authState = authStore.get();
  const fallbackIdentity = summarizeAccountIdentity(authState.accounts || []);
  const mastoMeta = post?._meta?.mastodon || {};
  const isBskyPost = post?.protocol === 'bluesky' || String(post?.id || '').startsWith('bluesky:');
  const matchingAccount = (authState.accounts || []).find((a) =>
    isBskyPost ? a.platform === 'bluesky' : (a.platform === 'fediverse' || a.platform === 'mastodon')
  ) || null;
  const handle = String(
    post?.author?.acct
    || post?.author?.handle
    || matchingAccount?.acct
    || matchingAccount?.handle
    || fallbackIdentity.handle
    || 'You'
  ).replace(/^@/, '');
  const avatarUrl = post?.author?.avatar || matchingAccount?.avatar || fallbackIdentity.avatarUrl;

  const spoiler = String(mastoMeta.spoilerText || post?.spoilerText || '');
  const visibility = String(mastoMeta.visibility || 'public').toLowerCase();
  const linked = post?._meta?.linkedIds || {};
  let hasLinkedBsky = Boolean(linked.blueskyUri);
  let hasLinkedThreads = Boolean(linked.threadsPostId);
  const attachments = Array.isArray(post?.attachments) ? post.attachments : [];
  const initialText = String(post?.content_text || '');
  let submitting = false;

  const form = doc.createElement('form');
  form.className = 'compose-sheet-form';

  const header = doc.createElement('header');
  header.className = 'compose-sheet-header';

  const cancelBtn = doc.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'compose-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => modal.close());

  const heading = doc.createElement('h3');
  heading.id = modal.titleId;
  heading.className = 'compose-sheet-title';
  heading.textContent = 'Edit post';

  const countsEl = doc.createElement('span');
  countsEl.className = 'compose-counts';
  countsEl.setAttribute('aria-live', 'polite');

  header.append(cancelBtn, heading, countsEl);

  const body = doc.createElement('div');
  body.className = 'compose-sheet-body';

  const unit = doc.createElement('div');
  unit.className = 'compose-thread-unit';

  const avatarCol = doc.createElement('div');
  avatarCol.className = 'compose-avatar-col';
  const avImg = doc.createElement('img');
  avImg.className = 'compose-user-avatar';
  avImg.alt = '';
  avImg.src = avatarUrl;
  const rail = doc.createElement('div');
  rail.className = 'compose-thread-rail';
  rail.style.opacity = '0.25';
  avatarCol.append(avImg, rail);

  const editorCol = doc.createElement('div');
  editorCol.className = 'compose-editor-col';

  const authorLine = doc.createElement('div');
  authorLine.className = 'compose-author-line';
  const handleEl = doc.createElement('span');
  handleEl.className = 'compose-author-handle';
  handleEl.textContent = handle;
  const destEl = doc.createElement('span');
  destEl.className = 'compose-author-dest';
  authorLine.append(handleEl, destEl);

  const taLbl = doc.createElement('label');
  taLbl.setAttribute('for', 'edit-post-textarea');
  taLbl.className = 'sr-only';
  taLbl.textContent = 'Post text';

  const ta = doc.createElement('textarea');
  ta.id = 'edit-post-textarea';
  ta.name = 'text';
  ta.rows = 3;
  ta.className = 'compose-seamless-textarea';
  ta.placeholder = 'Edit post...';
  ta.value = initialText;
  ta.setAttribute('autofocus', '');

  let caretStart = ta.value.length;
  let caretEnd = ta.value.length;
  const captureCaret = () => {
    if (typeof ta.selectionStart === 'number') {
      caretStart = ta.selectionStart;
      caretEnd = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : ta.selectionStart;
    } else {
      caretStart = ta.value.length;
      caretEnd = ta.value.length;
    }
  };
  for (const evt of ['focus', 'keyup', 'mouseup', 'blur']) {
    ta.addEventListener(evt, captureCaret);
  }

  editorCol.append(authorLine, taLbl, ta);

  if (attachments.length > 0) {
    const strip = doc.createElement('div');
    strip.className = 'edit-readonly-media-strip';
    for (const att of attachments.slice(0, 4)) {
      const thumbUrl = cleanMastodonMediaUrl(att.previewUrl || att.url || '');
      if (!thumbUrl) continue;
      const img = doc.createElement('img');
      img.className = 'edit-readonly-media-thumb';
      img.src = thumbUrl;
      img.alt = att.alt_text || att.description || '';
      strip.appendChild(img);
    }
    if (strip.childNodes.length > 0) {
      editorCol.appendChild(strip);
    }
  } else {
    const embedCard = resolvePostEmbedCard(post);
    if (embedCard) {
      const cardNode = createEmbedCard(embedCard, { compact: true });
      if (cardNode) {
        const previewHost = doc.createElement('div');
        previewHost.className = 'compose-link-preview-host';
        previewHost.appendChild(cardNode);
        editorCol.appendChild(previewHost);
      }
    }
  }

  const inlineTools = doc.createElement('div');
  inlineTools.className = 'compose-inline-tools';
  emojiPicker = createEmojiPicker({
    popoverId: 'edit-post-emoji-popover',
    onSelectEmoji: (emoji) => {
      const cur = String(ta.value || '');
      const sIdx = Math.max(0, Math.min(caretStart, cur.length));
      const eIdx = Math.max(sIdx, Math.min(caretEnd, cur.length));
      const nextText = `${cur.slice(0, sIdx)}${emoji}${cur.slice(eIdx)}`;
      const nextPos = sIdx + emoji.length;
      caretStart = nextPos;
      caretEnd = nextPos;
      ta.value = nextText;
      updateComposerMetrics();
      ta.focus?.();
      ta.setSelectionRange?.(nextPos, nextPos);
    },
  });
  inlineTools.append(emojiPicker.triggerBtn, emojiPicker.panel);
  editorCol.appendChild(inlineTools);

  unit.append(avatarCol, editorCol);
  body.appendChild(unit);

  const footer = doc.createElement('footer');
  footer.className = 'compose-sheet-footer';

  const statusEl = doc.createElement('p');
  statusEl.className = 'compose-status-msg';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  const saveBtn = doc.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'compose-publish-btn';
  saveBtn.textContent = 'Update';

  footer.append(statusEl, saveBtn);
  form.append(header, body, footer);

  function updateComposerMetrics() {
    syncAutoHeight(ta, 68, 340);
    const syncBsky = !isBskyPost && visibility !== 'direct' && hasLinkedBsky && Boolean(authState.isBlueskyConnected);
    const syncThreads = !isBskyPost && visibility !== 'direct' && hasLinkedThreads && Boolean(authState.isThreadsConnected);

    if (isBskyPost) {
      destEl.textContent = 'Bluesky';
    } else if (visibility === 'direct') {
      destEl.textContent = 'Direct message';
    } else {
      destEl.textContent = ['Fediverse', syncBsky ? 'Bluesky' : '', syncThreads ? 'Threads' : '']
        .filter(Boolean)
        .join(' · ');
    }

    const counts = computeRemainingCounts(
      { text: ta.value, spoilerText: spoiler },
      { isBlueskyConnected: isBskyPost || syncBsky, isThreadsConnected: syncThreads }
    );
    const remaining = isBskyPost ? counts.bluesky : counts.tightestRemaining;
    countsEl.textContent = String(remaining);
    countsEl.classList.toggle('is-over-limit', remaining < 0);

    const overLimit = isBskyPost
      ? counts.bluesky < 0
      : ([...(ta.value || '')].length + [...spoiler].length > MASTODON_MAX_CHARS);
    const hasContent = Boolean(ta.value.trim() || attachments.length > 0);
    const isChanged = ta.value !== initialText;
    const isReady = !submitting && hasContent && !overLimit && isChanged;
    saveBtn.disabled = !isReady;
    saveBtn.classList.toggle('is-ready', isReady);
  }

  ta.addEventListener('input', () => {
    captureCaret();
    updateComposerMetrics();
  });

  if (!isBskyPost && visibility !== 'direct') {
    const canonId = post?.id || (mastoMeta.statusId ? `mastodon:${mastoMeta.statusId}` : '');
    if (canonId) {
      void findLocalLinkedPostGroup(canonId).then((group) => {
        if (closed || !Array.isArray(group) || group.length === 0) return;
        const foundBsky = group.some((g) => Boolean(g?.blueskyUri));
        const foundThreads = group.some((g) => Boolean(g?.threadsPostId));
        if (foundBsky !== hasLinkedBsky || foundThreads !== hasLinkedThreads) {
          hasLinkedBsky = hasLinkedBsky || foundBsky;
          hasLinkedThreads = hasLinkedThreads || foundThreads;
          updateComposerMetrics();
        }
      }).catch(() => {});
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saveBtn.disabled || submitting) return;
    submitting = true;
    statusEl.textContent = '';
    updateComposerMetrics();
    try {
      const updated = await editUnified(post, ta.value, spoiler);
      const warnings = Array.isArray(updated?._bridgeWarnings) ? updated._bridgeWarnings : [];
      modal.close();
      await onSaved?.(updated);
      if (warnings.length > 0) {
        showAlert('Bridge Edit Warning', warnings.join('\n\n'));
      }
    } catch (err) {
      statusEl.textContent = err?.message || 'Edit failed.';
    } finally {
      submitting = false;
      updateComposerMetrics();
    }
  });

  modal.card.appendChild(form);
  updateComposerMetrics();
  modal.open();
  syncAutoHeight(ta, 68, 340);
  return modal;
}

/**
 * Center-column User Profile Page: public preview, native profile editing,
 * Accounts & Bridges entry, and Posts / Replies / Media / Boosts management.
 */
export function mountProfileScreen(containerEl, {
  onOpenAccounts,
  onOpenPostThread,
  onAskSanctuary,
  onSelectAuthor,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();

  let destroyed = false;
  let activeSubTab = 'posts';
  let ownItems = [];
  let loadingPosts = false;
  let postError = '';

  const root = doc.createElement('section');
  root.className = 'profile-screen';

  const header = doc.createElement('div');
  header.className = 'stage-header profile-stage-header';
  const titleEl = doc.createElement('h1');
  titleEl.className = 'stage-title';
  titleEl.textContent = 'Profile';

  const topActions = doc.createElement('div');
  topActions.className = 'classic-card-actions';
  const accountsBtn = doc.createElement('button');
  accountsBtn.type = 'button';
  accountsBtn.className = 'messages-header-pill profile-accounts-btn';
  accountsBtn.textContent = 'Accounts & Bridges';
  accountsBtn.addEventListener('click', () => onOpenAccounts?.());
  topActions.appendChild(accountsBtn);
  header.append(titleEl, topActions);

  const heroHost = doc.createElement('div');
  heroHost.className = 'profile-hero-host';

  const tabsRow = doc.createElement('div');
  tabsRow.className = 'stage-tabs profile-sub-tabs';
  tabsRow.setAttribute('role', 'tablist');
  tabsRow.setAttribute('focusgroup', 'tablist nomemory');
  tabsRow.setAttribute('aria-label', 'Profile sections');

  const retryBannerEl = doc.createElement('div');
  retryBannerEl.className = 'bridge-retry-banner';
  retryBannerEl.hidden = true;

  const postsList = doc.createElement('div');
  postsList.className = 'profile-posts-list';
  postsList.setAttribute('role', 'tabpanel');
  postsList.setAttribute('aria-labelledby', `profile-tab-${activeSubTab}`);

  const profileFooterWrap = doc.createElement('div');
  profileFooterWrap.className = 'feed-infinite-footer';
  const sentinelEl = doc.createElement('div');
  sentinelEl.className = 'feed-scroll-sentinel';
  sentinelEl.setAttribute('aria-hidden', 'true');
  const footerStatusEl = doc.createElement('div');
  footerStatusEl.className = 'feed-infinite-status';
  profileFooterWrap.append(sentinelEl, footerStatusEl);

  root.append(header, heroHost, tabsRow, retryBannerEl, postsList, profileFooterWrap);
  containerEl.appendChild(root);

  function renderRetryBanner() {
    if (destroyed) return;
    const retries = Array.isArray(authStore.get().retryQueue) ? authStore.get().retryQueue : [];
    if (retries.length === 0) {
      retryBannerEl.hidden = true;
      retryBannerEl.replaceChildren();
      return;
    }
    retryBannerEl.hidden = false;
    retryBannerEl.replaceChildren();
    const firstRetry = retries[0];
    const msg = doc.createElement('span');
    msg.className = 'bridge-retry-msg';
    msg.textContent = `${firstRetry.protocol} bridge sync paused (${retries.length}): ${formatApiErrorMessage(firstRetry.lastError, 'temporary error')}`;
    const retryBtn = doc.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn-sleek-pill';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => {
      retryBtn.disabled = true;
      void runBridgeRetry(firstRetry.id)
        .then(() => loadOwnPosts())
        .catch((err) => showAlert('Bridge Retry Failed', formatApiErrorMessage(err?.message, 'Retry failed.')))
        .finally(() => { retryBtn.disabled = false; });
    });
    const dismissBtn = doc.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'edit-btn';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => void dismissBridgeRetry(firstRetry.id));
    retryBannerEl.append(msg, retryBtn, dismissBtn);
  }

  function getPrimaryAccount() {
    const s = authStore.get();
    return s.accounts.find((a) => a.id === s.activeFediverseId)
      || s.accounts.find((a) => a.platform === 'fediverse' || a.platform === 'mastodon')
      || s.accounts.find((a) => a.platform === 'bluesky')
      || null;
  }

  async function refreshProfileFromServer() {
    const [mastoAuth, bskyAuth] = await Promise.all([
      getAuthenticatedAccount('fediverse'),
      getAuthenticatedAccount('bluesky'),
    ]);
    if (destroyed) return;

    const tasks = [];
    if (mastoAuth) {
      tasks.push((async () => {
        try {
          const fresh = await verifyCredentials({
            instanceUrl: mastoAuth.meta.instanceUrl,
            accessToken: mastoAuth.secrets.accessToken,
          });
          if (destroyed || (!fresh?.acct && !fresh?.username)) return;
          await upsertSocialAccount({
            id: mastoAuth.meta.id,
            platform: 'fediverse',
            instanceUrl: mastoAuth.meta.instanceUrl,
            handle: fresh.username,
            acct: fresh.acct,
            displayName: fresh.displayName,
            avatar: fresh.avatar,
            header: fresh.header,
            url: fresh.url,
            note: fresh.note,
            noteText: fresh.noteText,
            fields: fresh.fields,
            locked: fresh.locked,
            bot: fresh.bot,
            discoverable: fresh.discoverable,
            indexable: fresh.indexable,
            hideCollections: fresh.hideCollections,
            defaultVisibility: fresh.defaultVisibility,
            defaultSensitive: fresh.defaultSensitive,
            defaultLanguage: fresh.defaultLanguage,
            attributionDomains: fresh.attributionDomains || [],
            emojis: fresh.emojis || [],
            followersCount: fresh.followersCount,
            followingCount: fresh.followingCount,
            statusesCount: fresh.statusesCount,
            userId: fresh.id,
          });
        } catch {
          // Keep cached Mastodon profile metadata offline
        }
      })());
    }

    const bskyActor = bskyAuth?.meta?.did || bskyAuth?.meta?.handle || bskyAuth?.meta?.acct || '';
    if (bskyAuth && bskyActor) {
      tasks.push((async () => {
        try {
          const res = await fetchAuthorWithRelationship(bskyActor, 'https://bsky.app', {
            protocol: 'bluesky',
            acct: bskyAuth.meta.handle || bskyAuth.meta.acct || bskyActor,
          });
          const prof = res?.profile;
          if (destroyed || !prof) return;
          await upsertSocialAccount({
            id: bskyAuth.meta.id,
            platform: 'bluesky',
            serviceUrl: bskyAuth.meta.serviceUrl || 'https://bsky.social',
            handle: prof.acct || bskyAuth.meta.handle || '',
            acct: prof.acct || bskyAuth.meta.acct || '',
            displayName: prof.displayName || bskyAuth.meta.displayName || prof.acct || '',
            avatar: prof.avatar || bskyAuth.meta.avatar || '',
            header: prof.banner || prof.header || bskyAuth.meta.header || '',
            url: prof.url || bskyAuth.meta.url || '',
            noteText: prof.noteText || bskyAuth.meta.noteText || '',
            publicVisible: prof.publicVisible !== false,
            followersCount: Number(prof.followersCount ?? 0),
            followingCount: Number(prof.followingCount ?? 0),
            statusesCount: Number(prof.statusesCount ?? 0),
            did: prof.did || bskyAuth.meta.did || bskyActor,
          });
        } catch {
          // Keep cached Bluesky profile metadata offline
        }
      })());
    }

    await Promise.all(tasks);
  }

  let loadPostsEpoch = 0;
  const ownItemsByTab = new Map();
  const tabCursors = new Map();
  const profileCardCache = new Map();
  let loadingOlderPosts = false;
  let appendPostError = '';
  let sentinelIntersecting = false;
  let lastAutoCursorSig = '';

  const INFINITE_SCROLL_THRESHOLD_PX = 480;
  const scrollRoot = containerEl.closest?.('.center-column-wrap') || null;
  const scrollTarget = scrollRoot || containerEl;

  function syncProfileInfiniteFooter() {
    if (destroyed) return;
    footerStatusEl.replaceChildren();
    if (loadingOlderPosts) {
      footerStatusEl.appendChild(createLoadingState('Loading older posts…', { doc, size: 'compact' }));
      return;
    }
    if (appendPostError) {
      const retryBtn = doc.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-sleek-pill feed-retry-more-btn';
      retryBtn.textContent = 'Retry loading older posts';
      retryBtn.addEventListener('click', () => {
        appendPostError = '';
        syncProfileInfiniteFooter();
        void loadMoreOwnPosts();
      });
      footerStatusEl.appendChild(retryBtn);
    }
  }

  function canLoadOlderProfilePosts() {
    return Boolean(
      !destroyed
      && !loadingPosts
      && !loadingOlderPosts
      && ownItems.length > 0
      && tabCursors.get(activeSubTab)
    );
  }

  function maybeAutoLoadOlderProfilePosts() {
    if (!sentinelIntersecting || !canLoadOlderProfilePosts()) return;
    const cursorSig = JSON.stringify(tabCursors.get(activeSubTab) || null);
    if (!cursorSig || cursorSig === lastAutoCursorSig) return;
    lastAutoCursorSig = cursorSig;
    void loadMoreOwnPosts();
  }

  function getCachedTabItems(tab = activeSubTab) {
    return ownItemsByTab.get(tab) || [];
  }

  function syncActiveTabCache() {
    ownItemsByTab.set(activeSubTab, [...ownItems]);
    const primary = getPrimaryAccount();
    if (primary?.id) {
      void persistProfileTabCache(primary.id, activeSubTab, ownItems);
    }
  }

  async function readPersistentProfileTabCache(accountKey, tab) {
    if (!accountKey) return [];
    const all = await kvGet(PROFILE_TABS_CACHE_KV_KEY, null).catch(() => null);
    const list = all && typeof all === 'object' ? all[`${accountKey}:${tab}`] : null;
    return Array.isArray(list) ? list.filter(hasRenderablePostContent) : [];
  }

  async function persistProfileTabCache(accountKey, tab, items) {
    if (!accountKey || !Array.isArray(items)) return;
    const prev = await kvGet(PROFILE_TABS_CACHE_KV_KEY, null).catch(() => null);
    const next = prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {};
    next[`${accountKey}:${tab}`] = items.slice(0, 30);
    await kvSet(PROFILE_TABS_CACHE_KV_KEY, next).catch(() => {});
  }

  function buildProfileCard(item, idx) {
    const showSanctuary = connectionStore.get().mode === 'online' || connectionStore.get().programs.length > 0;
    return createPostCard(item, {
      onReply: (p) => prefillReply(p),
      onToggleLike: async (p) => {
        const updated = await likeUnified(p);
        ownItems = ownItems.map((it) => (it.id === updated.id ? updated : it));
        syncActiveTabCache();
        renderPosts();
      },
      onToggleRepost: async (p) => {
        const updated = await repostUnified(p);
        mutatePostAcrossStreams(updated.id, () => updated);
        const stillBoosted = Boolean(updated?._meta?.mastodon?.reblogged || updated?._meta?.bluesky?.repostUri);
        ownItems = activeSubTab === 'boosts' && !stillBoosted
          ? ownItems.filter((it) => it.id !== updated.id)
          : ownItems.map((it) => (it.id === updated.id ? updated : it));
        syncActiveTabCache();
        renderPosts();
      },
      onOpenThread: onOpenPostThread,
      onAskSanctuary,
      onSelectAuthor,
      onInterested: async (p) => {
        const updated = await applyPostInterestFeedback(p, 'interested');
        if (updated && !destroyed) {
          ownItems = ownItems.map((it) => (it.id === updated.id ? updated : it));
          syncActiveTabCache();
          renderPosts();
        }
      },
      onNotInterested: async (p) => {
        await applyPostInterestFeedback(p, 'not_interested');
        if (!destroyed) {
          ownItems = ownItems.filter((it) => it.id !== p.id);
          syncActiveTabCache();
          renderPosts();
        }
      },
      onEditPost: (p) => {
        openEditPostDialog(p, {
          onSaved: (updated) => {
            ownItems = ownItems.map((it) => (it.id === p.id || it.id === updated.id ? updated : it));
            syncActiveTabCache();
            mutatePostAcrossStreams((it) => it?.id === p.id || it?.id === updated.id, () => updated);
            renderPosts();
          },
        });
      },
      onRetryBridge: (retryEntry) => {
        void runBridgeRetry(retryEntry.id)
          .then(() => loadOwnPosts())
          .catch((err) => showAlert('Bridge Retry Failed', formatApiErrorMessage(err?.message, 'Retry failed.')));
      },
      onTogglePin: async (p) => {
        const pinnedNow = Boolean(p._meta?.mastodon?.pinned);
        const updated = await pinUnified(p, pinnedNow);
        const nextList = ownItems.map((it) => (it.id === updated.id ? updated : it));
        ownItems = activeSubTab === 'posts' ? sortOwnPostsPinnedFirst(nextList) : nextList;
        syncActiveTabCache();
        mutatePostAcrossStreams(updated.id, () => updated);
        renderPosts();
      },
      onDeletePost: (p) => {
        showConfirm(
          'Delete Post',
          p._meta?.linkedIds?.blueskyUri || p._meta?.linkedIds?.threadsPostId
            ? 'Delete this post from Mastodon and all linked bridges?'
            : 'Delete this Mastodon post?',
          async () => {
            const res = await deleteUnified(p);
            ownItems = ownItems.filter((it) => it.id !== p.id);
            syncActiveTabCache();
            removePostAcrossStreams(p.id);
            if (activeSubTab === 'posts') {
              void syncRecentUserPostsToSanctuary({ preloadedItems: ownItems }).catch(() => {});
            }
            renderPosts();
            if (res?.warnings?.length > 0) {
              showAlert('Bridge Delete Warning', res.warnings.join('\n\n'));
            }
          }
        );
      },
      showSanctuaryAction: showSanctuary,
      mediaPriority: idx === 0 ? 'high' : (idx < 3 ? 'eager' : 'lazy'),
    });
  }

  function applyEnrichedMetricsInPlace(enrichedItems) {
    if (!Array.isArray(enrichedItems) || enrichedItems.length === 0) return;
    const byId = new Map(enrichedItems.filter((it) => it?.id).map((it) => [String(it.id), it]));
    ownItems = ownItems.map((it) => byId.get(String(it?.id)) || it);
    for (const [key, entry] of profileCardCache.entries()) {
      const nextItem = byId.get(key);
      if (!nextItem || !entry?.card) continue;
      entry.item = nextItem;
      entry.sig = computeProfileItemStructSig(nextItem);
      syncPostCardReactions(entry.card, nextItem);
    }
  }

  function enrichProfileItems(tab, items, { persist = true } = {}) {
    if (!Array.isArray(items) || items.length === 0) return;
    const primary = getPrimaryAccount();
    void enrichUnifiedItemsMetrics(items)
      .then((enriched) => {
        if (destroyed || !Array.isArray(enriched) || enriched.length === 0) return;
        for (const item of enriched) {
          recordItemMetrics(item);
        }
        applyEnrichedMetricsInPlace(enriched);
        const byId = new Map(enriched.filter((it) => it?.id).map((it) => [String(it.id), it]));
        const latestTabItems = activeSubTab === tab
          ? ownItems
          : (ownItemsByTab.get(tab) || []).map((it) => byId.get(String(it?.id)) || it);
        ownItemsByTab.set(tab, latestTabItems);
        if (persist && primary?.id) {
          void persistProfileTabCache(primary.id, tab, latestTabItems);
        }
      })
      .catch((err) => {
        console.warn('[profile] Metrics enrichment failed:', err);
      });
  }

  async function loadOwnPosts() {
    if (destroyed) return;
    await hydrateMetricsLedger();
    const primary = getPrimaryAccount();
    const isPrimaryBsky = primary?.platform === 'bluesky';
    const targetId = isPrimaryBsky
      ? (primary.did || primary.handle || primary.acct || '')
      : (primary?.userId || primary?.acct || primary?.handle || '');
    if (!primary || !targetId) {
      ownItems = [];
      renderPosts();
      return;
    }
    const tab = activeSubTab;
    const epoch = ++loadPostsEpoch;
    let cached = getCachedTabItems(tab);
    if (cached.length === 0 && primary.id) {
      cached = await readPersistentProfileTabCache(primary.id, tab);
      if (destroyed || epoch !== loadPostsEpoch || activeSubTab !== tab) return;
    }
    if (cached.length > 0) {
      cached = dropLinkedSiblings(cached).map((it) => applyKnownMetrics(it));
      ownItemsByTab.set(tab, cached);
    }
    ownItems = cached;
    loadingPosts = cached.length === 0;
    loadingOlderPosts = false;
    postError = '';
    appendPostError = '';
    lastAutoCursorSig = '';
    syncProfileInfiniteFooter();
    renderPosts();
    try {
      const pageRes = await fetchOwnStatuses(targetId, {
        tab,
        protocol: isPrimaryBsky ? 'bluesky' : 'mastodon',
        acct: primary.acct || primary.handle || '',
        instanceUrl: isPrimaryBsky ? 'https://bsky.app' : (primary.instanceUrl || 'https://mastodon.social'),
        includeBridges: !isPrimaryBsky,
        skipMetricsEnrichment: true,
        returnPageMeta: true,
      });
      if (destroyed) return;
      const baseItems = Array.isArray(pageRes) ? pageRes : (pageRes?.items || []);
      const nextCursor = Array.isArray(pageRes) ? null : (pageRes?.nextCursor || null);
      const mergedBaseItems = dropLinkedSiblings(Array.isArray(baseItems) ? baseItems : []).map((it) => applyKnownMetrics(it));
      ownItemsByTab.set(tab, mergedBaseItems);
      tabCursors.set(tab, nextCursor);
      if (primary.id) void persistProfileTabCache(primary.id, tab, mergedBaseItems);
      if (epoch !== loadPostsEpoch || activeSubTab !== tab) return;
      ownItems = mergedBaseItems;
      loadingPosts = false;
      renderPosts();
      syncProfileInfiniteFooter();
      maybeAutoLoadOlderProfilePosts();
      if (tab === 'posts') {
        void syncRecentUserPostsToSanctuary({ preloadedItems: ownItems }).catch(() => {});
      }

      enrichProfileItems(tab, mergedBaseItems, { persist: true });
    } catch (err) {
      if (destroyed || epoch !== loadPostsEpoch || activeSubTab !== tab) return;
      if (cached.length === 0) {
        postError = err?.message || 'Unable to load posts.';
        ownItems = [];
      }
      loadingPosts = false;
      renderPosts();
      syncProfileInfiniteFooter();
    }
  }

  async function loadMoreOwnPosts() {
    if (!canLoadOlderProfilePosts()) return;
    const primary = getPrimaryAccount();
    const isPrimaryBsky = primary?.platform === 'bluesky';
    const targetId = isPrimaryBsky
      ? (primary.did || primary.handle || primary.acct || '')
      : (primary?.userId || primary?.acct || primary?.handle || '');
    const tab = activeSubTab;
    const cursor = tabCursors.get(tab);
    if (!primary || !targetId || !cursor) return;

    const epoch = loadPostsEpoch;
    loadingOlderPosts = true;
    appendPostError = '';
    syncProfileInfiniteFooter();
    try {
      const pageRes = await fetchOwnStatuses(targetId, {
        tab,
        protocol: isPrimaryBsky ? 'bluesky' : 'mastodon',
        acct: primary.acct || primary.handle || '',
        instanceUrl: isPrimaryBsky ? 'https://bsky.app' : (primary.instanceUrl || 'https://mastodon.social'),
        includeBridges: !isPrimaryBsky,
        skipMetricsEnrichment: true,
        maxId: cursor.maxId || '',
        bskyCursor: cursor.bskyCursor || '',
        mastoDone: Boolean(cursor.mastoDone),
        returnPageMeta: true,
      });
      if (destroyed || epoch !== loadPostsEpoch || activeSubTab !== tab) return;
      const incoming = Array.isArray(pageRes) ? pageRes : (pageRes?.items || []);
      const existingIds = new Set(ownItems.map((it) => String(it?.id || '')));
      const addedItems = incoming
        .filter((it) => it?.id && !existingIds.has(String(it.id)))
        .map((it) => applyKnownMetrics(it));
      const nextCursor = Array.isArray(pageRes) ? null : (pageRes?.nextCursor || null);
      tabCursors.set(tab, addedItems.length === 0 && !nextCursor ? null : nextCursor);

      const nextCombined = tab === 'posts'
        ? [
            ...ownItems.filter((it) => Boolean(it?._meta?.mastodon?.pinned)),
            ...ownItems.filter((it) => !it?._meta?.mastodon?.pinned),
            ...addedItems,
          ]
        : [...ownItems, ...addedItems];
      ownItems = dropLinkedSiblings(nextCombined);
      ownItemsByTab.set(tab, ownItems);
      loadingOlderPosts = false;
      renderPosts();
      syncProfileInfiniteFooter();
      maybeAutoLoadOlderProfilePosts();

      enrichProfileItems(tab, addedItems, { persist: false });
    } catch (err) {
      if (destroyed || epoch !== loadPostsEpoch || activeSubTab !== tab) return;
      loadingOlderPosts = false;
      appendPostError = err?.message || 'Unable to load older posts.';
      syncProfileInfiniteFooter();
    }
  }

  function renderHero() {
    if (destroyed) return;
    const s = authStore.get();
    const primary = getPrimaryAccount();
    heroHost.replaceChildren();

    if (!primary) {
      const card = doc.createElement('div');
      card.className = 'onboarding-option-box profile-empty-card';
      const msg = doc.createElement('p');
      msg.className = 'option-desc';
      msg.textContent = 'Connect your Mastodon account to preview your public profile, publish seamlessly across active bridges, and identify yourself to Sanctuary Programs.';
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-sleek-pill profile-connect-btn';
      btn.textContent = 'Connect Mastodon';
      btn.addEventListener('click', () => onOpenAccounts?.());
      card.append(msg, btn);
      heroHost.appendChild(card);
      tabsRow.hidden = true;
      return;
    }

    tabsRow.hidden = false;
    const card = doc.createElement('div');
    card.className = 'profile-hero-card';

    if (cleanMastodonMediaUrl(primary.header)) {
      const banner = doc.createElement('img');
      banner.className = 'profile-banner-img';
      banner.src = cleanMastodonMediaUrl(primary.header);
      banner.alt = `${primary.displayName || primary.acct} banner`;
      card.appendChild(banner);
    }

    const topRow = doc.createElement('div');
    topRow.className = 'profile-hero-top';
    const av = doc.createElement('img');
    av.className = 'profile-hero-avatar';
    av.src = cleanMastodonMediaUrl(primary.avatar) || DEFAULT_AVATAR_DATA_URI;
    av.alt = primary.displayName || primary.acct || 'Profile avatar';

    const names = doc.createElement('div');
    names.className = 'profile-hero-names';
    const dn = doc.createElement('h2');
    dn.className = 'profile-display-name';
    dn.textContent = primary.displayName || primary.handle || primary.acct;
    const isPrimaryBsky = primary.platform === 'bluesky';
    const primaryProto = isPrimaryBsky ? 'bluesky' : 'mastodon';
    const acctEl = doc.createElement('span');
    acctEl.className = 'post-author-handle profile-primary-handle';
    if (PROTOCOL_LOGO_SVGS[primaryProto]) {
      const pIcon = doc.createElement('span');
      pIcon.className = 'profile-primary-handle-icon';
      pIcon.setAttribute('aria-hidden', 'true');
      pIcon.innerHTML = PROTOCOL_LOGO_SVGS[primaryProto];
      acctEl.appendChild(pIcon);
    }
    const acctText = doc.createElement('span');
    acctText.textContent = primary.acct ? `@${primary.acct.replace(/^@/, '')}` : '';
    acctEl.appendChild(acctText);
    names.append(dn, acctEl);
    const editBtn = doc.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-sleek-pill profile-edit-btn';
    editBtn.textContent = 'Edit Profile';
    editBtn.hidden = isPrimaryBsky;
    editBtn.addEventListener('click', () => {
      openEditMastodonProfileModal({
        accountMeta: primary,
        onSaved: () => {
          renderHero();
          void loadOwnPosts();
        },
      });
    });

    topRow.append(av, names);
    if (!isPrimaryBsky) {
      topRow.append(editBtn);
    }
    card.appendChild(topRow);

    const badges = doc.createElement('div');
    badges.className = 'profile-badges-row';
    if (primary.locked) {
      const b = doc.createElement('span');
      b.className = 'status-badge';
      b.textContent = 'Locked';
      badges.appendChild(b);
    }
    if (primary.bot) {
      const b = doc.createElement('span');
      b.className = 'status-badge';
      b.textContent = 'Bot';
      badges.appendChild(b);
    }
    if (badges.childNodes.length > 0) card.appendChild(badges);

    if (primary.note || primary.noteText) {
      const bio = doc.createElement('div');
      bio.className = 'profile-bio-html';
      if (primary.note) {
        renderSanitizedHtml(bio, primary.note, primary.emojis || []);
      } else {
        bio.textContent = decodeHtmlEntities(primary.noteText);
      }
      card.appendChild(bio);
    }

    if (Array.isArray(primary.fields) && primary.fields.length > 0) {
      const linksRow = doc.createElement('div');
      linksRow.className = 'profile-links-row';
      renderProfileLinksAndFields(linksRow, primary.fields, primary.emojis || []);
      if (linksRow.childNodes.length > 0) {
        card.appendChild(linksRow);
      }
    }

    const bskyAccount = isPrimaryBsky ? null : (s.accounts || []).find((a) => a.platform === 'bluesky');
    const totalFollowing = Number(primary.followingCount ?? 0) + Number(bskyAccount?.followingCount ?? 0);
    const totalFollowers = Number(primary.followersCount ?? 0) + Number(bskyAccount?.followersCount ?? 0);

    const primaryAccountId = isPrimaryBsky
      ? (primary.did || primary.handle || primary.acct || '')
      : (primary.userId || primary.acct || primary.handle || '');
    const primaryAcct = primary.acct || primary.handle || '';
    const primaryInstanceUrl = isPrimaryBsky ? 'https://bsky.app' : (primary.instanceUrl || 'https://mastodon.social');
    const primaryProtocol = isPrimaryBsky ? 'bluesky' : 'mastodon';

    const stats = doc.createElement('div');
    stats.className = 'profile-stats-row';
    const postsStat = doc.createElement('span');
    postsStat.textContent = `${Number(primary.statusesCount ?? 0).toLocaleString()} Posts`;
    const followingBtn = doc.createElement('button');
    followingBtn.type = 'button';
    followingBtn.className = 'profile-stat-btn';
    followingBtn.textContent = `${totalFollowing.toLocaleString()} Following`;
    if (bskyAccount) {
      followingBtn.title = `Fediverse: ${Number(primary.followingCount ?? 0).toLocaleString()} · Bluesky: ${Number(bskyAccount.followingCount ?? 0).toLocaleString()}`;
    }
    followingBtn.addEventListener('click', () => {
      openFollowGraphModal({
        accountId: primaryAccountId,
        acct: primaryAcct,
        displayName: primary.displayName || primaryAcct,
        instanceUrl: primaryInstanceUrl,
        protocol: primaryProtocol,
        initialTab: 'following',
        isOwnProfile: true,
        onSelectAuthor,
        onCountsChanged: () => void refreshProfileFromServer(),
      });
    });

    const followersBtn = doc.createElement('button');
    followersBtn.type = 'button';
    followersBtn.className = 'profile-stat-btn';
    followersBtn.textContent = `${totalFollowers.toLocaleString()} Followers`;
    if (bskyAccount) {
      followersBtn.title = `Fediverse: ${Number(primary.followersCount ?? 0).toLocaleString()} · Bluesky: ${Number(bskyAccount.followersCount ?? 0).toLocaleString()}`;
    }
    followersBtn.addEventListener('click', () => {
      openFollowGraphModal({
        accountId: primaryAccountId,
        acct: primaryAcct,
        displayName: primary.displayName || primaryAcct,
        instanceUrl: primaryInstanceUrl,
        protocol: primaryProtocol,
        initialTab: 'followers',
        isOwnProfile: true,
        onSelectAuthor,
        onCountsChanged: () => void refreshProfileFromServer(),
      });
    });

    stats.append(postsStat, followingBtn, followersBtn);
    card.appendChild(stats);

    const bridgeAccounts = (s.accounts || []).filter((a) => {
      if (!a) return false;
      const proto = a.platform === 'bluesky' ? 'bluesky' : (a.platform === 'threads' ? 'threads' : (a.platform === 'fediverse' || a.platform === 'mastodon' ? 'mastodon' : ''));
      if (!proto) return false;
      if (a.id && primary.id && a.id === primary.id) return false;
      return proto !== primaryProto;
    });
    if (bridgeAccounts.length > 0) {
      const pillsRow = doc.createElement('div');
      pillsRow.className = 'profile-connected-pills';
      for (const acc of bridgeAccounts) {
        const proto = acc.platform === 'bluesky' ? 'bluesky' : (acc.platform === 'threads' ? 'threads' : 'mastodon');
        const pill = doc.createElement('span');
        pill.className = `profile-connected-pill profile-connected-pill--${proto}`;
        const iconSpan = doc.createElement('span');
        iconSpan.className = 'profile-connected-pill-icon';
        iconSpan.setAttribute('aria-hidden', 'true');
        iconSpan.innerHTML = PROTOCOL_LOGO_SVGS[proto] || '';
        const textSpan = doc.createElement('span');
        const cleanH = String(acc.acct || acc.handle || '').replace(/^@/, '');
        textSpan.textContent = cleanH ? `@${cleanH}` : proto;
        pill.append(iconSpan, textSpan);
        pillsRow.appendChild(pill);
      }
      card.appendChild(pillsRow);
    }

    heroHost.appendChild(card);
  }

  const subTabButtons = PROFILE_TABS.map(([id, label], idx) => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.id = `profile-tab-${id}`;
    btn.setAttribute('role', 'tab');
    const labelEl = doc.createElement('span');
    labelEl.className = 'stage-tab-label';
    labelEl.textContent = label;
    btn.appendChild(labelEl);
    btn.addEventListener('click', () => {
      activeSubTab = id;
      renderSubTabs();
      btn.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      void loadOwnPosts();
    });
    btn.addEventListener('keydown', (e) => {
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % PROFILE_TABS.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + PROFILE_TABS.length) % PROFILE_TABS.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = PROFILE_TABS.length - 1;
      if (nextIdx >= 0) {
        e.preventDefault();
        const targetTab = subTabButtons[nextIdx]?.btn;
        targetTab?.focus?.();
        targetTab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    });
    return { id, btn };
  });
  tabsRow.replaceChildren(...subTabButtons.map((t) => t.btn));

  function renderSubTabs() {
    postsList.setAttribute('aria-labelledby', `profile-tab-${activeSubTab}`);
    for (const { id, btn } of subTabButtons) {
      const isSelected = activeSubTab === id;
      btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      btn.tabIndex = isSelected ? 0 : -1;
      btn.toggleAttribute?.('focusgroupstart', isSelected);
      btn.classList.toggle('active', isSelected);
      btn.classList.add('stage-tab-btn');
    }
  }

  function computeProfileItemStructSig(item) {
    const m = item?._meta?.mastodon || {};
    const b = item?._meta?.bluesky || {};
    const retryCount = (authStore.get()?.retryQueue || []).length;
    return [
      item?.id || '',
      item?.content_html || item?.content_text || '',
      Boolean(m.pinned),
      Boolean(m.favourited || b.likeUri),
      Boolean(m.reblogged || b.repostUri),
      m.spoilerText || '',
      item?._meta?.replyContext?.id || item?._meta?.replyContext?.text || '',
      JSON.stringify(item?._meta?.linkedIds || null),
      retryCount,
    ].join('\u001f');
  }

  function renderPosts() {
    if (destroyed) return;
    postsList.removeAttribute('tabindex');
    if (!getPrimaryAccount()) {
      profileCardCache.clear();
      postsList.replaceChildren();
      return;
    }

    if (loadingPosts && ownItems.length === 0) {
      profileCardCache.clear();
      postsList.replaceChildren(createLoadingState(`Loading ${activeSubTab}…`));
      return;
    }

    if (postError) {
      profileCardCache.clear();
      postsList.replaceChildren(createOfflineNotice({ variant: 'error', message: postError }));
      return;
    }

    if (ownItems.length === 0) {
      profileCardCache.clear();
      postsList.tabIndex = 0;
      const empty = doc.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = `No ${activeSubTab} yet.`;
      postsList.replaceChildren(empty);
      return;
    }

    for (const child of [...postsList.children]) {
      if (child.tagName !== 'ARTICLE') {
        child.remove();
      }
    }

    const activeKeys = new Set();
    const keyed = ownItems.map((item, idx) => {
      const key = String(item?.id || item?.key || `prof-${idx}`);
      activeKeys.add(key);
      return { item, key, idx };
    });

    for (const [cachedKey, entry] of [...profileCardCache.entries()]) {
      if (!activeKeys.has(cachedKey)) {
        entry.card.remove();
        profileCardCache.delete(cachedKey);
      }
    }

    const canMoveBefore =
      Object.hasOwn(globalThis.Element?.prototype || {}, 'moveBefore') &&
      typeof postsList.moveBefore === 'function';

    for (const { item, key, idx } of keyed) {
      const sig = computeProfileItemStructSig(item);
      const existing = profileCardCache.get(key);
      let cardEl = existing?.card || null;
      if (!existing || existing.sig !== sig) {
        const nextCard = buildProfileCard(item, idx);
        if (existing?.card && existing.card.parentNode === postsList) {
          postsList.replaceChild(nextCard, existing.card);
        }
        cardEl = nextCard;
        profileCardCache.set(key, { sig, card: nextCard, item });
      } else {
        existing.item = item;
        syncPostCardReactions(existing.card, item);
      }
      cardEl.classList.toggle('is-below-fold', idx >= 5);
      const currentAtIdx = postsList.children[idx] || null;
      if (currentAtIdx !== cardEl) {
        if (canMoveBefore && cardEl.parentNode === postsList) {
          postsList.moveBefore(cardEl, currentAtIdx);
        } else {
          postsList.insertBefore(cardEl, currentAtIdx);
        }
      }
    }
  }

  let prevProfileRetrySig = (authStore.get().retryQueue || []).map((r) => `${r.id}:${r.lastError || ''}`).join('|');
  let prevPrimaryUserId = getPrimaryAccount()?.userId || '';
  const unsubAuth = authStore.subscribe((nextState) => {
    if (destroyed) return;
    renderHero();
    renderRetryBanner();
    const nextPrimaryUserId = getPrimaryAccount()?.userId || '';
    if (nextPrimaryUserId && nextPrimaryUserId !== prevPrimaryUserId) {
      prevPrimaryUserId = nextPrimaryUserId;
      void loadOwnPosts();
    } else if (!nextPrimaryUserId) {
      prevPrimaryUserId = '';
      loadPostsEpoch += 1;
      ownItems = [];
      ownItemsByTab.clear();
      tabCursors.clear();
      loadingPosts = false;
      loadingOlderPosts = false;
      postError = '';
      appendPostError = '';
      syncProfileInfiniteFooter();
      renderPosts();
    }
    const nextRetrySig = (nextState?.retryQueue || []).map((r) => `${r.id}:${r.lastError || ''}`).join('|');
    if (nextRetrySig !== prevProfileRetrySig) {
      prevProfileRetrySig = nextRetrySig;
      renderPosts();
    }
  });

  let wasNodeOnline = connectionStore.get().mode === 'online';
  const unsubConn = connectionStore.select(
    (st) => st.mode === 'online',
    (isOnline) => {
      const becameOnline = Boolean(isOnline && !wasNodeOnline);
      wasNodeOnline = Boolean(isOnline);
      if (!becameOnline || destroyed || ownItems.length === 0) return;
      enrichProfileItems(activeSubTab, ownItems, { persist: true });
    }
  );

  function isProfileNearBottom() {
    const scrollH = Number(scrollTarget.scrollHeight || 0);
    const clientH = Number(scrollTarget.clientHeight || 0);
    const scrollT = Number(scrollTarget.scrollTop || 0);
    if (scrollH > 0 && clientH > 0 && scrollH - scrollT - clientH <= INFINITE_SCROLL_THRESHOLD_PX) {
      return true;
    }
    if (!scrollRoot) {
      const rootEl = doc.documentElement;
      const docH = Number(rootEl?.scrollHeight || 0);
      const docClientH = Number(rootEl?.clientHeight || 0);
      const docScrollT = Number(rootEl?.scrollTop || globalThis.scrollY || 0);
      if (docH > 0 && docClientH > 0 && docH - docScrollT - docClientH <= INFINITE_SCROLL_THRESHOLD_PX) {
        return true;
      }
    }
    return false;
  }

  function handleProfileScroll() {
    lastAutoCursorSig = '';
    if (!canLoadOlderProfilePosts()) return;
    if (isProfileNearBottom()) {
      void loadMoreOwnPosts();
    }
  }
  scrollTarget.addEventListener('scroll', handleProfileScroll, { passive: true });

  let profileIntersectionObserver = null;
  if (typeof globalThis.IntersectionObserver === 'function') {
    profileIntersectionObserver = new globalThis.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === sentinelEl) {
            sentinelIntersecting = Boolean(entry.isIntersecting);
          }
        }
        if (sentinelIntersecting && canLoadOlderProfilePosts()) {
          void loadMoreOwnPosts();
        }
      },
      { root: scrollRoot, rootMargin: `0px 0px ${INFINITE_SCROLL_THRESHOLD_PX}px 0px` }
    );
    profileIntersectionObserver.observe(sentinelEl);
  }

  renderHero();
  renderSubTabs();
  renderRetryBanner();
  const hadPrimaryUserId = Boolean(getPrimaryAccount()?.userId);
  if (hadPrimaryUserId) {
    void loadOwnPosts();
  }
  void refreshProfileFromServer().then(() => {
    if (!destroyed && !hadPrimaryUserId) return loadOwnPosts();
  });

  return {
    refresh: () => {
      renderHero();
      return loadOwnPosts();
    },
    destroy() {
      destroyed = true;
      scrollTarget.removeEventListener('scroll', handleProfileScroll);
      profileIntersectionObserver?.disconnect();
      profileCardCache.clear();
      unsubAuth();
      unsubConn();
    },
  };
}
