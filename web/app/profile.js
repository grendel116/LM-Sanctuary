import { createEmojiPicker } from '../components/EmojiPickerPopover.js';
import { createEmbedCard, resolvePostEmbedCard } from '../components/EmbedCard.js';
import { openFollowGraphModal } from '../components/FollowGraphModal.js';
import { createOfflineNotice } from '../components/OfflineNotice.js';
import { createPostCard } from '../components/PostCard.js';
import { createClassicModalDialog, showAlert, showConfirm } from '../components/sanctuary/SanctuaryDialog.js';
import { createLoadingState } from '../components/ui/index.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { MASTODON_MAX_CHARS } from '../constants/endpoints.js';
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
  editUnified,
  enrichUnifiedItemsMetrics,
  fetchAuthorWithRelationship,
  fetchOwnStatuses,
  likeUnified,
  pinUnified,
  repostUnified,
  syncConnectedBlueskyProfile,
  syncRecentUserPostsToSanctuary,
  updateMastodonProfileCredentials,
} from '../queries/socialClient.js';
import { authStore, getAuthenticatedAccount, upsertSocialAccount } from '../state/authStore.js';
import { computeRemainingCounts, prefillReply } from '../state/composeStore.js';
import { mutatePostAcrossStreams, removePostAcrossStreams } from '../state/feedStore.js';
import { connectionStore } from '../state/sanctuary/connection.js';
import { summarizeAccountIdentity, syncAutoHeight } from './composeModal.js';

