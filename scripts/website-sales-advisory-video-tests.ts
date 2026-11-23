import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { renderWebsiteSalesAdvisoryVideo, type AdvisoryVideoBundle } from './website-sales-advisory-video-render';

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const demoRef = { id: randomUUID(), version: 1, digest: 'a'.repeat(64) }, evidenceRef = { id: randomUUID(), version: 1, digest: 'b'.repeat(64) };
  const css = new TextEncoder().encode('body{margin:0;background:#eef4f2;color:#102231;font:24px Arial}section{min-height:650px;padding:48px}h1{font-size:58px}section:nth-child(2){background:#dce9e3}');
  const document = '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Synthetische Testdemo</title><link rel="stylesheet" href="assets/site.css"></head><body><section><p>Lokale, synthetische Browserprüfung</p><h1>Fiktive Testpraxis</h1><p>Persönliche Website-Vorschau mit klaren Leistungen.</p></section><section><h2>So könnte die Terminübersicht aussehen</h2><p>Diese Testseite führt keine Buchung aus.</p></section></body></html>';
  const bundle: AdvisoryVideoBundle = { demoRef, document, documentSha256: digest(document), assets: [{ path: 'assets/site.css', mediaType: 'text/css', sha256: digest(css), bytes: css }] };
  const storyboard = { demoRef, packetRef: null, title: 'Synthetischer Demo-Rundgang', language: 'de', maximumSeconds: 20, assetRefs: [],
    shots: [{ index: 0, durationSeconds: 10, narration: 'Die freigegebene Testdemo stellt die Leistungen der fiktiven Praxis vor.', factId: randomUUID(), evidenceRef, visual: 'PROTECTED_DEMO_CAPTURE', demoRef },
      { index: 1, durationSeconds: 10, narration: 'Die zweite Ansicht zeigt eine mögliche Terminübersicht. Diese lokale Testseite bucht keinen Termin.', factId: randomUUID(), evidenceRef, visual: 'PROTECTED_DEMO_CAPTURE', demoRef }],
    sourceBindingDigest: 'c'.repeat(64), status: 'STORYBOARD_REQUIRES_APPROVAL', customerSecretsIncluded: false, renderedVideo: false };
  return { bundle, storyboard };
}
test('unapproved, changed or over-contract source bundles fail before any browser capture', async () => {
  const f = fixture();
  await assert.rejects(() => renderWebsiteSalesAdvisoryVideo(f.bundle, f.storyboard, { isCurrent: async () => false }), /APPROVAL_REQUIRED/);
  await assert.rejects(() => renderWebsiteSalesAdvisoryVideo({ ...f.bundle, documentSha256: '0'.repeat(64) }, f.storyboard, { isCurrent: async () => true }), /SOURCE_OR_CAPTURE_BOUND/);
  await assert.rejects(() => renderWebsiteSalesAdvisoryVideo(f.bundle, { ...f.storyboard, maximumSeconds: 151 }, { isCurrent: async () => true }));
});
test('actual Chromium captures an approved frozen demo with captions into a valid bounded WebM and reads its real duration', { timeout: 60_000 }, async () => {
  const f = fixture(); let checked = 0;
  const video = await renderWebsiteSalesAdvisoryVideo(f.bundle, f.storyboard, { isCurrent: async () => { checked++; return true; } });
  assert.equal(video.sha256, digest(video.bytes)); assert.equal(video.narration, 'CAPTIONS_ONLY'); assert.equal(video.mediaType, 'video/webm');
  assert(video.durationSeconds >= 19 && video.durationSeconds <= 20.05); assert(checked >= 5); assert(video.bytes.byteLength > 1000); assert(video.networkRequests >= 2);
  assert(video.captionText.includes(f.storyboard.shots[1].narration)); assert.equal(video.documentSha256, f.bundle.documentSha256);
  const dir = join(process.cwd(), '.npm-cache', 'qa', 'website-sales-advisory-video-20261123'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'actual-demo.webm'), video.bytes);
  await writeFile(join(dir, 'result.json'), JSON.stringify({ syntheticBusinessData: true, actualBrowserRecording: true, realProviderCalls: 0,
    sha256: video.sha256, byteLength: video.bytes.byteLength, mediaType: video.mediaType, durationSeconds: video.durationSeconds, narration: video.narration,
    sourceBindingDigest: video.sourceBindingDigest, documentSha256: video.documentSha256, checked, networkRequests: video.networkRequests }, null, 2) + '\n');
});
