import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import {
  LIVE_ROW_SELECTOR,
  pairToolCalls,
  parseMusicDiscoveryItems,
  reconcileChat,
  renderLiveToolLogs,
  renderMessage,
} from '../web/components/sanctuary/MessageRow.js';
import {
  createPortraitGrid,
  MAX_IMAGES_PER_ROW,
  streamPortraitGeneration,
  updatePortraitGridToolbar,
} from '../web/components/sanctuary/PortraitGrid.js';
import { createToolApprovalCard } from '../web/components/sanctuary/ToolApprovalCard.js';
import { connectionStore } from '../web/state/sanctuary/connection.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('reconcileChat is idempotent, deduplicates IDs, preserves busy/transient rows, and clears queued badge', () => {
  const dom = installMockDom();
  try {
    const doc = dom.document;
    const chat = doc.createElement('div');
    chat.id = 'chat-container';
    const sentinel = doc.createElement('div');
    sentinel.id = 'bottom-sentinel';
    chat.appendChild(sentinel);

    // Transient notice should survive reconciliation
    renderMessage(chat, {
      id: 'notice_1',
      role: 'program',
      text: 'Temporary status',
      isTransient: true,
    });

    const history = [
      { id: 'usr_1', role: 'user', text: 'First draft', timestamp: 100, queued: true },
      { id: 'usr_1', role: 'user', text: 'First draft', timestamp: 100, queued: true }, // duplicate ID
      { id: 'prgm_1', role: 'program', sender_id: 'sebile', text: 'Reply "quoted" here', timestamp: 101 },
    ];

    const first = reconcileChat(chat, history, { programId: 'sebile' });
    assert.equal(first.changed, true);
    assert.equal(first.visibleCount, 2);
    assert.ok(chat.querySelector('.queued-badge'));
    assert.ok(chat.querySelector('.dialogue-quote'));

    // Second pass with unchanged history must be a no-op
    const second = reconcileChat(chat, history, { programId: 'sebile' });
    assert.equal(second.changed, false);

    // Protect row currently open in inline editor from being clobbered
    const progRow = chat.querySelector('[data-msg-id="prgm_1"]');
    const progBubble = progRow.querySelector('.message.program');
    progBubble.classList.add('editing');

    reconcileChat(chat, [
      { id: 'usr_1', role: 'user', text: 'First draft', timestamp: 100, queued: false },
      { id: 'prgm_1', role: 'program', sender_id: 'sebile', text: 'Changed on disk', timestamp: 102 },
    ]);

    // Queued badge removed on usr_1 once flushed, while prgm_1 still keeps editing bubble intact
    const usrRow = chat.querySelector('[data-msg-id="usr_1"]');
    assert.equal(usrRow.querySelector('.queued-badge'), null);
    assert.ok(chat.querySelector('[data-msg-id="prgm_1"] .message.editing'));
    assert.ok(chat.querySelector('[data-msg-id="notice_1"]'));
    assert.equal(chat.querySelectorAll(LIVE_ROW_SELECTOR).length, 3);

    // Once editing class is removed, reconcileChat must rebuild a row with stale edit-textarea even if contentHash matches
    progBubble.classList.remove('editing');
    const staleTa = doc.createElement('textarea');
    staleTa.className = 'edit-textarea';
    progBubble.replaceChildren(staleTa);

    const rebuilt = reconcileChat(chat, [
      { id: 'usr_1', role: 'user', text: 'First draft', timestamp: 100, queued: false },
      { id: 'prgm_1', role: 'program', sender_id: 'sebile', text: 'Changed on disk', timestamp: 102 },
    ]);
    assert.equal(rebuilt.changed, true);
    assert.equal(chat.querySelector('[data-msg-id="prgm_1"] .edit-textarea'), null);
    assert.ok(chat.querySelector('[data-msg-id="prgm_1"] .message-text'));
  } finally {
    dom.restore();
  }
});