const PROFILE_TABS = [
  ['posts', 'Posts'],
  ['replies', 'Replies'],
  ['media', 'Media'],
  ['pinned', 'Pinned'],
];

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
  const modal = createClassicModalDialog({
    id: 'edit-post-dialog',
    maxWidth: '560px',
    closedBy: 'any',
    onClose: () => {
      emojiPicker?.close?.();
      modal.dialog.remove();
    },
  });
  modal.closeBtn.hidden = true;
  modal.card.classList.add('compose-sheet-card');

  const authState = authStore.get();
  const { handle, avatarUrl } = summarizeAccountIdentity(authState.accounts || []);
  const mastoMeta = post?._meta?.mastodon || {};
  const spoiler = String(mastoMeta.spoilerText || post?.spoilerText || '');
  const visibility = String(mastoMeta.visibility || 'public').toLowerCase();
  const linked = post?._meta?.linkedIds || {};
  const hasBsky = Boolean(linked.blueskyUri || authState.isBlueskyConnected);
  const hasThreads = Boolean(linked.threadsPostId || authState.isThreadsConnected);
  const canReplaceBridges = visibility !== 'direct' && (hasBsky || hasThreads);
  const attachments = Array.isArray(post?.attachments) ? post.attachments : [];

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
  ta.value = post?.content_text || '';
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

  const footerLeft = doc.createElement('div');
  footerLeft.className = 'compose-footer-left';

  let replaceCheckbox = null;
  let replaceLabel = null;
  if (canReplaceBridges) {
    replaceCheckbox = doc.createElement('input');
    replaceCheckbox.type = 'checkbox';
    replaceCheckbox.id = 'edit-post-replace-bridges';
    replaceCheckbox.name = 'replace_bridges';
    replaceCheckbox.className = 'visually-hidden';
    replaceCheckbox.checked = true;

    replaceLabel = doc.createElement('label');
    replaceLabel.setAttribute('for', 'edit-post-replace-bridges');
    replaceLabel.className = 'compose-bridge-toggle-pill is-active';

    const dot = doc.createElement('span');
    dot.className = 'compose-bridge-toggle-dot';
    dot.setAttribute('aria-hidden', 'true');
    const lblText = doc.createElement('span');
    lblText.textContent = 'Update bridges';
    replaceLabel.append(dot, lblText);

    replaceCheckbox.addEventListener('change', () => updateComposerMetrics());
    footerLeft.append(replaceCheckbox, replaceLabel);
  }

  const statusEl = doc.createElement('p');
  statusEl.className = 'compose-status-msg';
  statusEl.setAttribute('role', 'status');
  statusEl.setAttribute('aria-live', 'polite');

  const saveBtn = doc.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'compose-publish-btn is-ready';
  saveBtn.textContent = 'Save';

  footer.append(footerLeft, statusEl, saveBtn);
  form.append(header, body, footer);

  function updateComposerMetrics() {
    syncAutoHeight(ta, 68, 340);
    const replaceActive = Boolean(replaceCheckbox?.checked);
    if (replaceLabel) {
      replaceLabel.classList.toggle('is-active', replaceActive);
    }

    if (visibility === 'direct') {
      destEl.textContent = 'Direct message';
    } else if (canReplaceBridges && replaceActive) {
      destEl.textContent = ['Fediverse', hasBsky ? 'Bluesky' : '', hasThreads ? 'Threads' : '']
        .filter(Boolean)
        .join(' · ');
    } else {
      destEl.textContent = 'Fediverse';
    }

    const counts = computeRemainingCounts(
      { text: ta.value, spoilerText: spoiler },
      { isBlueskyConnected: replaceActive && hasBsky, isThreadsConnected: replaceActive && hasThreads }
    );
    const remaining = counts.tightestRemaining;
    countsEl.textContent = String(remaining);
    countsEl.classList.toggle('is-over-limit', remaining < 0);

    const overMastodon = [...(ta.value || '')].length + [...spoiler].length > MASTODON_MAX_CHARS;
    const hasContent = Boolean(ta.value.trim() || attachments.length > 0);
    saveBtn.classList.toggle('is-ready', hasContent && !overMastodon && !saveBtn.disabled);
  }

  ta.addEventListener('input', () => {
    captureCaret();
    updateComposerMetrics();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    statusEl.textContent = '';
    updateComposerMetrics();
    try {
      const sid = post?._meta?.mastodon?.statusId || post?.id;
      const updated = await editUnified(sid, ta.value, spoiler, {
        replaceBridges: Boolean(replaceCheckbox?.checked),
      });
      const warnings = Array.isArray(updated?._bridgeWarnings) ? updated._bridgeWarnings : [];
      modal.close();
      await onSaved?.(updated);
      if (warnings.length > 0) {
        showAlert('Bridge Edit Warning', warnings.join('\n\n'));
      }
    } catch (err) {
      statusEl.textContent = err?.message || 'Edit failed.';
    } finally {
      saveBtn.disabled = false;
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
 * Accounts & Bridges entry, and Posts / Replies / Media / Pinned management.
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

  const postsList = doc.createElement('div');
  postsList.className = 'profile-posts-list';

  root.append(header, heroHost, tabsRow, postsList);
  containerEl.appendChild(root);

  function getPrimaryAccount() {
    const s = authStore.get();
    return s.accounts.find((a) => a.id === s.activeFediverseId)
      || s.accounts.find((a) => a.platform === 'fediverse' || a.platform === 'mastodon')
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

  async function loadOwnPosts() {
    if (destroyed) return;
    const primary = getPrimaryAccount();
    if (!primary?.userId) {
      ownItems = [];
      renderPosts();
      return;
    }
    loadingPosts = true;
    postError = '';
    renderPosts();
    try {
      ownItems = await fetchOwnStatuses(primary.userId, {
        tab: activeSubTab,
        instanceUrl: primary.instanceUrl || 'https://mastodon.social',
      });
      ownItems = await enrichUnifiedItemsMetrics(ownItems);
      if (activeSubTab === 'posts') {
        void syncRecentUserPostsToSanctuary({ preloadedItems: ownItems }).catch(() => {});
      }
    } catch (err) {
      postError = err?.message || 'Unable to load posts.';
      ownItems = [];
    } finally {
      loadingPosts = false;
      if (!destroyed) renderPosts();
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
    const acctEl = doc.createElement('span');
    acctEl.className = 'post-author-handle';
    acctEl.textContent = primary.acct ? `@${primary.acct.replace(/^@/, '')}` : '';
    names.append(dn, acctEl);

    const editBtn = doc.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-sleek-pill profile-edit-btn';
    editBtn.textContent = 'Edit Profile';
    editBtn.addEventListener('click', () => {
      openEditMastodonProfileModal({
        accountMeta: primary,
        onSaved: () => {
          renderHero();
          void loadOwnPosts();
        },
      });
    });

    topRow.append(av, names, editBtn);
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

    const bskyAccount = (s.accounts || []).find((a) => a.platform === 'bluesky');
    const totalFollowing = Number(primary.followingCount ?? 0) + Number(bskyAccount?.followingCount ?? 0);
    const totalFollowers = Number(primary.followersCount ?? 0) + Number(bskyAccount?.followersCount ?? 0);

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
        accountId: primary.userId,
        acct: primary.acct,
        displayName: primary.displayName || primary.acct,
        instanceUrl: primary.instanceUrl || 'https://mastodon.social',
        protocol: 'mastodon',
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
        accountId: primary.userId,
        acct: primary.acct,
        displayName: primary.displayName || primary.acct,
        instanceUrl: primary.instanceUrl || 'https://mastodon.social',
        protocol: 'mastodon',
        initialTab: 'followers',
        isOwnProfile: true,
        onSelectAuthor,
        onCountsChanged: () => void refreshProfileFromServer(),
      });
    });

    stats.append(postsStat, followingBtn, followersBtn);
    card.appendChild(stats);

    heroHost.appendChild(card);
  }

  function renderSubTabs() {
    tabsRow.replaceChildren(
      ...PROFILE_TABS.map(([id, label]) => {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = `stage-tab-btn${activeSubTab === id ? ' active' : ''}`;
        const labelEl = doc.createElement('span');
        labelEl.className = 'stage-tab-label';
        labelEl.textContent = label;
        btn.appendChild(labelEl);
        btn.addEventListener('click', () => {
          activeSubTab = id;
          renderSubTabs();
          void loadOwnPosts();
        });
        return btn;
      })
    );
  }

  function renderPosts() {
    if (destroyed) return;
    postsList.replaceChildren();
    if (!getPrimaryAccount()) return;

    if (loadingPosts && ownItems.length === 0) {
      postsList.appendChild(createLoadingState('Loading posts…'));
      return;
    }

    if (postError) {
      postsList.appendChild(createOfflineNotice({ variant: 'error', message: postError }));
      return;
    }

    if (ownItems.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = `No ${activeSubTab} yet.`;
      postsList.appendChild(empty);
      return;
    }

    const showSanctuary = connectionStore.get().mode === 'online' || connectionStore.get().programs.length > 0;
    for (const item of ownItems) {
      postsList.appendChild(
        createPostCard(item, {
          onReply: (p) => prefillReply(p),
          onToggleLike: async (p) => {
            const updated = await likeUnified(p);
            ownItems = ownItems.map((it) => (it.id === updated.id ? updated : it));
            renderPosts();
          },
          onToggleRepost: async (p) => {
            const updated = await repostUnified(p);
            ownItems = ownItems.map((it) => (it.id === updated.id ? updated : it));
            renderPosts();
          },
          onOpenThread: onOpenPostThread,
          onAskSanctuary,
          onSelectAuthor,
          onEditPost: (p) => {
            openEditPostDialog(p, {
              onSaved: (updated) => {
                ownItems = ownItems.map((it) => (it.id === updated.id ? updated : it));
                mutatePostAcrossStreams(updated.id, () => updated);
                renderPosts();
              },
            });
          },
          onTogglePin: async (p) => {
            const pinnedNow = Boolean(p._meta?.mastodon?.pinned);
            const updated = await pinUnified(p, pinnedNow);
            ownItems = activeSubTab === 'pinned' && pinnedNow
              ? ownItems.filter((it) => it.id !== updated.id)
              : ownItems.map((it) => (it.id === updated.id ? updated : it));
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
        })
      );
    }
  }

  const unsubAuth = authStore.subscribe(() => {
    if (!destroyed) renderHero();
  });

  renderHero();
  renderSubTabs();
  void refreshProfileFromServer().then(() => {
    if (!destroyed) return loadOwnPosts();
  });

  return {
    refresh: () => {
      renderHero();
      return loadOwnPosts();
    },
    destroy() {
      destroyed = true;
      unsubAuth();
    },
  };
}
