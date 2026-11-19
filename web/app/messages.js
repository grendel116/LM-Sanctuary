import { createOfflineNotice } from '../components/OfflineNotice.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import {
  openImportProgramModal,
  openPaletteModal,
  openProgramCardModal,
} from '../components/sanctuary/ProgramModals.js';
import { showAlert, showConfirm } from '../components/sanctuary/SanctuaryDialog.js';
import {
  acceptBskyConvo,
  getBskyConvoForMembers,
  getBskyConvoMessages,
  getBskyProfile,
  listBskyConvos,
  sendBskyConvoMessage,
} from '../queries/bluesky.js';
import { getConversations, publishStatus } from '../queries/fediverse.js';
import {
  createSession,
  deleteProgram,
  deleteSession,
  fetchSessions,
  renameSession,
  resolveProgramAvatarUrl,
  selectProgram,
  startGroupSession,
} from '../queries/sanctuary.js';
import { authStore, getAuthenticatedAccount, updateAccountTokens } from '../state/authStore.js';
import { checkSanctuaryHealth, connectionStore } from '../state/sanctuary/connection.js';
import { sessionStore } from '../state/sanctuary/sessionModel.js';
import { getCachedProgramHistory } from '../storage/kvStorage.js';
import { getCachedProgramsDirectory } from '../storage/nativeStore.js';

const SEND_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
const PALETTE_ICON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"></circle><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"></circle><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"></circle><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"></circle><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"></path></svg>`;
const EDIT_ICON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path><path d="m15 5 4 4"></path></svg>`;
const TRASH_ICON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>`;
const PLUS_CHAT_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>`;
const USER_PLUS_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><line x1="19" y1="8" x2="19" y2="14"></line><line x1="22" y1="11" x2="16" y2="11"></line></svg>`;

function normalizeSessionItem(raw, progMeta = {}) {
  if (typeof raw === 'string') {
    return {
      id: raw,
      programId: String(progMeta.id || ''),
      programName: String(progMeta.name || progMeta.id || ''),
      programAvatar: progMeta.avatarUrl || DEFAULT_AVATAR_DATA_URI,
      title: raw === 'default' ? 'Primary Chat' : raw,
      snippet: 'New conversation',
      message_count: 0,
      updated_at: 0,
      is_group: raw.startsWith('group_'),
    };
  }
  const id = String(raw?.id || 'default');
  const rawTitle = String(raw?.title || raw?.label || id);
  const title = rawTitle === 'default' ? 'Primary Chat' : rawTitle;
  const count = Number(raw?.message_count ?? 0);
  const snippet = raw?.snippet || (count > 0 ? `${count} messages` : 'New conversation');
  const programId = String(raw?.programId || progMeta.id || '');
  return {
    id,
    programId,
    programName: String(raw?.programName || progMeta.name || programId || ''),
    programAvatar:
      progMeta.avatarUrl && progMeta.avatarUrl !== DEFAULT_AVATAR_DATA_URI
        ? progMeta.avatarUrl
        : raw?.programAvatar || DEFAULT_AVATAR_DATA_URI,
    title,
    snippet,
    message_count: count,
    updated_at: Number(raw?.updated_at ?? 0),
    is_group: Boolean(raw?.is_group),
  };
}

