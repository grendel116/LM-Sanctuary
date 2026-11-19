import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { renderSanitizedHtml, sanitizeFediverseHtmlToString } from '../web/queries/fediverse.js';

test('renderSanitizedHtml uses native setHTML when available and hardens anchor rel/target', () => {
  const dom = installMockDom();
  try {
    const div = dom.document.createElement('div');
    let setHtmlCalledWith = null;

    // Simulate a browser implementing native Sanitizer Element.prototype.setHTML
    const anchorEl = dom.document.createElement('a');
    anchorEl.setAttribute('href', 'https://mastodon.social/@alice');
    div.setHTML = (html) => {
      setHtmlCalledWith = html;
      div.appendChild(anchorEl);
    };

    renderSanitizedHtml(div, '<p>Hi <script>alert(1)</script><a href="https://mastodon.social/@alice">@alice</a></p>');

    assert.ok(setHtmlCalledWith !== null);
    assert.equal(setHtmlCalledWith.includes('<script'), false);
    assert.equal(anchorEl.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(anchorEl.getAttribute('target'), '_blank');
  } finally {
    dom.restore();
  }
});

test('renderSanitizedHtml falls back cleanly to safe node building via replaceChildren when setHTML is absent', () => {
  const dom = installMockDom();
  try {
    const div = dom.document.createElement('div');
    div.textContent = 'Stale previous child';
    assert.equal(div.setHTML, undefined);

    renderSanitizedHtml(div, '<p onclick="bad()">Clean <strong>Fediverse</strong> note</p>');
    assert.equal(div.textContent.includes('Clean Fediverse note'), true);
    assert.equal(div.textContent.includes('Stale previous child'), false);
  } finally {
    dom.restore();
  }
});

test('sanitizeFediverseHtmlToString decodes HTML entities cleanly without double-escaping', () => {
  const plain = sanitizeFediverseHtmlToString('<p>Don&#39;t you ever give up &amp; keep going.</p>');
  assert.equal(plain, "<p>Don't you ever give up &amp; keep going.</p>");

  const withEmoji = sanitizeFediverseHtmlToString('<p>Don&#39;t stop :star: &lt;ok&gt;</p>', [
    { shortcode: 'star', url: 'https://mastodon.social/emoji/star.png' },
  ]);
  assert.ok(withEmoji.includes("Don't stop "));
  assert.ok(withEmoji.includes('<img class="custom-emoji"'));
  assert.ok(withEmoji.includes('&lt;ok&gt;'));
  assert.equal(withEmoji.includes('&#39;'), false);

  const dom = installMockDom();
  try {
    const bioEl = dom.document.createElement('div');
    renderSanitizedHtml(bioEl, '<p>Don&#39;t you ever give up.</p>');
    assert.equal(bioEl.textContent, "Don't you ever give up.");
  } finally {
    dom.restore();
  }
});
