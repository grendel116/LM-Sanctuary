import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { buildMessageRow } from '../web/components/sanctuary/MessageRow.js';
import { composeStore, resetCompose } from '../web/state/composeStore.js';

test('user bubble renders FediverseShareButton in 4th .message-actions slot and prefills composeStore with text and media', () => {
  const dom = installMockDom();
  try {
    resetCompose();
    const userRow = buildMessageRow({
      id: 'usr_101',
      role: 'user',
      text: 'Shipping our sovereign Fediverse client today!',
      media: [{ url: '/images/portraits/hero.png', type: 'image' }],
      timestamp: 1763467200,
    });

    const userActions = userRow.querySelectorAll('.message.user .message-actions .action-icon-btn');
    assert.equal(userActions.length, 4);
    assert.equal(userActions[0].getAttribute('aria-label'), 'Reroll prompt');
    assert.equal(userActions[1].getAttribute('aria-label'), 'Edit message');
    assert.equal(userActions[2].getAttribute('aria-label'), 'Delete message');
    assert.ok(userActions[3].classList.contains('fediverse-share-btn'));

    // Program bubble holds .speak-btn in 4th slot and zero .fediverse-share-btn
    const progRow = buildMessageRow({
      id: 'prgm_102',
      role: 'program',
      sender_id: 'sebile',
      sender_name: 'Sebile',
      text: 'Everything in its place.',
      timestamp: 1763467205,
    });
    const progActions = progRow.querySelectorAll('.message.program .message-actions .action-icon-btn');
    assert.equal(progActions.length, 4);
    assert.ok(progActions[3].classList.contains('speak-btn'));
    assert.equal(progRow.querySelector('.fediverse-share-btn'), null);

    // Voice call row must never render .fediverse-share-btn
    const voiceRow = buildMessageRow({
      id: 'voice_1',
      role: 'voice-call',
      text: JSON.stringify({ duration: '12s', turns: [{ speaker: 'user', text: 'Hi' }] }),
    });
    assert.equal(voiceRow.querySelector('.fediverse-share-btn'), null);

    // Clicking the 4th-slot button opens compose prefilled with exact raw draft text & media
    userActions[3].click();
    const cs = composeStore.get();
    assert.equal(cs.isOpen, true);
    assert.equal(cs.sourceMessageId, 'usr_101');
    assert.equal(cs.text, 'Shipping our sovereign Fediverse client today!');
    assert.equal(cs.targets.fediverse, true);
    assert.equal(cs.mediaAttachments.length, 1);
    assert.equal(cs.mediaAttachments[0].url, '/images/portraits/hero.png');
  } finally {
    dom.restore();
  }
});