function formatSessionTime(epochSeconds) {
  const ts = Number(epochSeconds || 0);
  if (!ts) return '';
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderFormattedSnippet(containerEl, rawText) {
  const doc = containerEl?.ownerDocument || globalThis.document;
  const input = String(rawText || '');
  containerEl.replaceChildren();
  if (!input) return;

  const tokenRe = /(\*\*[^*]+?\*\*|`[^`]+`|\*[^*\n]+?\*|"[^"\n]+?"|“[^”\n]+?”|\*[^*\n]+$)/g;
  let lastIdx = 0;
  for (const match of input.matchAll(tokenRe)) {
    if (match.index > lastIdx) {
      containerEl.appendChild(doc.createTextNode(input.slice(lastIdx, match.index)));
    }
    const tok = match[0];
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
      const s = doc.createElement('strong');
      s.textContent = tok.slice(2, -2);
      containerEl.appendChild(s);
    } else if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
      const c = doc.createElement('code');
      c.textContent = tok.slice(1, -1);
      containerEl.appendChild(c);
    } else if (tok.startsWith('*')) {
      const em = doc.createElement('em');
      em.textContent = tok.endsWith('*') && tok.length > 2 ? tok.slice(1, -1) : tok.slice(1);
      containerEl.appendChild(em);
    } else if (tok.startsWith('"') || tok.startsWith('“')) {
      const q = doc.createElement('span');
      q.className = 'dialogue-quote';
      q.textContent = tok;
      containerEl.appendChild(q);
    } else {
      containerEl.appendChild(doc.createTextNode(tok));
    }
    lastIdx = match.index + tok.length;
  }
  if (lastIdx < input.length) {
    containerEl.appendChild(doc.createTextNode(input.slice(lastIdx)));
  }
}

function deriveLiveSnippetFromMessages(messages = []) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'program' && m.role !== 'model')) continue;
    const msgId = String(m.id || '');
    if (/^(tool_|port_|quest_|sys_|itm_)/.test(msgId)) continue;
    const raw = m.shared_post
      ? (String(m.user_note || '').trim() || `Shared post from ${m.shared_post.authorHandle || m.shared_post.authorName || 'feed'}`)
      : String(m.text || '').trim();
    if (raw.startsWith('[Tool Response') || raw.toLowerCase().startsWith('[system:')) continue;
    const text = raw ? raw.replace(/!\[[^\]]*\]\([^)]+\)/g, '[Image]').replace(/\s+/g, ' ').trim() : (m.image_url ? '[Image]' : '');
    if (!text) continue;
    const clipped = text.length > 260 ? `${text.slice(0, 259).trimEnd()}…` : text;
    return m.role === 'user' ? `You: ${clipped}` : clipped;
  }
  return '';
}

/**
 * Messages screen: `Direct` holds human DMs alongside all Programs' chat
 * sessions under `Program Chats`, while `Programs` manages Program entries.
 */
export function mountMessagesScreen(containerEl, {
  initialTab = 'direct',
  initialProgramId = '',
  activeUser = 'User',
  currentProgramId = '',
  currentSessionId = 'default',
  onSwitchProgram,
  onOpenCompose,
  onOpenAccounts,
  onProgramChanged,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();

  let destroyed = false;
  let activeTab = initialProgramId ? 'programs' : (initialTab === 'programs' ? 'programs' : 'direct');
  let activeDirectConvo = null;
  let fediConvos = [];
  let bskyConvos = [];
  let dmLoading = false;
  let cachedPrograms = [];
  const sessionsByProgram = new Map();
  let activeProgId = currentProgramId || connectionStore.get().activeProgram || 'sebile';
  let newChatProgId = initialProgramId || activeProgId;
  let activeSessId = currentSessionId || 'default';
  let renamingSessionKey = null;
  const selectedGroupIds = new Set();

  function hasConnectedDmAccount(authState = authStore.get()) {
    if (!authState) return false;
    if (authState.isMastodonConnected || authState.isBlueskyConnected) return true;
    return Array.isArray(authState.accounts)
      && authState.accounts.some(
        (a) => a.platform === 'fediverse' || a.platform === 'mastodon' || a.platform === 'bluesky'
      );
  }

  const root = doc.createElement('section');
  root.className = 'messages-screen';

  const stageHeader = doc.createElement('div');
  stageHeader.className = 'stage-header messages-stage-header';
  const titleEl = doc.createElement('h1');
  titleEl.className = 'stage-title';
  titleEl.textContent = 'Messages';

  const tabsRow = doc.createElement('div');
  tabsRow.className = 'stage-tabs';
  const directTabBtn = doc.createElement('button');
  directTabBtn.type = 'button';
  directTabBtn.className = 'stage-tab-btn';
  directTabBtn.dataset.messagesTab = 'direct';
  const directTabLabel = doc.createElement('span');
  directTabLabel.className = 'stage-tab-label';
  directTabLabel.textContent = 'Direct';
  directTabBtn.appendChild(directTabLabel);

  const programsTabBtn = doc.createElement('button');
  programsTabBtn.type = 'button';
  programsTabBtn.className = 'stage-tab-btn';
  programsTabBtn.dataset.messagesTab = 'programs';
  const programsTabLabel = doc.createElement('span');
  programsTabLabel.className = 'stage-tab-label';
  programsTabLabel.textContent = 'Programs';
  programsTabBtn.appendChild(programsTabLabel);

  tabsRow.append(directTabBtn, programsTabBtn);
  stageHeader.append(titleEl, tabsRow);

  const bodyHost = doc.createElement('div');
  bodyHost.className = 'messages-body-host';

  root.append(stageHeader, bodyHost);
  containerEl.appendChild(root);

  function getProgramsDirectory() {
    const connProgs = connectionStore.get().programs;
    return Array.isArray(connProgs) && connProgs.length > 0 ? connProgs : cachedPrograms;
  }

  function resolveProgramMeta(prog, conn = connectionStore.get()) {
    const id = typeof prog === 'string' ? prog : String(prog?.id || '');
    const name = (typeof prog === 'object' && prog?.name) ? String(prog.name) : id;
    const avatarVer = Number((id && conn?.avatarVersions?.[id]) || conn?.avatarVersions?.__default || 0);
    const hasProfile = Boolean(conn?.nodeUrl && ((typeof prog === 'object' && prog?.has_profile) || avatarVer > 0));
    return {
      id,
      name,
      avatarUrl: hasProfile
        ? resolveProgramAvatarUrl(id, { nodeUrl: conn.nodeUrl, cacheBuster: avatarVer })
        : DEFAULT_AVATAR_DATA_URI,
    };
  }

  directTabBtn.addEventListener('click', () => {
    activeTab = 'direct';
    activeDirectConvo = null;
    void loadAllProgramSessions();
    renderView();
  });

  programsTabBtn.addEventListener('click', () => {
    activeTab = 'programs';
    activeDirectConvo = null;
    renamingSessionKey = null;
    renderView();
  });

  async function loadSessionsForProgram(progOrId, { renderOnFinish = true } = {}) {
    const conn = connectionStore.get();
    const programs = getProgramsDirectory();
    const progObj = typeof progOrId === 'string'
      ? (programs.find((p) => p.id === progOrId) || { id: progOrId })
      : progOrId;
    if (!progObj?.id) return;

    const meta = resolveProgramMeta(progObj, conn);
    const liveSess = sessionStore.get();
    const fallbackSessId = meta.id === activeProgId ? (activeSessId || 'default') : 'default';
    const liveSnippet = liveSess.activeProgramId === meta.id
      ? deriveLiveSnippetFromMessages(liveSess.messages)
      : '';

    if (conn.mode !== 'online') {
      const cached = await getCachedProgramHistory(meta.id, fallbackSessId).catch(() => null);
      if (destroyed) return;
      const offlineMsgs = liveSess.activeProgramId === meta.id && Array.isArray(liveSess.messages) && liveSess.messages.length > 0
        ? liveSess.messages
        : (Array.isArray(cached?.history) ? cached.history : []);
      const offlineSnippet = liveSnippet || deriveLiveSnippetFromMessages(offlineMsgs);
      sessionsByProgram.set(meta.id, [
        normalizeSessionItem(
          {
            id: fallbackSessId,
            title: fallbackSessId === 'default' ? 'Primary Chat' : fallbackSessId,
            snippet: offlineSnippet || 'Cached conversation',
            message_count: offlineMsgs.length,
          },
          meta
        ),
      ]);
      if (renderOnFinish && activeTab === 'direct' && !activeDirectConvo && !destroyed) renderView();
      return;
    }

    try {
      const data = await fetchSessions(meta.id);
      if (destroyed) return;
      const rawList = Array.isArray(data?.sessions) && data.sessions.length > 0
        ? data.sessions
        : [{ id: 'default', title: 'Primary Chat' }];
      const liveTargetSessId = liveSess.activeSessionId || 'default';
      sessionsByProgram.set(
        meta.id,
        rawList.map((item) => {
          const norm = normalizeSessionItem(item, meta);
          if (liveSnippet && liveSess.activeProgramId === meta.id && norm.id === liveTargetSessId) {
            return {
              ...norm,
              snippet: liveSnippet,
              message_count: liveSess.messages?.length || norm.message_count,
            };
          }
          return norm;
        })
      );
      if (meta.id === activeProgId && data?.active_session && !activeSessId) {
        activeSessId = data.active_session;
      }
      if (renderOnFinish && activeTab === 'direct' && !activeDirectConvo && !destroyed) renderView();
    } catch {
      if (destroyed) return;
      sessionsByProgram.set(meta.id, [
        normalizeSessionItem(
          {
            id: fallbackSessId,
            title: fallbackSessId === 'default' ? 'Primary Chat' : fallbackSessId,
            snippet: liveSnippet || 'No messages yet',
          },
          meta
        ),
      ]);
      if (renderOnFinish && activeTab === 'direct' && !activeDirectConvo && !destroyed) renderView();
    }
  }

  async function loadAllProgramSessions() {
    const programs = getProgramsDirectory();
    const validIds = new Set(programs.map((p) => p.id));
    for (const key of sessionsByProgram.keys()) {
      if (!validIds.has(key)) sessionsByProgram.delete(key);
    }
    if (!Array.isArray(programs) || programs.length === 0) return;
    await Promise.all(programs.map((prog) => loadSessionsForProgram(prog, { renderOnFinish: false })));
    if (activeTab === 'direct' && !activeDirectConvo && !destroyed) renderView();
  }

  async function refreshLists() {
    dmLoading = true;
    try {
      const [progsFromStore, fediAuth, bskyAuth] = await Promise.all([
        getCachedProgramsDirectory().catch(() => []),
        getAuthenticatedAccount('fediverse'),
        getAuthenticatedAccount('bluesky'),
      ]);
      if (destroyed) return;
      cachedPrograms = progsFromStore;

      const tasks = [];
      if (fediAuth) {
        tasks.push(
          getConversations({
            instanceUrl: fediAuth.meta.instanceUrl,
            accessToken: fediAuth.secrets.accessToken,
          })
            .then((list) => {
              fediConvos = list.map((c) => ({
                kind: 'human',
                network: 'fediverse',
                id: c.id,
                displayName: c.accounts[0]?.displayName || c.accounts[0]?.acct || 'Direct Message',
                handle: c.accounts[0]?.acct || '',
                avatar: c.accounts[0]?.avatar || '',
                snippet: String(c.lastStatus?.contentHtml || '').replace(/<[^>]*>/g, '').slice(0, 120),
                unread: c.unread,
                status: 'accepted',
                rawConvo: c,
              }));
            })
            .catch(() => {})
        );
      } else {
        fediConvos = [];
      }

      if (bskyAuth) {
        tasks.push(
          listBskyConvos({
            serviceUrl: bskyAuth.meta.serviceUrl,
            accessJwt: bskyAuth.secrets.accessJwt,
            refreshJwt: bskyAuth.secrets.refreshJwt,
            onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok),
          })
            .then((data) => {
              bskyConvos = (data?.convos || []).map((c) => {
                const peer = (c.members || []).find((m) => m.did !== bskyAuth.meta.did) || c.members?.[0];
                return {
                  kind: 'human',
                  network: 'bluesky',
                  id: c.id,
                  displayName: peer?.displayName || peer?.handle || 'Bluesky DM',
                  handle: peer?.handle || '',
                  avatar: peer?.avatar || '',
                  snippet: c.lastMessage?.text || '',
                  unread: (c.unreadCount || 0) > 0,
                  status: c.status || 'accepted',
                  rawConvo: c,
                };
              });
            })
            .catch(() => {})
        );
      } else {
        bskyConvos = [];
      }

      if (getProgramsDirectory().length > 0 && sessionsByProgram.size === 0) {
        tasks.push(loadAllProgramSessions());
      }
      await Promise.all(tasks);
    } finally {
      dmLoading = false;
      if (!destroyed) renderView();
    }
  }

  function renderHumanThread(convo) {
    bodyHost.replaceChildren();
    const wrap = doc.createElement('div');
    wrap.className = 'human-dm-thread';

    const header = doc.createElement('div');
    header.className = 'human-dm-header';
    const backBtn = doc.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'edit-btn edit-cancel-btn';
    backBtn.textContent = '← Back';
    backBtn.addEventListener('click', () => {
      activeDirectConvo = null;
      renderView();
    });

    const peerTitle = doc.createElement('strong');
    peerTitle.className = 'human-dm-peer-name';
    peerTitle.textContent = convo.displayName || convo.handle || 'Direct Message';

    const peerHandle = doc.createElement('span');
    peerHandle.className = 'post-author-handle';
    peerHandle.textContent = convo.handle ? `@${convo.handle.replace(/^@/, '')}` : '';

    header.append(backBtn, peerTitle, peerHandle);

    const streamEl = doc.createElement('div');
    streamEl.className = 'human-dm-messages';
    const loadingEl = doc.createElement('p');
    loadingEl.className = 'empty-state';
    loadingEl.textContent = convo.rawConvo || convo.network === 'bluesky'
      ? 'Loading messages...'
      : `Send a direct Fediverse mention to @${String(convo.handle || '').replace(/^@/, '')}.`;
    streamEl.appendChild(loadingEl);

    const replyForm = doc.createElement('form');
    replyForm.className = 'sanctuary-input-area human-dm-reply-form';
    const wrapper = doc.createElement('div');
    wrapper.className = 'input-wrapper';

    const lbl = doc.createElement('label');
    lbl.setAttribute('for', 'human-dm-input');
    lbl.className = 'sr-only';
    lbl.textContent = 'Direct message';

    const input = doc.createElement('input');
    input.type = 'text';
    input.id = 'human-dm-input';
    input.className = 'human-dm-input';
    input.placeholder = `Message ${convo.displayName || convo.handle || 'peer'}`;

    const sendBtn = doc.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'send-btn';
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.title = 'Send';
    sendBtn.innerHTML = SEND_SVG;

    wrapper.append(lbl, input, sendBtn);
    replyForm.appendChild(wrapper);
    wrap.append(header, streamEl, replyForm);
    bodyHost.appendChild(wrap);

    async function loadMessages() {
      if (convo.network === 'bluesky') {
        const bsky = await getAuthenticatedAccount('bluesky');
        if (!bsky) return;
        const data = await getBskyConvoMessages({
          serviceUrl: bsky.meta.serviceUrl,
          accessJwt: bsky.secrets.accessJwt,
          refreshJwt: bsky.secrets.refreshJwt,
          onSessionRefreshed: (tok) => updateAccountTokens(bsky.meta.id, tok),
          convoId: convo.id,
        });
        if (destroyed) return;
        const msgs = [...(data?.messages || [])].reverse();
        streamEl.replaceChildren(
          ...msgs.map((m) => {
            const b = doc.createElement('div');
            b.className = `human-dm-bubble ${m.sender?.did === bsky.meta.did ? 'is-me' : 'is-peer'}`;
            b.textContent = m.text || '';
            return b;
          })
        );
      } else if (convo.rawConvo?.lastStatus) {
        const b = doc.createElement('div');
        b.className = 'human-dm-bubble is-peer';
        b.textContent = String(convo.rawConvo.lastStatus.contentHtml || '').replace(/<[^>]*>/g, '');
        streamEl.replaceChildren(b);
      }
    }

    replyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      try {
        if (convo.network === 'bluesky') {
          const bsky = await getAuthenticatedAccount('bluesky');
          if (!bsky) throw new Error('Connect Bluesky under User → Accounts.');
          if (convo.status === 'request') {
            await acceptBskyConvo({
              serviceUrl: bsky.meta.serviceUrl,
              accessJwt: bsky.secrets.accessJwt,
              refreshJwt: bsky.secrets.refreshJwt,
              onSessionRefreshed: (tok) => updateAccountTokens(bsky.meta.id, tok),
              convoId: convo.id,
            });
          }
          await sendBskyConvoMessage({
            serviceUrl: bsky.meta.serviceUrl,
            accessJwt: bsky.secrets.accessJwt,
            refreshJwt: bsky.secrets.refreshJwt,
            onSessionRefreshed: (tok) => updateAccountTokens(bsky.meta.id, tok),
            convoId: convo.id,
            text,
          });
          input.value = '';
          await loadMessages();
        } else {
          const fedi = await getAuthenticatedAccount('fediverse');
          if (!fedi) throw new Error('Connect Fediverse under User → Accounts.');
          const prefix = convo.handle ? `@${String(convo.handle).replace(/^@/, '')} ` : '';
          await publishStatus({
            instanceUrl: fedi.meta.instanceUrl,
            accessToken: fedi.secrets.accessToken,
            status: text.startsWith('@') ? text : `${prefix}${text}`,
            visibility: 'direct',
            inReplyToId: convo.rawConvo?.lastStatus?.id || null,
          });
          input.value = '';
          if (streamEl.querySelector('.empty-state')) streamEl.replaceChildren();
          const sent = doc.createElement('div');
          sent.className = 'human-dm-bubble is-me';
          sent.textContent = text;
          streamEl.appendChild(sent);
        }
      } catch (err) {
        showAlert('Message Failed', err?.message || 'Unable to send direct message.');
      } finally {
        sendBtn.disabled = false;
      }
    });

    if (convo.rawConvo || convo.network === 'bluesky') {
      void loadMessages();
    }
  }

  function appendAllProgramSessionsSection(parentEl) {
    const conn = connectionStore.get();
    const programs = getProgramsDirectory();
    if (!Array.isArray(programs) || programs.length === 0) return null;

    const isOnline = conn.mode === 'online';
    const progById = new Map(
      programs.map((p, idx) => [p.id, { prog: p, meta: resolveProgramMeta(p, conn), order: idx }])
    );
    const targetNewProgId = progById.has(newChatProgId)
      ? newChatProgId
      : (progById.has(activeProgId) ? activeProgId : programs[0].id);
    newChatProgId = targetNewProgId;

    const convHeader = doc.createElement('div');
    convHeader.className = 'messages-section-header conversations-header';

    const convLabel = doc.createElement('span');
    convLabel.className = 'messages-section-label';
    convLabel.textContent = 'Program Chats';

    const convActions = doc.createElement('div');
    convActions.className = 'messages-header-actions';

    let progPicker = null;
    if (programs.length >= 2) {
      progPicker = doc.createElement('select');
      progPicker.className = 'glass-select messages-program-picker';
      progPicker.setAttribute('aria-label', 'Program for new chat');
      for (const prog of programs) {
        const opt = doc.createElement('option');
        opt.value = prog.id;
        opt.textContent = prog.name || prog.id;
        opt.selected = prog.id === targetNewProgId;
        progPicker.appendChild(opt);
      }
      progPicker.value = targetNewProgId;
      progPicker.addEventListener('change', () => {
        newChatProgId = progPicker.value || targetNewProgId;
      });
      convActions.appendChild(progPicker);
    }

    const newSessBtn = doc.createElement('button');
    newSessBtn.type = 'button';
    newSessBtn.className = 'messages-header-pill is-accent';
    newSessBtn.dataset.action = 'new-session';
    newSessBtn.innerHTML = `${PLUS_CHAT_SVG}<span>New Chat</span>`;
    newSessBtn.addEventListener('click', async () => {
      const chosenProgId = progPicker?.value || newChatProgId || targetNewProgId;
      const chosenMeta = progById.get(chosenProgId)?.meta || resolveProgramMeta(chosenProgId, conn);
      if (isOnline) {
        newSessBtn.disabled = true;
        try {
          const res = await createSession({ programId: chosenProgId });
          if (destroyed) return;
          const created = res?.session ? normalizeSessionItem(res.session, chosenMeta) : null;
          const nextSid = res?.active_session || created?.id || `chat_${Date.now()}`;
          activeProgId = chosenProgId;
          newChatProgId = chosenProgId;
          activeSessId = nextSid;
          renamingSessionKey = null;
          if (created) {
            const prevList = sessionsByProgram.get(chosenProgId) || [];
            sessionsByProgram.set(chosenProgId, [created, ...prevList.filter((s) => s.id !== created.id)]);
          }
          onSwitchProgram?.(chosenProgId, nextSid);
          renderView();
          void loadSessionsForProgram(chosenProgId);
        } catch (err) {
          showAlert('New Chat Failed', err?.message || 'Unable to start conversation.');
        } finally {
          newSessBtn.disabled = false;
        }
        return;
      }
      const nextSid = `chat_${Date.now()}`;
      activeProgId = chosenProgId;
      newChatProgId = chosenProgId;
      activeSessId = nextSid;
      renamingSessionKey = null;
      const prevList = sessionsByProgram.get(chosenProgId) || [];
      sessionsByProgram.set(chosenProgId, [
        normalizeSessionItem(
          { id: nextSid, title: 'New Chat', snippet: 'New conversation', updated_at: Math.floor(Date.now() / 1000) },
          chosenMeta
        ),
        ...prevList,
      ]);
      onSwitchProgram?.(chosenProgId, nextSid);
      renderView();
    });

    convActions.appendChild(newSessBtn);
    convHeader.append(convLabel, convActions);
    parentEl.appendChild(convHeader);

    const sessionsHost = doc.createElement('div');
    sessionsHost.className = 'messages-rows-list session-chats-list';

    const allSessions = [];
    for (const [pid, { meta, order }] of progById.entries()) {
      const rawBucket = sessionsByProgram.get(pid);
      const list = Array.isArray(rawBucket) && rawBucket.length > 0
        ? rawBucket.map((item) => normalizeSessionItem(item, meta))
        : [normalizeSessionItem({ id: 'default', title: 'Primary Chat' }, meta)];
      if (pid === activeProgId && activeSessId && !list.some((s) => s.id === activeSessId)) {
        list.unshift(
          normalizeSessionItem(
            { id: activeSessId, title: activeSessId === 'default' ? 'Primary Chat' : activeSessId },
            meta
          )
        );
      }
      for (const sess of list) {
        allSessions.push({ ...sess, progOrder: order });
      }
    }

    allSessions.sort((a, b) => {
      if (b.updated_at !== a.updated_at) return b.updated_at - a.updated_at;
      const aActive = a.programId === activeProgId && a.id === activeSessId ? 1 : 0;
      const bActive = b.programId === activeProgId && b.id === activeSessId ? 1 : 0;
      if (bActive !== aActive) return bActive - aActive;
      return a.progOrder - b.progOrder;
    });

    let focusRenameEl = null;

    for (const sess of allSessions) {
      const sessionKey = `${sess.programId}:${sess.id}`;
      const isCurrent = sess.programId === activeProgId && sess.id === activeSessId;
      const isRenaming = renamingSessionKey === sessionKey;

      const row = doc.createElement('div');
      row.className = `convo-row convo-row--session${isCurrent ? ' is-selected' : ''}`;
      row.dataset.programId = sess.programId;
      row.dataset.sessionId = sess.id;

      const rowMain = doc.createElement(isRenaming ? 'div' : 'button');
      if (!isRenaming) rowMain.type = 'button';
      rowMain.className = 'convo-row-main';

      const avatarWrap = doc.createElement('div');
      avatarWrap.className = 'convo-avatar-wrap';
      const img = doc.createElement('img');
      img.className = 'convo-avatar';
      img.src = sess.programAvatar || DEFAULT_AVATAR_DATA_URI;
      img.alt = sess.programName || sess.title;
      avatarWrap.appendChild(img);
      if (isCurrent) {
        const dot = doc.createElement('span');
        dot.className = 'convo-active-dot';
        dot.setAttribute('aria-hidden', 'true');
        avatarWrap.appendChild(dot);
      }

      const bodyCol = doc.createElement('div');
      bodyCol.className = 'convo-body';

      const topLine = doc.createElement('div');
      topLine.className = 'convo-top-line';

      if (isRenaming) {
        const progTitleEl = doc.createElement('strong');
        progTitleEl.className = 'convo-title';
        progTitleEl.textContent = sess.programName;

        const renameInput = doc.createElement('input');
        renameInput.type = 'text';
        renameInput.className = 'session-rename-input';
        renameInput.value = sess.title;
        renameInput.setAttribute('aria-label', `Conversation title for ${sess.programName}`);
        let finished = false;
        const finishRename = async (save) => {
          if (finished) return;
          finished = true;
          renamingSessionKey = null;
          const nextTitle = renameInput.value.trim();
          if (save && isOnline && nextTitle !== sess.title) {
            try {
              await renameSession({ sessionId: sess.id, title: nextTitle, programId: sess.programId });
              await loadSessionsForProgram(sess.programId);
              return;
            } catch (err) {
              showAlert('Rename Failed', err?.message || 'Unable to rename conversation.');
            }
          }
          renderView();
        };
        renameInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void finishRename(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            void finishRename(false);
          }
        });
        renameInput.addEventListener('blur', () => {
          void finishRename(true);
        });
        topLine.append(progTitleEl, renameInput);
        focusRenameEl = renameInput;
      } else {
        const titleEl = doc.createElement('strong');
        titleEl.className = 'convo-title';
        titleEl.textContent = sess.is_group ? sess.title : (sess.programName || sess.title);

        const subtitleEl = doc.createElement('span');
        subtitleEl.className = 'post-author-handle convo-session-subtitle';
        subtitleEl.textContent = sess.is_group ? 'Group' : sess.title;

        const timeEl = doc.createElement('span');
        timeEl.className = 'convo-time';
        timeEl.textContent = formatSessionTime(sess.updated_at);
        topLine.append(titleEl, subtitleEl, timeEl);

        rowMain.addEventListener('click', () => {
          activeProgId = sess.programId;
          newChatProgId = sess.programId;
          activeSessId = sess.id;
          onSwitchProgram?.(sess.programId, sess.id);
          renderView();
        });
      }

      const snippetEl = doc.createElement('p');
      snippetEl.className = 'convo-snippet';
      renderFormattedSnippet(snippetEl, sess.snippet || 'No messages yet');

      bodyCol.append(topLine, snippetEl);
      rowMain.append(avatarWrap, bodyCol);

      const rowActions = doc.createElement('div');
      rowActions.className = 'row-icon-actions';

      const renameBtn = doc.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'row-icon-btn';
      renameBtn.title = 'Rename chat';
      renameBtn.setAttribute('aria-label', `Rename ${sess.programName} — ${sess.title}`);
      renameBtn.disabled = !isOnline;
      renameBtn.innerHTML = EDIT_ICON_SVG;
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renamingSessionKey = sessionKey;
        renderView();
      });

      const isDefault = sess.id === 'default';
      const delSessBtn = doc.createElement('button');
      delSessBtn.type = 'button';
      delSessBtn.className = 'row-icon-btn danger';
      delSessBtn.title = isDefault ? 'Clear conversation' : 'Delete conversation';
      delSessBtn.setAttribute(
        'aria-label',
        isDefault ? `Clear ${sess.programName} — ${sess.title}` : `Delete ${sess.programName} — ${sess.title}`
      );
      delSessBtn.disabled = !isOnline;
      delSessBtn.innerHTML = TRASH_ICON_SVG;
      delSessBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const heading = isDefault ? 'Clear Conversation' : 'Delete Conversation';
        const promptMsg = isDefault
          ? `Clear all messages in ${sess.programName}'s Primary Chat?`
          : `Delete "${sess.title}" from ${sess.programName}?`;
        showConfirm(heading, promptMsg, async () => {
          try {
            await deleteSession({ sessionId: sess.id, programId: sess.programId });
            if (isCurrent) {
              activeSessId = 'default';
              onSwitchProgram?.(sess.programId, 'default');
            }
            await loadSessionsForProgram(sess.programId);
          } catch (err) {
            showAlert('Delete Failed', err?.message || 'Unable to update conversation.');
          }
        });
      });

      rowActions.append(renameBtn, delSessBtn);
      row.append(rowMain, rowActions);
      sessionsHost.appendChild(row);
    }

    parentEl.appendChild(sessionsHost);
    return focusRenameEl;
  }

  function renderDirectTab() {
    if (activeDirectConvo) {
      renderHumanThread(activeDirectConvo);
      return;
    }

    const authState = authStore.get();
    const wrap = doc.createElement('div');
    wrap.className = 'messages-direct-pane';

    const newDmForm = doc.createElement('form');
    newDmForm.className = 'messages-new-dm-form';

    const handleInput = doc.createElement('input');
    handleInput.type = 'text';
    handleInput.className = 'onboarding-input';
    handleInput.placeholder = authState.isBlueskyConnected
      ? '@user@instance or handle.bsky.social'
      : '@user@instance';
    handleInput.setAttribute('aria-label', 'Recipient handle');

    const startDmBtn = doc.createElement('button');
    startDmBtn.type = 'submit';
    startDmBtn.className = 'edit-btn edit-save-btn';
    startDmBtn.textContent = 'Message';

    newDmForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = handleInput.value.trim().replace(/^@/, '');
      if (!raw) {
        onOpenCompose?.({ visibility: 'direct' });
        return;
      }
      const looksBluesky =
        authState.isBlueskyConnected
        && (raw.startsWith('did:') || (!raw.includes('@') && (raw.includes('.') || !authState.isMastodonConnected)));
      if (looksBluesky) {
        startDmBtn.disabled = true;
        try {
          const bsky = await getAuthenticatedAccount('bluesky');
          if (!bsky) throw new Error('Connect Bluesky under Profile → Accounts & Bridges.');
          let peerDid = raw.startsWith('did:') ? raw : '';
          let peerDisplay = raw;
          let peerAvatar = '';
          if (!peerDid) {
            const prof = await getBskyProfile({
              serviceUrl: bsky.meta.serviceUrl,
              accessJwt: bsky.secrets.accessJwt,
              refreshJwt: bsky.secrets.refreshJwt,
              onSessionRefreshed: (tok) => updateAccountTokens(bsky.meta.id, tok),
              actor: raw,
            });
            peerDid = prof?.did || '';
            peerDisplay = prof?.displayName || prof?.handle || raw;
            peerAvatar = prof?.avatar || '';
          }
          if (!peerDid) throw new Error(`Could not find Bluesky account @${raw}.`);
          const res = await getBskyConvoForMembers({
            serviceUrl: bsky.meta.serviceUrl,
            accessJwt: bsky.secrets.accessJwt,
            refreshJwt: bsky.secrets.refreshJwt,
            onSessionRefreshed: (tok) => updateAccountTokens(bsky.meta.id, tok),
            members: bsky.meta.did ? [bsky.meta.did, peerDid] : [peerDid],
          });
          if (destroyed) return;
          const convo = res?.convo;
          const peer = (convo?.members || []).find((m) => m.did !== bsky.meta.did) || convo?.members?.[0];
          activeDirectConvo = {
            kind: 'human',
            network: 'bluesky',
            id: convo?.id || '',
            displayName: peer?.displayName || peerDisplay || raw,
            handle: peer?.handle || raw,
            avatar: peer?.avatar || peerAvatar || '',
            status: convo?.status || 'accepted',
            rawConvo: convo || null,
          };
          renderView();
        } catch (err) {
          showAlert('Direct Message Failed', err?.message || 'Unable to start Bluesky conversation.');
        } finally {
          startDmBtn.disabled = false;
        }
        return;
      }

      activeDirectConvo = {
        kind: 'human',
        network: 'fediverse',
        id: `new:${raw}`,
        displayName: `@${raw}`,
        handle: raw,
        avatar: '',
        status: 'accepted',
        rawConvo: null,
      };
      renderView();
    });
    newDmForm.append(handleInput, startDmBtn);
    wrap.appendChild(newDmForm);

    const focusRenameEl = appendAllProgramSessionsSection(wrap);
    if (getProgramsDirectory().length > 0) {
      const dmHeader = doc.createElement('div');
      dmHeader.className = 'messages-section-header';
      const dmLabel = doc.createElement('span');
      dmLabel.className = 'messages-section-label';
      dmLabel.textContent = 'Direct Messages';
      dmHeader.appendChild(dmLabel);
      wrap.appendChild(dmHeader);
    }

    const rowsHost = doc.createElement('div');
    rowsHost.className = 'messages-rows-list';
    const humanPool = [...fediConvos, ...bskyConvos];

    for (const convo of humanPool) {
      const rowBtn = doc.createElement('button');
      rowBtn.type = 'button';
      rowBtn.className = 'convo-row convo-row--human';

      const avatarWrap = doc.createElement('div');
      avatarWrap.className = 'convo-avatar-wrap';
      const img = doc.createElement('img');
      img.className = 'convo-avatar';
      img.src = convo.avatar || DEFAULT_AVATAR_DATA_URI;
      img.alt = convo.displayName;
      avatarWrap.appendChild(img);

      const bodyCol = doc.createElement('div');
      bodyCol.className = 'convo-body';

      const topLine = doc.createElement('div');
      topLine.className = 'convo-top-line';
      const nameEl = doc.createElement('strong');
      nameEl.textContent = convo.displayName;
      topLine.appendChild(nameEl);
      if (convo.handle) {
        const handleEl = doc.createElement('span');
        handleEl.className = 'post-author-handle';
        handleEl.textContent = `@${String(convo.handle).replace(/^@/, '')}`;
        topLine.appendChild(handleEl);
      }

      const sub = doc.createElement('p');
      sub.className = 'convo-snippet';
      sub.textContent = convo.status === 'request'
        ? `Request · ${convo.snippet || 'New message request'}`
        : (convo.snippet || 'Direct conversation');

      bodyCol.append(topLine, sub);
      rowBtn.append(avatarWrap, bodyCol);
      rowBtn.addEventListener('click', () => {
        activeDirectConvo = convo;
        renderView();
      });
      rowsHost.appendChild(rowBtn);
    }

    if (humanPool.length === 0) {
      if (!hasConnectedDmAccount(authState)) {
        rowsHost.appendChild(
          createOfflineNotice({
            variant: 'info',
            message: 'Connect Mastodon or Bluesky under Profile → Accounts & Bridges.',
            actionLabel: 'Accounts',
            onAction: () => onOpenAccounts?.(),
          })
        );
      } else {
        const emptyDm = doc.createElement('p');
        emptyDm.className = 'empty-state';
        emptyDm.textContent = dmLoading ? 'Loading direct messages…' : 'No direct messages yet.';
        rowsHost.appendChild(emptyDm);
      }
    }

    wrap.appendChild(rowsHost);
    bodyHost.appendChild(wrap);

    if (focusRenameEl) {
      focusRenameEl.focus?.();
      focusRenameEl.select?.();
    }
  }

  function renderProgramsTab() {
    const conn = connectionStore.get();
    const programs = getProgramsDirectory();
    const isOnline = conn.mode === 'online';
    const currentId = activeProgId || conn.activeProgram || programs[0]?.id || 'sebile';

    const wrap = doc.createElement('div');
    wrap.className = 'messages-programs-pane';

    if (conn.mode === 'dormant' && programs.length === 0) {
      wrap.appendChild(
        createOfflineNotice({
          variant: 'info',
          message: 'Configure Sanctuary Node under Settings → Project Settings.',
        })
      );
    } else if (conn.mode === 'offline') {
      wrap.appendChild(
        createOfflineNotice({
          variant: 'offline',
          message: 'Node offline — cached Programs remain readable.',
        })
      );
    }

    // Programs Section Header (Strictly Program Management)
    const progHeader = doc.createElement('div');
    progHeader.className = 'messages-section-header';

    const progLabel = doc.createElement('span');
    progLabel.className = 'messages-section-label';
    progLabel.textContent = 'Programs';

    const progHeaderActions = doc.createElement('div');
    progHeaderActions.className = 'messages-header-actions';

    if (selectedGroupIds.size >= 2) {
      const groupBtn = doc.createElement('button');
      groupBtn.type = 'button';
      groupBtn.className = 'messages-header-pill is-accent';
      groupBtn.textContent = `Group Chat (${selectedGroupIds.size})`;
      groupBtn.disabled = !isOnline;
      groupBtn.addEventListener('click', async () => {
        const picked = Array.from(selectedGroupIds);
        const hostId = picked.includes(currentId) ? currentId : picked[0];
        const guestIds = picked.filter((id) => id !== hostId);
        groupBtn.disabled = true;
        try {
          const res = await startGroupSession(hostId, guestIds);
          if (res?.session_id) {
            activeProgId = hostId;
            newChatProgId = hostId;
            activeSessId = res.session_id;
            activeTab = 'direct';
            onSwitchProgram?.(hostId, res.session_id);
            await loadAllProgramSessions();
            renderView();
          }
        } catch (err) {
          showAlert('Group Session Failed', err?.message || 'Unable to start group session.');
        } finally {
          groupBtn.disabled = false;
        }
      });
      progHeaderActions.appendChild(groupBtn);
    }

    const importBtn = doc.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'messages-header-pill';
    importBtn.dataset.action = 'import-program';
    importBtn.innerHTML = `${USER_PLUS_SVG}<span>New Program</span>`;
    importBtn.disabled = !isOnline;
    importBtn.addEventListener('click', () => {
      openImportProgramModal({
        onCreated: async (res) => {
          await checkSanctuaryHealth();
          if (res?.program_id) {
            activeProgId = res.program_id;
            newChatProgId = res.program_id;
            activeSessId = 'default';
            onSwitchProgram?.(res.program_id, 'default');
          }
          await refreshLists();
          void onProgramChanged?.();
        },
      });
    });
    progHeaderActions.appendChild(importBtn);
    progHeader.append(progLabel, progHeaderActions);
    wrap.appendChild(progHeader);

    const rosterHost = doc.createElement('div');
    rosterHost.className = 'messages-rows-list program-roster-list';

    for (const prog of programs) {
      const isSelected = prog.id === currentId;
      const card = doc.createElement('div');
      card.className = `convo-row convo-row--program${isSelected ? ' is-selected' : ''}`;

      const mainBtn = doc.createElement('button');
      mainBtn.type = 'button';
      mainBtn.className = 'classic-select-card-main convo-row-main';

      const avatarWrap = doc.createElement('div');
      avatarWrap.className = 'convo-avatar-wrap';
      const avatarImg = doc.createElement('img');
      avatarImg.className = 'convo-avatar';
      avatarImg.src = resolveProgramMeta(prog, conn).avatarUrl;
      avatarImg.alt = prog.name || prog.id;
      avatarWrap.appendChild(avatarImg);
      if (isSelected) {
        const dot = doc.createElement('span');
        dot.className = 'convo-active-dot';
        dot.setAttribute('aria-hidden', 'true');
        avatarWrap.appendChild(dot);
      }

      const textStack = doc.createElement('div');
      textStack.className = 'convo-body';
      const nameRow = doc.createElement('div');
      nameRow.className = 'convo-top-line';
      const strongName = doc.createElement('strong');
      strongName.className = 'convo-title';
      strongName.textContent = prog.name || prog.id;
      nameRow.appendChild(strongName);

      textStack.appendChild(nameRow);
      if (!isOnline) {
        const sub = doc.createElement('p');
        sub.className = 'convo-snippet';
        sub.textContent = 'Sanctuary Offline • Tap to view cached chat';
        textStack.appendChild(sub);
      } else if (prog.personality) {
        const sub = doc.createElement('p');
        sub.className = 'convo-snippet';
        sub.textContent = prog.personality;
        textStack.appendChild(sub);
      }
      mainBtn.append(avatarWrap, textStack);
      mainBtn.addEventListener('click', async () => {
        activeProgId = prog.id;
        newChatProgId = prog.id;
        activeSessId = 'default';
        renamingSessionKey = null;
        if (isOnline) {
          try {
            await selectProgram(prog.id);
            await checkSanctuaryHealth();
          } catch (err) {
            showAlert('Switch Failed', err?.message || 'Unable to select Program.');
            return;
          }
        }
        onSwitchProgram?.(prog.id, 'default');
        await loadSessionsForProgram(prog.id);
        renderView();
      });

      const actions = doc.createElement('div');
      actions.className = 'row-icon-actions';

      if (programs.length >= 2) {
        const groupCheck = doc.createElement('input');
        groupCheck.type = 'checkbox';
        groupCheck.className = 'program-group-check';
        groupCheck.checked = selectedGroupIds.has(prog.id);
        groupCheck.disabled = !isOnline;
        groupCheck.title = 'Include in Group Session';
        groupCheck.setAttribute('aria-label', `Include ${prog.name || prog.id} in group session`);
        groupCheck.addEventListener('click', (e) => e.stopPropagation());
        groupCheck.addEventListener('change', () => {
          if (groupCheck.checked) selectedGroupIds.add(prog.id);
          else selectedGroupIds.delete(prog.id);
          renderView();
        });
        actions.appendChild(groupCheck);
      }

      const paletteBtn = doc.createElement('button');
      paletteBtn.type = 'button';
      paletteBtn.className = 'row-icon-btn';
      paletteBtn.title = 'Accent Palette';
      paletteBtn.setAttribute('aria-label', `Palette for ${prog.name || prog.id}`);
      paletteBtn.disabled = !isOnline;
      paletteBtn.innerHTML = PALETTE_ICON_SVG;
      paletteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openPaletteModal({
          programId: prog.id,
          programName: prog.name || prog.id,
          activeUser,
          activeProgramId: currentId,
          onUpdated: () => {
            void onProgramChanged?.();
            void refreshLists();
          },
        });
      });

      const editBtn = doc.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'row-icon-btn';
      editBtn.title = 'Edit Program';
      editBtn.setAttribute('aria-label', `Edit ${prog.name || prog.id}`);
      editBtn.disabled = !isOnline;
      editBtn.innerHTML = EDIT_ICON_SVG;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openProgramCardModal({
          programId: prog.id,
          activeUser,
          activeProgramId: currentId,
          onSaved: () => {
            void checkSanctuaryHealth();
            void onProgramChanged?.();
            void refreshLists();
          },
        });
      });

      const deleteBtn = doc.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'row-icon-btn danger';
      deleteBtn.title = 'Delete Program';
      deleteBtn.setAttribute('aria-label', `Delete ${prog.name || prog.id}`);
      deleteBtn.disabled = !isOnline || programs.length <= 1;
      deleteBtn.innerHTML = TRASH_ICON_SVG;
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showConfirm('Delete Program', `Delete "${prog.name || prog.id}" and its history?`, async () => {
          try {
            await deleteProgram(prog.id);
            selectedGroupIds.delete(prog.id);
            await checkSanctuaryHealth();
            await refreshLists();
            void onProgramChanged?.();
          } catch (err) {
            showAlert('Delete Failed', err?.message || 'Unable to delete Program.');
          }
        });
      });

      actions.append(paletteBtn, editBtn, deleteBtn);
      card.append(mainBtn, actions);
      rosterHost.appendChild(card);
    }

    if (programs.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No Programs available.';
      rosterHost.appendChild(empty);
    }

    wrap.appendChild(rosterHost);
    bodyHost.appendChild(wrap);
  }

  function renderView() {
    if (destroyed) return;
    directTabBtn.classList.toggle('active', activeTab === 'direct');
    directTabBtn.setAttribute('aria-pressed', activeTab === 'direct' ? 'true' : 'false');
    programsTabBtn.classList.toggle('active', activeTab === 'programs');
    programsTabBtn.setAttribute('aria-pressed', activeTab === 'programs' ? 'true' : 'false');

    bodyHost.replaceChildren();
    if (activeTab === 'programs') {
      renderProgramsTab();
    } else {
      renderDirectTab();
    }
  }

  let prevProgSig = `${connectionStore.get().mode}:${(connectionStore.get().programs || []).map((p) => p.id).join(',')}`;
  const unsubConn = connectionStore.subscribe((connState) => {
    if (destroyed) return;
    const sig = `${connState.mode}:${(connState.programs || []).map((p) => p.id).join(',')}`;
    if (sig !== prevProgSig) {
      prevProgSig = sig;
      if (activeTab === 'direct') void loadAllProgramSessions();
    }
    renderView();
  });

  const buildAuthSig = (s) =>
    `${Boolean(s?.hydrated)}:${s?.activeFediverseId || ''}:${s?.activeBlueskyId || ''}:${(s?.accounts || []).map((a) => a.id).join(',')}`;
  let prevAuthSig = buildAuthSig(authStore.get());
  const unsubAuth = authStore.subscribe((authState) => {
    if (destroyed) return;
    const sig = buildAuthSig(authState);
    if (sig !== prevAuthSig) {
      prevAuthSig = sig;
      void refreshLists();
    } else {
      renderView();
    }
  });

  let prevSessSig = '';
  const unsubSession = sessionStore.subscribe((sessState) => {
    if (destroyed || activeTab !== 'direct' || activeDirectConvo || renamingSessionKey) return;
    let progChanged = false;
    if (sessState.activeProgramId && sessState.activeProgramId !== activeProgId) {
      activeProgId = sessState.activeProgramId;
      newChatProgId = sessState.activeProgramId;
      progChanged = true;
    }
    if (sessState.activeSessionId && sessState.activeSessionId !== activeSessId) {
      activeSessId = sessState.activeSessionId;
    }
    if (progChanged) {
      void loadSessionsForProgram(activeProgId);
    }
    const snippet = deriveLiveSnippetFromMessages(sessState.messages);
    const sig = `${activeProgId}:${activeSessId}:${sessState.messages?.length || 0}:${snippet}`;
    if (sig === prevSessSig) return;
    prevSessSig = sig;
    if (snippet && activeProgId) {
      const bucket = sessionsByProgram.get(activeProgId);
      if (Array.isArray(bucket) && bucket.length > 0) {
        const meta = resolveProgramMeta(
          getProgramsDirectory().find((p) => p.id === activeProgId) || activeProgId
        );
        sessionsByProgram.set(
          activeProgId,
          bucket.map((item) => {
            const norm = normalizeSessionItem(item, meta);
            return norm.id === activeSessId
              ? { ...norm, snippet, message_count: sessState.messages?.length || norm.message_count }
              : norm;
          })
        );
      }
    }
    renderView();
  });

  if (activeTab === 'direct' && connectionStore.get().programs?.length > 0) {
    void loadAllProgramSessions();
  }
  void refreshLists();
  renderView();

  return {
    setTab(tabName) {
      activeTab = tabName === 'programs' ? 'programs' : 'direct';
      activeDirectConvo = null;
      renamingSessionKey = null;
      if (activeTab === 'direct') void loadAllProgramSessions();
      renderView();
    },
    destroy() {
      destroyed = true;
      unsubConn();
      unsubAuth();
      unsubSession();
    },
  };
}