test('MessageRow renders music discovery cards from search_music tool_calls', () => {
  const dom = installMockDom();
  try {
    const toolResponse = [
      "[Music Discovery: Mode='deep_cuts', Query='boards of canada']",
      '',
      '• Geogaddi Deep Dive',
      '  Details: Analogue tape warmth and hidden vignettes.',
      '  Link: https://bandcamp.com/tag/boards-of-canada',
      '  Source: Crate Digger',
    ].join('\n');

    const toolCalls = [{ type: 'call', id: 'tc1', name: 'search_music', args: { query: 'boards of canada' }, response: toolResponse }];
    const parsed = parseMusicDiscoveryItems(toolCalls);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].title, 'Geogaddi Deep Dive');

    const chat = dom.document.createElement('div');
    reconcileChat(chat, [{
      id: 'prgm_music',
      role: 'program',
      sender_id: 'sebile',
      text: 'Found this recording for you.',
      tool_calls: toolCalls,
    }]);

    const card = chat.querySelector('.music-discovery-card');
    assert.ok(card);
    assert.equal(card.querySelector('.music-discovery-title').textContent, 'Geogaddi Deep Dive');
    assert.equal(card.querySelector('.music-discovery-link').getAttribute('href'), 'https://bandcamp.com/tag/boards-of-canada');
  } finally {
    dom.restore();
  }
});

test('MessageRow pairs call/response tool_calls into a single collapsible Activity Log details card', () => {
  const dom = installMockDom();
  try {
    const rawToolCalls = [
      {
        type: 'call',
        id: 'call_1',
        name: 'read_webpage',
        args: { url: 'https://github.com/jobu-shoffone/CalliopeZED' },
      },
      {
        type: 'response',
        id: 'call_1',
        name: 'read_webpage',
        response: 'main\n\n[Branches](/jobu-shoffone/CalliopeZED/branches)',
      },
    ];

    const paired = pairToolCalls(rawToolCalls);
    assert.equal(paired.length, 1);
    assert.equal(paired[0].name, 'read_webpage');
    assert.ok(paired[0].response.includes('CalliopeZED'));

    const chat = dom.document.createElement('div');
    reconcileChat(chat, [{
      id: 'prgm_tools_1',
      role: 'program',
      sender_id: 'sebile',
      text: 'Checked the repo.',
      duration: 45.4,
      tool_calls: rawToolCalls,
    }]);

    const card = chat.querySelector('details.antigravity-logs-card');
    assert.ok(card);
    assert.equal(card.open, false);
    const headerText = card.querySelector('.ag-timer-text')?.textContent;
    assert.equal(headerText, 'Worked for 45.4s · 1 tool call');

    // Legacy unstyled class must not be emitted
    assert.equal(chat.querySelector('.tool-logs-summary-btn'), null);

    // Click summary opens outer card without duplicating read_webpage
    card.querySelector('summary.antigravity-logs-header').click();
    assert.equal(card.open, true);

    const entries = card.querySelectorAll('details.antigravity-log-entry');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].querySelector('.ag-log-action')?.textContent, 'Analyzed');
    assert.equal(entries[0].querySelector('.ag-log-target')?.textContent, 'github.com/jobu-shoffone/CalliopeZED');
    assert.equal(entries[0].open, false);

    // Click inner entry reveals Parameters + Response
    entries[0].querySelector('summary.antigravity-log-item').click();
    assert.equal(entries[0].open, true);
    const detailText = entries[0].querySelector('.antigravity-log-detail pre code')?.textContent || '';
    assert.match(detailText, /Parameters:/);
    assert.match(detailText, /CalliopeZED/);
    assert.match(detailText, /Response:/);
  } finally {
    dom.restore();
  }
});

