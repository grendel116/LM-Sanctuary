#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function assertFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required ${label}: ${filePath}`);
  }
}

export async function verifyAndroidWebBundle(repoRoot = REPO_ROOT) {
  const webDir = path.join(repoRoot, 'web');
  const indexHtmlPath = path.join(webDir, 'index.html');
  const manifestPath = path.join(webDir, 'manifest.json');
  const swPath = path.join(webDir, 'sw.js');
  const capConfigPath = path.join(repoRoot, 'capacitor.config.ts');
  const netSecPath = path.join(
    repoRoot,
    'android',
    'app',
    'src',
    'main',
    'res',
    'xml',
    'network_security_config.xml'
  );

  assertFileExists(indexHtmlPath, 'web/index.html');
  assertFileExists(manifestPath, 'web/manifest.json');
  assertFileExists(swPath, 'web/sw.js');
  assertFileExists(capConfigPath, 'capacitor.config.ts');
  assertFileExists(netSecPath, 'Android network_security_config.xml');

  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  if (indexHtml.includes('{{') || indexHtml.includes('{%')) {
    throw new Error('web/index.html contains unrendered Jinja template markers.');
  }
  if (indexHtml.includes('sanctuary-legacy.js')) {
    throw new Error('web/index.html still references removed sanctuary-legacy.js.');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.start_url || !Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    throw new Error('web/manifest.json must define start_url and at least one icon.');
  }
  if (!manifest.share_target?.action) {
    throw new Error('web/manifest.json must configure share_target.');
  }
  for (const icon of manifest.icons) {
    const resolvedIcon = path.resolve(webDir, icon.src);
    assertFileExists(resolvedIcon, `manifest icon (${icon.src})`);
  }

  const swModule = await import(`${pathToFileURL(swPath).href}?v=${Date.now()}`);
  const shellAssets = swModule.APP_SHELL_ASSETS;
  if (!Array.isArray(shellAssets) || shellAssets.length === 0) {
    throw new Error('web/sw.js must export a non-empty APP_SHELL_ASSETS array.');
  }
  for (const entry of shellAssets) {
    const relPath = entry === './' ? 'index.html' : entry;
    const diskPath = path.resolve(webDir, relPath);
    assertFileExists(diskPath, `SW shell asset (${entry})`);
  }

  const capConfig = fs.readFileSync(capConfigPath, 'utf8');
  if (!/webDir\s*:\s*['"]web['"]/.test(capConfig)) {
    throw new Error('capacitor.config.ts must set webDir to "web".');
  }
  if (!capConfig.includes('CapacitorHttp')) {
    throw new Error('capacitor.config.ts must configure CapacitorHttp.');
  }

  const netSecXml = fs.readFileSync(netSecPath, 'utf8');
  if (!netSecXml.includes('cleartextTrafficPermitted="true"')) {
    throw new Error('network_security_config.xml must allow LAN/Tailscale cleartext in base-config.');
  }
  if (!netSecXml.includes('cleartextTrafficPermitted="false"')) {
    throw new Error('network_security_config.xml must pin social domains to HTTPS-only.');
  }

  return {
    webDir,
    shellAssetCount: shellAssets.length,
  };
}

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  await verifyAndroidWebBundle(REPO_ROOT);

  if (verifyOnly) {
    console.log('ANDROID_WEB_BUNDLE_VERIFIED');
    return;
  }

  const capCliDir = path.join(REPO_ROOT, 'node_modules', '@capacitor', 'cli');
  if (fs.existsSync(capCliDir)) {
    console.log('ANDROID_WEB_BUNDLE_VERIFIED');
    execSync('npx cap sync android', { cwd: REPO_ROOT, stdio: 'inherit' });
    return;
  }

  console.log('ANDROID_WEB_BUNDLE_VERIFIED');
  console.log('');
  console.log('Capacitor CLI is not installed locally yet. To build the Android project:');
  console.log('  npm install');
  console.log('  npx cap add android');
  console.log('  npx cap sync android');
  console.log('  npx cap open android');
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
