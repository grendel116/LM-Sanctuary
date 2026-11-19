import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyAddressSpace,
  detectDefaultNodeUrl,
  isAllowedNodeUrl,
  isAllowedSocialUrl,
  normalizeInstanceUrl,
  normalizeNodeUrl,
  parseIpv4Octets,
  resolveNodeUrl,
} from '../web/constants/endpoints.js';

test('parseIpv4Octets parses valid IPv4 and rejects octal/malformed octets', () => {
  assert.deepEqual(parseIpv4Octets('100.64.0.1'), [100, 64, 0, 1]);
  assert.equal(parseIpv4Octets('010.0.0.1'), null);
  assert.equal(parseIpv4Octets('256.0.0.1'), null);
  assert.equal(parseIpv4Octets('localhost'), null);
});

test('isAllowedNodeUrl permits loopback, RFC1918, Tailscale CGNAT (100.64.0.0/10), .local, .ts.net and rejects outside cleartext', () => {
  const allowed = [
    'http://localhost:5000',
    'http://127.0.0.1:5000',
    'http://[::1]:5000',
    'http://10.0.0.5:5000',
    'http://172.16.0.1:5000',
    'http://172.31.255.254:5000',
    'http://192.168.1.42:5000',
    'http://100.64.0.1:5000',
    'http://100.127.255.254:5000',
    'http://sanctuary.local:5000',
    'http://gpu-box.tail1234.ts.net:5000',
    'https://sanctuary.example.com',
  ];
  for (const url of allowed) {
    assert.equal(isAllowedNodeUrl(url), true, `Expected allowed: ${url}`);
  }

  const disallowed = [
    '',
    'http://100.63.255.255:5000',
    'http://100.128.0.1:5000',
    'http://172.15.0.1:5000',
    'http://172.32.0.1:5000',
    'http://evil.com:5000',
    'http://mybox.ts.net.evil.com:5000',
    'http://mybox.local.evil.com:5000',
    'javascript:alert(1)',
    'file:///C:/Windows/System32',
    'http://user:pass@127.0.0.1:5000',
  ];
  for (const url of disallowed) {
    assert.equal(isAllowedNodeUrl(url), false, `Expected rejected: ${url}`);
  }

  assert.throws(() => classifyAddressSpace('data:text/html,hi'), TypeError);
});

test('isAllowedSocialUrl and normalizeInstanceUrl enforce public https:// origins only', () => {
  assert.equal(normalizeInstanceUrl('mastodon.social/'), 'https://mastodon.social');
  assert.equal(isAllowedSocialUrl('https://pixelfed.social'), true);
  assert.equal(isAllowedSocialUrl('http://mastodon.social'), false);
  assert.equal(isAllowedSocialUrl('https://localhost:5000'), false);
  assert.equal(isAllowedSocialUrl('https://100.64.0.1'), false);
  assert.throws(() => normalizeInstanceUrl('http://mastodon.social'), TypeError);
  assert.throws(() => normalizeInstanceUrl('javascript:alert(1)'), TypeError);
});

test('detectDefaultNodeUrl detects same-origin local Flask/pywebview while returning "" on Capacitor APK or public PWA', () => {
  assert.equal(
    detectDefaultNodeUrl({
      locationObj: { protocol: 'http:', origin: 'http://127.0.0.1:5000' },
      capacitorObj: null,
    }),
    'http://127.0.0.1:5000'
  );
  assert.equal(
    detectDefaultNodeUrl({
      locationObj: { protocol: 'http:', origin: 'http://192.168.1.50:5000' },
      capacitorObj: undefined,
    }),
    'http://192.168.1.50:5000'
  );
  // Capacitor serves bundled assets on https://localhost / http://localhost, which is NOT a Python node.
  assert.equal(
    detectDefaultNodeUrl({
      locationObj: { protocol: 'https:', origin: 'https://localhost' },
      capacitorObj: { isNativePlatform: () => true },
    }),
    ''
  );
  // Public standalone GitHub Pages / Cloudflare PWA stays dormant with "".
  assert.equal(
    detectDefaultNodeUrl({
      locationObj: { protocol: 'https:', origin: 'https://nimueblue.pages.dev' },
      capacitorObj: undefined,
    }),
    ''
  );
  assert.equal(
    detectDefaultNodeUrl({
      locationObj: { protocol: 'about:', origin: 'null' },
    }),
    ''
  );
});

test('normalizeNodeUrl and resolveNodeUrl normalize paths cleanly and prevent cross-origin resolution', () => {
  assert.equal(normalizeNodeUrl('100.64.0.1:5000/'), 'http://100.64.0.1:5000');
  assert.equal(normalizeNodeUrl('  '), '');
  assert.throws(() => normalizeNodeUrl('http://100.128.0.1:5000'), TypeError);
  assert.throws(() => normalizeNodeUrl('172.32.0.1:5000'), TypeError);

  assert.equal(
    resolveNodeUrl('/images/portraits/p1.png', 'http://100.64.0.1:5000/'),
    'http://100.64.0.1:5000/images/portraits/p1.png'
  );
  assert.equal(resolveNodeUrl('data:image/png;base64,AAA', ''), 'data:image/png;base64,AAA');
  assert.throws(
    () => resolveNodeUrl('https://evil.example/steal', 'http://100.64.0.1:5000'),
    TypeError
  );
});