test('renderLiveToolLogs preserves open state of card across polling ticks', () => {
  const dom = installMockDom();
  try {
    const bubble = dom.document.createElement('div');
    bubble.className = 'message program';

    renderLiveToolLogs(bubble, [
      { id: 'live_1', name: 'web_search', args: { query: 'skyrim shaders' }, status: 'running' },
    ]);

    const card = bubble.querySelector('details.antigravity-logs-card');
    assert.ok(card);
    assert.equal(card.open, false);
    assert.equal(card.querySelector('.ag-timer-text')?.textContent, 'Working... · 1 tool call');

    card.querySelector('summary.antigravity-logs-header').click();
    assert.equal(card.open, true);

    renderLiveToolLogs(bubble, [
      { id: 'live_1', name: 'web_search', args: { query: 'skyrim shaders' }, status: 'completed', duration: 1.4, response: 'Res 1' },
      { id: 'live_2', name: 'read_webpage', args: { url: 'https://example.com/a' }, status: 'running' },
      { id: 'live_3', name: 'antigravity:run_command', args: { CommandLine: 'pytest' }, status: 'cancelled', duration: 0.4 },
    ]);

    assert.equal(bubble.querySelector('details.antigravity-logs-card').open, true);
    assert.equal(card.querySelector('.ag-timer-text')?.textContent, 'Working... · 3 tool calls');
    const actions = Array.from(bubble.querySelectorAll('.ag-log-action')).map((el) => el.textContent);
    assert.ok(actions.includes('Stopped'));

    // Identical poll tick must skip DOM rebuild so open entries, animations, and pre scrollTop stay intact
    const snapshot = [
      { id: 'live_1', name: 'web_search', args: { query: 'skyrim shaders' }, status: 'completed', duration: 1.4, response: 'Res 1' },
      { id: 'live_2', name: 'read_webpage', args: { url: 'https://example.com/a' }, status: 'running' },
      { id: 'live_3', name: 'antigravity:run_command', args: { CommandLine: 'pytest' }, status: 'cancelled', duration: 0.4 },
    ];
    const firstEntry = bubble.querySelector('details.antigravity-log-entry');
    const firstPre = firstEntry?.querySelector('.antigravity-log-detail pre');
    if (firstPre) firstPre.scrollTop = 42;
    renderLiveToolLogs(bubble, snapshot);
    assert.equal(bubble.querySelector('details.antigravity-log-entry'), firstEntry);
    if (firstPre) assert.equal(firstPre.scrollTop, 42);
  } finally {
    dom.restore();
  }
});

test('renderLiveToolLogs formats OpenHands file_editor, terminal, and task sub-steps', () => {
  const dom = installMockDom();
  try {
    const bubble = dom.document.createElement('div');
    bubble.className = 'message program';

    renderLiveToolLogs(bubble, [
      { id: 'oh_1', name: 'openhands:file_editor', args: { command: 'view', path: 'sanctuary/tools/openhands_job.py', view_range: [1, 40] }, status: 'done', duration: 0.3 },
      { id: 'oh_2', name: 'openhands:file_editor', args: { command: 'str_replace', path: 'sanctuary/tools/openhands_job.py', old_str: 'a\nb', new_str: 'x\ny\nz' }, status: 'done', duration: 0.4 },
      { id: 'oh_3', name: 'openhands:terminal', args: { command: 'pytest -q' }, status: 'done', duration: 1.2 },
      { id: 'oh_4', name: 'openhands:task', args: { subagent_type: 'verifier', description: 'Run smoke tests' }, status: 'running' },
    ]);

    const card = bubble.querySelector('details.antigravity-logs-card');
    assert.ok(card);
    assert.equal(card.querySelector('.ag-timer-text')?.textContent, 'Working... · 4 tool calls');
    const actions = Array.from(bubble.querySelectorAll('.ag-log-action')).map((el) => el.textContent);
    const targets = Array.from(bubble.querySelectorAll('.ag-log-target')).map((el) => el.textContent);
    const suffixes = Array.from(bubble.querySelectorAll('.ag-log-suffix')).map((el) => el.textContent);
    assert.deepEqual(actions, ['Analyzed', 'Subagent', 'Edited', 'Ran']);
    assert.ok(targets[0].includes('openhands_job.py'));
    assert.equal(targets[1], 'verifier: Run smoke tests');
    assert.ok(targets[3].includes('pytest -q'));
    assert.ok(suffixes.some((d) => d.includes('#L1-40')));
    assert.ok(suffixes.some((d) => d.includes('+3 -2')));

    // Failed edit_file response renders Failed without misleading +0 -7 diff suffix
    const failBubble = dom.document.createElement('div');
    renderLiveToolLogs(failBubble, [
      {
        id: 'tc_fail_edit',
        name: 'edit_file',
        args: { path: 'web/assets/css/shell.css', target: 'a\nb\nc\nd\ne\nf\ng' },
        status: 'completed',
        response: 'Error: Target block not found in web/assets/css/shell.css.',
      },
    ]);
    assert.equal(failBubble.querySelector('.ag-log-action')?.textContent, 'Failed');
    assert.equal(failBubble.querySelector('.ag-log-suffix'), null);
  } finally {
    dom.restore();
  }
});

