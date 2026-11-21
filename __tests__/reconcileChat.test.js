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
  updatePortraitGridToolbar,
} from '../web/components/sanctuary/PortraitGrid.js';
import { connectionStore } from '../web/state/sanctuary/connection.js';

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
