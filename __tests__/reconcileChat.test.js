import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import {
  LIVE_ROW_SELECTOR,
  parseMusicDiscoveryItems,
  reconcileChat,
  renderMessage,
} from '../web/components/sanctuary/MessageRow.js';

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