test('PortraitGrid renders trash delete icon, concise Regenerate toolbar label, and <progress> card spinner', async () => {
  const dom = installMockDom();
  const origFetch = globalThis.fetch;
  const prevNodeUrl = connectionStore.get().nodeUrl;
  connectionStore.set({ nodeUrl: 'http://127.0.0.1:5000' });
  try {
    const doc = dom.document;
    const bubble = doc.createElement('div');
    bubble.className = 'message program image-message';

    const grid = createPortraitGrid(
      [
        { url: '/images/portraits/p1.png', prompt: 'moonlit studio' },
        { url: '/images/portraits/v1.mp4', type: 'video', prompt: 'animated clip' },
      ],
      'msg_p1',
      'program',
      'sebile',
      'moonlit studio',
      { sessionId: 'default' }
    );
    // Simulate a single remaining portrait with 2 deleted slots for toolbar test
    grid.dataset.deletedCount = '2';
    bubble.appendChild(grid);
    updatePortraitGridToolbar(grid, { sessionId: 'default' });

    const delBtns = grid.querySelectorAll('.portrait-delete-btn');
    assert.equal(delBtns.length, 2);
    assert.equal(delBtns[0].getAttribute('aria-label'), 'Delete image');
    assert.equal(delBtns[1].getAttribute('aria-label'), 'Delete video');
    for (const delBtn of delBtns) {
      assert.match(delBtn.innerHTML, /<polyline points="3 6 5 6 21 6">/);
      assert.doesNotMatch(delBtn.innerHTML, /x1="18" y1="6"/);
    }

    const batchBtn = bubble.querySelector('.portrait-reroll-missing-btn');
    assert.ok(batchBtn);
    assert.equal(batchBtn.textContent, 'Regenerate');

    let resolveFetch;
    globalThis.fetch = () => new Promise((resolve) => {
      resolveFetch = resolve;
    });

    batchBtn.click();
    assert.equal(batchBtn.disabled, true);
    assert.equal(batchBtn.classList.contains('is-loading'), true);
    assert.equal(batchBtn.getAttribute('aria-busy'), 'true');
    assert.equal(batchBtn.textContent, 'Regenerate');

    resolveFetch(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(batchBtn.disabled, false);
    assert.equal(batchBtn.classList.contains('is-loading'), false);
    assert.equal(batchBtn.getAttribute('aria-busy'), null);
    assert.equal(batchBtn.textContent, 'Regenerate');

    const card = grid.querySelector('.message-image-container');
    const regenBtn = card.querySelector('.portrait-regen-btn');
    assert.ok(regenBtn);

    let resolveCardFetch;
    globalThis.fetch = () => new Promise((resolve) => {
      resolveCardFetch = resolve;
    });

    regenBtn.click();
    const overlay = card.querySelector('.image-loading-overlay');
    assert.ok(overlay);
    const spinner = overlay.querySelector('progress.loading-spinner');
    assert.ok(spinner);
    assert.equal(spinner.getAttribute('aria-label'), 'Regenerate image');
    assert.equal(spinner.getAttribute('value'), null);
    assert.equal(overlay.querySelector('.image-loading-text'), null);
    assert.doesNotMatch(overlay.textContent, /Regenerating/);

    resolveCardFetch(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(card.querySelector('.image-loading-overlay'), null);
  } finally {
    connectionStore.set({ nodeUrl: prevNodeUrl });
    globalThis.fetch = origFetch;
    dom.restore();
  }
});

test('portrait image stack caps at 2 per row and spans full row width', async () => {
  const dom = installMockDom();
  const origFetch = globalThis.fetch;
  const prevNodeUrl = connectionStore.get().nodeUrl;
  connectionStore.set({ nodeUrl: 'http://127.0.0.1:5000' });
  try {
    assert.equal(MAX_IMAGES_PER_ROW, 2);

    const doc = dom.document;
    const gridTwo = createPortraitGrid(
      [
        { url: '/images/portraits/p1.png', prompt: 'first' },
        { url: '/images/portraits/p2.png', prompt: 'second' },
        { url: '/images/portraits/p3.png', prompt: 'third' },
      ],
      'msg_p2',
      'program',
      'sebile',
      'two up',
      { sessionId: 'default' }
    );
    assert.equal(gridTwo.querySelectorAll('.message-image-container').length, 2);
    assert.equal(gridTwo.dataset.deletedCount, undefined);

    const gridOne = createPortraitGrid(
      [{ url: '/images/portraits/p1.png', prompt: 'only one' }],
      'msg_p1_rem',
      'program',
      'sebile',
      'one left',
      { sessionId: 'default' }
    );
    assert.equal(gridOne.querySelectorAll('.message-image-container').length, 1);
    assert.equal(gridOne.dataset.deletedCount, '1');

    const chat = doc.createElement('div');
    chat.id = 'chat-container';
    const sentinel = doc.createElement('div');
    sentinel.id = 'bottom-sentinel';
    chat.appendChild(sentinel);

    let pendingSlotsCount = 0;
    let hasFallbackContainer = false;
    let hasFallbackBubble = false;
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.count, 2);
      const placeholder = chat.querySelector('.portrait-stream-placeholder');
      pendingSlotsCount = placeholder?.querySelectorAll('.is-pending-slot').length || 0;
      hasFallbackContainer = Boolean(placeholder?.querySelector('.message-bubbles-container.has-portrait-grid'));
      hasFallbackBubble = Boolean(placeholder?.querySelector('.message.image-message.has-portrait-grid'));
      return new Response(JSON.stringify({ status: 'success' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await streamPortraitGeneration(chat, {
      sessionId: 'default',
      prompt: 'moonlit lake',
      speakerId: 'sebile',
      msgId: 'prgm_stream_2up',
    });
    assert.equal(pendingSlotsCount, 2);
    assert.equal(hasFallbackContainer, true);
    assert.equal(hasFallbackBubble, true);

    const css = fs.readFileSync(path.join(REPO_ROOT, 'web', 'assets', 'css', 'sanctuary.css'), 'utf8');
    assert.match(css, /\.portrait-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s);
    assert.match(css, /\.message-bubbles-container:has\(\.portrait-grid\)[^{]*\{[^}]*flex:\s*1\s+1\s+0%;[^}]*max-inline-size:\s*70%;/s);
    assert.match(css, /@supports\s+not\s+selector\(:has\(\*\)\)\s*\{[\s\S]*?\.message-bubbles-container\.has-portrait-grid/);
    assert.match(css, /\.user\s*\{[^}]*background:\s*var\(--user-bubble,\s*#1f1f22\);[^}]*border:\s*none;/s);

    // Theme changes update existing .message.program bubbles in place while keeping .message.user neutral
    const themeChat = doc.createElement('div');
    const themeSentinel = doc.createElement('div');
    themeSentinel.id = 'bottom-sentinel';
    themeChat.appendChild(themeSentinel);
    const sampleHistory = [
      { id: 'u1', role: 'user', text: 'Hello, Robin.' },
      { id: 'p1', role: 'program', sender_id: 'robin', text: 'Hello! *waves*' },
    ];
    reconcileChat(themeChat, sampleHistory, {
      programId: 'robin',
      theme: { primary_accent: '#f43f5e' },
    });
    const userBubble = themeChat.querySelector('.message.user');
    const progBubble = themeChat.querySelector('.message.program');
    assert.equal(userBubble.style.getPropertyValue('--program-bubble'), '');
    assert.equal(progBubble.style.getPropertyValue('--program-bubble-border'), 'rgba(244, 63, 94, 0.12)');

    reconcileChat(themeChat, sampleHistory, {
      programId: 'robin',
      theme: { primary_accent: '#eab308' },
    });
    assert.equal(themeChat.querySelector('.message.program'), progBubble);
    assert.equal(progBubble.style.getPropertyValue('--program-bubble-border'), 'rgba(234, 179, 8, 0.12)');
    assert.ok(progBubble.style.getPropertyValue('--program-bubble').includes('34, 31, 26'));
  } finally {
    connectionStore.set({ nodeUrl: prevNodeUrl });
    globalThis.fetch = origFetch;
    dom.restore();
  }
});

test('MessageRow renders sanctuary-plan Proceed/Revise card and sandboxed sanctuary-widget iframe', () => {
  const dom = installMockDom();
  try {
    const chat = dom.document.createElement('div');
    let proceededText = '';
    let revisedCalled = false;

    const msg = {
      id: 'p_plan_1',
      role: 'program',
      sender_id: 'sebile',
      text: [
        'Here is our cooperative plan and simulator:',
        '```sanctuary-plan',
        '## Goal',
        '- Consolidate GreenPT websearch and reranking.',
        '```',
        '```sanctuary-widget',
        '<div><button type="button">Simulate</button></div>',
        '```',
      ].join('\n'),
      tool_calls: [
        { id: 'cc_1', type: 'call', name: 'consult_cloud', args: { prompt: 'Check trade-offs', tier: 'deep' } },
        { id: 'cc_1', type: 'response', name: 'consult_cloud', response: '[CLOUD SYNTHESIS]' },
      ],
    };

    const row = renderMessage(chat, msg, {
      programId: 'sebile',
      onProceedPlan: (planMd) => {
        proceededText = planMd;
      },
      onRevisePlan: () => {
        revisedCalled = true;
      },
    });

    const planCard = row.querySelector('.sanctuary-plan-card');
    assert.ok(planCard);
    const planDetails = planCard.querySelector('details.sanctuary-plan-details');
    assert.ok(planDetails && planDetails.open);
    const planSummary = planDetails.querySelector('summary.sanctuary-plan-summary');
    assert.equal(planSummary.querySelectorAll('button, h1, h2, h3, h4').length, 0);

    const proceedBtn = planCard.querySelector('.plan-proceed-btn');
    const reviseBtn = planCard.querySelector('.plan-revise-btn');
    assert.ok(proceedBtn && reviseBtn);
    proceedBtn.click();
    reviseBtn.click();
    assert.match(proceededText, /Consolidate GreenPT websearch/);
    assert.equal(revisedCalled, true);

    const iframe = row.querySelector('iframe.sanctuary-widget-frame');
    assert.ok(iframe);
    assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(iframe.getAttribute('title'), 'Interactive Sanctuary widget');
    assert.equal(iframe.getAttribute('aria-hidden'), null);
    assert.match(iframe.srcdoc, /--primary-accent/);

    assert.equal(row.querySelector('.sanctuary-task-checklist'), null);

    const targets = Array.from(row.querySelectorAll('.ag-log-target')).map((el) => el.textContent);
    assert.ok(targets.includes('Cloud Model (deep)'));
  } finally {
    dom.restore();
  }
});

test('ToolApprovalCard renders interactive choice buttons when ask_user escalates to user', async () => {
  const dom = installMockDom();
  const origFetch = globalThis.fetch;
  const prevNodeUrl = connectionStore.get().nodeUrl;
  connectionStore.set({ nodeUrl: 'http://127.0.0.1:5000' });
  try {
    let postedBody = null;
    globalThis.fetch = async (_url, init) => {
      postedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ status: 'success' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    let resolvedStatus = '';
    const card = createToolApprovalCard({
      callId: 'choice_99',
      kind: 'choice',
      toolName: 'openhands:ask_user',
      details: 'Which cooperative forge should we push to?',
      options: ['Codeberg', 'Self-hosted Forgejo'],
      onResolved: (st) => {
        resolvedStatus = st;
      },
    });
    dom.document.body.appendChild(card);

    assert.equal(card.querySelector('.tool-approval-badge')?.textContent, 'Decision Requested');
    const optBtns = card.querySelectorAll('.tool-choice-option-btn');
    assert.equal(optBtns.length, 2);
    optBtns[1].click();
    await new Promise((r) => setTimeout(r, 15));

    assert.deepEqual(postedBody, {
      call_id: 'choice_99',
      status: 'approved',
      option_index: 1,
      answer_text: 'Self-hosted Forgejo',
    });
    assert.equal(resolvedStatus, 'approved');
  } finally {
    connectionStore.set({ nodeUrl: prevNodeUrl });
    globalThis.fetch = origFetch;
    dom.restore();
  }
});

test('renderLiveToolLogs renders file-type badges and single-line terminal summaries', () => {
  const dom = installMockDom();
  try {
    const bubble = dom.document.createElement('div');
    bubble.className = 'message program';

    renderLiveToolLogs(bubble, [
      { id: 'f1', name: 'openhands:file_editor', phase: 'Implementing', args: { command: 'view', path: 'web/queries/threads.js', view_range: [1, 140] }, status: 'done', duration: 0.2 },
      { id: 'f2', name: 'openhands:file_editor', phase: 'Implementing', args: { command: 'view', path: 'sanctuary/routes/social_bridge.py', view_range: [1, 110] }, status: 'done', duration: 0.2 },
      {
        id: 'c1',
        name: 'openhands:terminal',
        phase: 'Implementing',
        args: { command: 'Select-String -Path C:\\LLM\\LM-Sanctuary\\sanctuary\\state.py -Pattern "SANCTUARY_DIR|base_dir" | ForEach-Object { $_.Line }' },
        status: 'done',
        duration: 0.1,
      },
    ]);

    assert.equal(bubble.querySelector('.ag-timer-text')?.textContent, 'Implementing... · 3 tool calls');

    const badges = Array.from(bubble.querySelectorAll('.ag-filetype-badge')).map((el) => el.textContent);
    assert.deepEqual(badges, ['JS', 'PY']);

    const targets = Array.from(bubble.querySelectorAll('.ag-log-target')).map((el) => el.textContent);
    assert.ok(targets.some((t) => t === 'search "SANCTUARY_DIR|base_dir" in state.py'));
    const cmdDetail = Array.from(bubble.querySelectorAll('.antigravity-log-detail pre code'))
      .map((el) => el.textContent)
      .find((txt) => txt.includes('ForEach-Object'));
    assert.ok(cmdDetail, 'Full raw command must remain in expandable detail');
    assert.equal(bubble.querySelector('.sanctuary-task-checklist-card'), null);
    assert.equal(bubble.querySelector('details.antigravity-logs-card').open, false);
  } finally {
    dom.restore();
  }
});
