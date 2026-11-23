/** Dedicated Node/browser worker. Never imported into a Vercel route or the buyer bundle. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { z } from 'zod';
import { advisoryReferenceSchema, advisoryVideoStoryboardValueSchema } from '../src/lib/website-sales-advisory-types';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const runFile = promisify(execFile);
async function matchingFfmpeg() {
  const require = createRequire(join(process.cwd(), 'package.json'));
  const root = dirname(require.resolve('playwright-core/package.json'));
  const metadata = JSON.parse(await readFile(join(root, 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] };
  const revision = metadata.browsers.find(row => row.name === 'ffmpeg')?.revision;
  if (!revision || !/^\d+$/.test(revision)) throw Error('ADVISORY_VIDEO_ENCODER_METADATA_REQUIRED');
  let parent = dirname(chromium.executablePath());
  for (let i = 0; i < 5 && !/^chromium-\d+$/.test(basename(parent)); i++) parent = dirname(parent);
  if (!/^chromium-\d+$/.test(basename(parent))) throw Error('ADVISORY_VIDEO_ENCODER_LOCATION_REQUIRED');
  const file = join(dirname(parent), `ffmpeg-${revision}`, process.platform === 'win32' ? 'ffmpeg-win64.exe' : process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-linux');
  await stat(file); return file;
}
const bundleSchema = z.strictObject({ demoRef: advisoryReferenceSchema, document: z.string().min(1).max(1_000_000), documentSha256: z.hash('sha256'),
  assets: z.array(z.strictObject({ path: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$/), mediaType: z.enum(['text/css', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'font/woff2']),
    sha256: z.hash('sha256'), bytes: z.instanceof(Uint8Array) })).max(50) });
export type AdvisoryVideoBundle = z.infer<typeof bundleSchema>;
export interface AdvisoryVideoCapture {
  bytes: Uint8Array; sha256: string; mediaType: 'video/webm'; durationSeconds: number; width: 1280; height: 720;
  narration: 'CAPTIONS_ONLY'; captionText: string; demoRef: z.infer<typeof advisoryReferenceSchema>;
  sourceBindingDigest: string; documentSha256: string; renderer: 'PLAYWRIGHT_SEALED_DEMO_V1'; networkRequests: number;
}
const sealedOrigin = 'https://sealed-sales-video.invalid', documentPath = '/demo/index.html';
const csp = "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'";

/** Actual browser capture of the exact frozen demo, with approved plaintext captions and no outside network. */
export async function renderWebsiteSalesAdvisoryVideo(rawBundle: AdvisoryVideoBundle, rawStoryboard: unknown,
  ports: { isCurrent(): Promise<boolean> }): Promise<AdvisoryVideoCapture> {
  const bundle = bundleSchema.parse(rawBundle), storyboard = advisoryVideoStoryboardValueSchema.parse(rawStoryboard);
  if (JSON.stringify(bundle.demoRef) !== JSON.stringify(storyboard.demoRef) || hash(bundle.document) !== bundle.documentSha256
    || storyboard.shots.some(s => JSON.stringify(s.demoRef) !== JSON.stringify(bundle.demoRef))
    || storyboard.shots.reduce((sum, s) => sum + s.durationSeconds, 0) !== storyboard.maximumSeconds
    || storyboard.maximumSeconds > 150) throw Error('ADVISORY_VIDEO_SOURCE_OR_CAPTURE_BOUND');
  const captionText = storyboard.shots.map(s => s.narration).join('\n\n');
  if (!captionText.trim() || captionText.length > 2000 || !await ports.isCurrent()) throw Error('ADVISORY_VIDEO_APPROVAL_REQUIRED');
  let assetBytes = 0;
  const assets = new Map<string, typeof bundle.assets[number]>();
  for (const asset of bundle.assets) {
    const path = new URL(asset.path, sealedOrigin + documentPath).pathname;
    if (asset.path.includes('..') || assets.has(path) || hash(asset.bytes) !== asset.sha256) throw Error('ADVISORY_VIDEO_ASSET_BINDING');
    assetBytes += asset.bytes.byteLength; if (assetBytes > 25_000_000) throw Error('ADVISORY_VIDEO_ASSET_LIMIT');
    assets.set(path, asset);
  }
  const taskRoot = await realpath(tmpdir()), temporary = await mkdtemp(join(taskRoot, 'novalure-sales-video-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: temporary, size: { width: 1280, height: 720 } },
      serviceWorkers: 'block', reducedMotion: 'reduce', acceptDownloads: false });
    let deniedRequests = 0, networkRequests = 0, pageErrors = 0;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      networkRequests++;
      if (request.method() !== 'GET' || url.origin !== sealedOrigin || url.search || url.hash) { deniedRequests++; return route.abort('blockedbyclient'); }
      if (url.pathname === documentPath) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: bundle.document,
        headers: { 'Content-Security-Policy': csp, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      const asset = assets.get(url.pathname);
      if (!asset) { deniedRequests++; return route.abort('blockedbyclient'); }
      return route.fulfill({ status: 200, contentType: asset.mediaType, body: Buffer.from(asset.bytes), headers: { 'Cache-Control': 'no-store' } });
    });
    const page = await context.newPage(), video = page.video();
    page.on('pageerror', () => { pageErrors++; });
    page.on('console', message => { if (message.type() === 'error') pageErrors++; });
    if (!video) throw Error('ADVISORY_VIDEO_CAPTURE_UNAVAILABLE');
    await page.goto(sealedOrigin + documentPath, { waitUntil: 'load', timeout: 15_000 });
    await page.evaluate(() => {
      const caption = document.createElement('div'); caption.id = 'novalure-approved-video-caption'; caption.setAttribute('role', 'note');
      Object.assign(caption.style, { position: 'fixed', zIndex: '2147483647', left: '24px', right: '24px', bottom: '20px', padding: '18px 22px',
        borderRadius: '12px', background: '#102231', color: '#ffffff', fontFamily: 'Arial, sans-serif', fontSize: '18px', lineHeight: '1.4',
        whiteSpace: 'pre-wrap', boxShadow: '0 2px 12px #0008' }); document.body.append(caption);
    });
    for (const [index, shot] of storyboard.shots.entries()) {
      if (!await ports.isCurrent()) throw Error('ADVISORY_VIDEO_AUTHORITY_CHANGED');
      await page.evaluate(({ text, index, count }) => {
        const caption = document.getElementById('novalure-approved-video-caption')!; caption.textContent = text;
        caption.style.fontSize = text.length > 600 ? '16px' : '20px';
        window.scrollTo(0, count > 1 ? Math.max(0, document.documentElement.scrollHeight - innerHeight) * index / (count - 1) : 0);
      }, { text: shot.narration, index, count: storyboard.shots.length });
      await page.waitForTimeout(shot.durationSeconds * 1000);
    }
    await context.close();
    if (deniedRequests || pageErrors || !await ports.isCurrent()) throw Error('ADVISORY_VIDEO_RENDER_OR_AUTHORITY_FAILED');
    const videoPath = await video.path(), info = await stat(videoPath);
    if (!info.size || info.size > 25_000_000) throw Error('ADVISORY_VIDEO_RESULT_LIMIT');
    let bytes = new Uint8Array(await readFile(videoPath));
    if (Buffer.from(bytes.subarray(0, 4)).toString('hex') !== '1a45dfa3') throw Error('ADVISORY_VIDEO_CONTAINER_INVALID');
    // Read duration from the generated media, not from the requested storyboard duration.
    const probe = await browser.newContext({ serviceWorkers: 'block' });
    const probePage = await probe.newPage();
    await probePage.setContent('<video id="probe" muted preload="metadata"></video>');
    const readDuration = (content: Uint8Array) => probePage.evaluate(async base64 => {
      const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0)), video = document.getElementById('probe') as HTMLVideoElement;
      const objectUrl = URL.createObjectURL(new Blob([data], { type: 'video/webm' }));
      try {
        return await new Promise<number>((resolveDuration, reject) => {
          const timer = setTimeout(() => reject(Error('Video metadata timeout')), 10_000);
          video.onerror = () => { clearTimeout(timer); reject(Error('Video metadata invalid')); };
          video.onloadedmetadata = () => { clearTimeout(timer); resolveDuration(video.duration); };
          video.src = objectUrl;
        });
      } finally { URL.revokeObjectURL(objectUrl); }
    }, Buffer.from(content).toString('base64'));
    const rawDuration = await readDuration(bytes);
    if (!Number.isFinite(rawDuration) || rawDuration <= 0 || rawDuration > 240) throw Error('ADVISORY_VIDEO_CAPTURE_DURATION_INVALID');
    // Browser recording clocks include startup/encoding overhead. Preserve all captured frames,
    // normalize their timeline to the approved duration, then verify the actual output metadata.
    const normalized = join(temporary, 'approved-duration.webm');
    await runFile(await matchingFfmpeg(), ['-y', '-loglevel', 'error', '-itsscale',
      String(Math.min(1, storyboard.maximumSeconds / rawDuration)), '-i', videoPath, '-an',
      '-t', String(storyboard.maximumSeconds), '-c:v', 'copy', normalized],
    { windowsHide: true, timeout: 30_000, maxBuffer: 32_768 });
    bytes = new Uint8Array(await readFile(normalized));
    if (!bytes.byteLength || bytes.byteLength > 25_000_000) throw Error('ADVISORY_VIDEO_RESULT_LIMIT');
    const durationSeconds = await readDuration(bytes);
    await probe.close();
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > storyboard.maximumSeconds + .05 || !await ports.isCurrent()) throw Error('ADVISORY_VIDEO_DURATION_OR_AUTHORITY_INVALID');
    return { bytes, sha256: hash(bytes), mediaType: 'video/webm', durationSeconds, width: 1280, height: 720, narration: 'CAPTIONS_ONLY', captionText,
      demoRef: bundle.demoRef, sourceBindingDigest: storyboard.sourceBindingDigest, documentSha256: bundle.documentSha256, renderer: 'PLAYWRIGHT_SEALED_DEMO_V1', networkRequests };
  } finally {
    try { await browser?.close(); }
    finally {
      // The only recursively removed directory is our freshly created direct child of the resolved OS temp root.
      const checked = resolve(temporary);
      if (dirname(checked) !== resolve(taskRoot) || !basename(checked).startsWith('novalure-sales-video-') || checked === resolve(taskRoot)) throw Error('ADVISORY_VIDEO_CLEANUP_TARGET_DENIED');
      await rm(checked, { recursive: true, force: true });
    }
  }
}
