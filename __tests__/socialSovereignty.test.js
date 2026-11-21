import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const WEB_DIR = path.join(REPO_ROOT, 'web');

function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN_TOKENS = [
  'callBackendSocial',
  'getSocialBackendOrigin',
  'httpSocialJson',
  '__SANCTUARY_FORCE_HTTP_STORE__',
  '__SANCTUARY_SOCIAL_ORIGIN__',
  'open-external',
];

test('web/ owns all social protocols and routes /api/social/* exclusively through web/queries/sanctuary.js', () => {
  const jsFiles = collectJsFiles(WEB_DIR);
  assert.ok(jsFiles.length > 0);

  const apiSocialHits = [];
  for (const filePath of jsFiles) {
    const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    const src = fs.readFileSync(filePath, 'utf8');
    for (const token of FORBIDDEN_TOKENS) {
      assert.equal(
        src.includes(token),
        false,
        `Forbidden dual-stack token "${token}" found in ${rel}`
      );
    }
    if (src.includes('/api/social')) {
      apiSocialHits.push(rel);
    }
  }

  assert.deepEqual(apiSocialHits, ['web/queries/sanctuary.js']);
});
