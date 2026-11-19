import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.avif': 'image/avif',
  '.wasm': 'application/wasm',
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        let relPath = decodeURIComponent(reqUrl.pathname);
        if (relPath === '/') relPath = '/index.html';
        const filePath = path.join(ROOT_DIR, relPath);
        if (!filePath.startsWith(ROOT_DIR)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        const data = await fs.readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function hasPlaywrightChromiumInstalled() {
  const fullChromiumPath = chromium.executablePath();
  if (!fullChromiumPath) return false;
  if (existsSync(fullChromiumPath)) return true;

  const match = fullChromiumPath.match(/^(.*?[\\/])chromium-(\d+)[\\/]/);
  if (!match) return false;
  const headlessShellDir = path.join(match[1], `chromium_headless_shell-${match[2]}`);
  return (
    existsSync(path.join(headlessShellDir, 'INSTALLATION_COMPLETE')) ||
    existsSync(headlessShellDir)
  );
}

function resolveChromiumExecutablePath() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  if (process.env.CI || hasPlaywrightChromiumInstalled()) {
    return undefined;
  }
  for (const candidate of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function main() {
  const { server, url } = await startStaticServer();
  const executablePath = resolveChromiumExecutablePath();
  const screenshotDir = process.env.QCAM_SCREENSHOT_DIR || null;

  console.log('[e2e] launching chromium:', executablePath || 'playwright-bundled');
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    timeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
    ],
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
      permissions: ['camera'],
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    console.log('[e2e] navigating to', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });

    console.log('[e2e] waiting for camera video stream');
    // 1. Wait for live camera stream and verify <1.5s startup & silent (no audio tracks)
    await page.waitForFunction(() => {
      const v = document.getElementById('camera-video');
      return Boolean(window.__QCAM__?.streamInfo && v && v.videoWidth > 0 && v.videoHeight > 0);
    }, { timeout: 6000 });

    const startupMetrics = await page.evaluate(() => {
      const app = window.__QCAM__;
      const stream = app.camera.stream;
      return {
        startupTimeMs: app.camera.startupTimeMs,
        audioTracks: stream ? stream.getAudioTracks().length : -1,
        videoTracks: stream ? stream.getVideoTracks().length : -1,
        videoWidth: app.ui.els.video.videoWidth,
        videoHeight: app.ui.els.video.videoHeight,
        overlayHidden: app.ui.els.cameraOverlay.hidden,
      };
    });

    assert.equal(startupMetrics.audioTracks, 0, 'Camera stream must never request audio tracks');
    assert.equal(startupMetrics.videoTracks, 1, 'Camera stream must have 1 video track');
    assert.ok(startupMetrics.startupTimeMs < 1500, `Startup too slow: ${startupMetrics.startupTimeMs}ms`);
    assert.equal(startupMetrics.overlayHidden, true);

    console.log('[e2e] verifying PWA manifest, SW, and precache asset URLs');
    // 2. Verify PWA manifest, Service Worker registration & precache URLs
    const pwaStatus = await page.evaluate(async () => {
      const manifestResp = await fetch('./manifest.webmanifest');
      const manifest = await manifestResp.json();
      const swText = await (await fetch('./sw.js')).text();
      const assetBlock = swText.match(/APP_SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]/)?.[1] || '';
      const assetPaths = Array.from(assetBlock.matchAll(/'([^']+)'/g), (m) => m[1]);
      const assetStatuses = [];
      for (const p of assetPaths) {
        const r = await fetch(p);
        assetStatuses.push({ path: p, status: r.status, ok: r.ok });
      }
      let swRegistered = false;
      if ('serviceWorker' in navigator) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) {
            swRegistered = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 60));
        }
      }
      return {
        manifestOk: manifestResp.ok,
        display: manifest.display,
        iconsCount: manifest.icons.length,
        swRegistered,
        assetStatuses,
      };
    });
    assert.equal(pwaStatus.manifestOk, true);
    assert.equal(pwaStatus.display, 'standalone');
    assert.ok(pwaStatus.iconsCount >= 3);
    assert.equal(pwaStatus.swRegistered, true);
    assert.ok(pwaStatus.assetStatuses.length >= 20);
    for (const entry of pwaStatus.assetStatuses) {
      assert.equal(entry.ok, true, `SW precache asset failed: ${entry.path} (${entry.status})`);
    }

    console.log('[e2e] checking 4:3 and 16:9 aspect ratios');
    // 3. Verify 4:3 vs 16:9 viewfinder aspect ratio switch
    const box43 = await page.locator('#viewfinder-frame').boundingBox();
    assert.ok(Math.abs(box43.width / box43.height - 3 / 4) < 0.04, '4:3 portrait frame ratio mismatch');

    await page.click('#btn-aspect');
    await page.waitForTimeout(80);
    assert.equal(await page.textContent('#aspect-label'), '16:9');
    const box169 = await page.locator('#viewfinder-frame').boundingBox();
    assert.ok(Math.abs(box169.width / box169.height - 9 / 16) < 0.04, '16:9 portrait frame ratio mismatch');

    // Switch back to 4:3
    await page.click('#btn-aspect');
    await page.waitForTimeout(80);

    console.log('[e2e] checking grid, timer, and tap-to-focus');
    // 4. Verify 3x3 grid toggle & Timer cycle (OFF -> 3s -> 10s -> OFF)
    await page.click('#btn-grid');
    assert.equal(await page.locator('#grid-overlay').isVisible(), true);
    assert.equal(await page.getAttribute('#btn-grid', 'aria-pressed'), 'true');

    await page.click('#btn-timer');
    assert.equal(await page.textContent('#timer-label'), '3s');
    assert.equal(await page.locator('#timer-label').isVisible(), true);
    await page.click('#btn-timer');
    assert.equal(await page.textContent('#timer-label'), '10s');
    await page.click('#btn-timer');
    assert.equal(await page.locator('#timer-label').isVisible(), false);
    assert.equal(await page.textContent('#timer-label'), '');

    // 5. Verify Tap-to-Focus reticle & EV control
    const vfBox = await page.locator('#viewfinder-frame').boundingBox();
    await page.mouse.click(vfBox.x + vfBox.width * 0.45, vfBox.y + vfBox.height * 0.4);
    assert.equal(await page.locator('#focus-reticle').isVisible(), true);
    assert.equal(await page.locator('#ev-slider').isVisible(), true);

    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_viewfinder.png') });
    }

    console.log('[e2e] checking zoom pill, collapsible zoom slider, and WebGL orientation');
    // 6. Verify 0.5x button stays hidden when hardware does not advertise ultra-wide,
    // compact zoom pill formats active/inactive badges, and collapsible fine slider works
    assert.equal(await page.locator('#btn-zoom-05').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__QCAM__.ui.state.minZoom), 1);
    assert.equal(await page.textContent('.zoom-preset[data-zoom="1"]'), '1×');
    assert.equal(await page.textContent('.zoom-preset[data-zoom="2"]'), '2');

    await page.click('.zoom-preset[data-zoom="2"]');
    assert.equal(await page.textContent('#zoom-readout'), '2.0×');
    assert.equal(await page.textContent('.zoom-preset[data-zoom="2"]'), '2×');
    assert.equal(await page.textContent('.zoom-preset[data-zoom="1"]'), '1');

    await page.click('#btn-zoom-slider-toggle');
    assert.equal(await page.locator('#zoom-slider-panel').isVisible(), true);
    assert.equal(await page.locator('#zoom-bar').isVisible(), false);
    await page.locator('#zoom-slider').evaluate((el) => {
      el.value = '1.6';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.textContent('#zoom-readout'), '1.6×');
    assert.equal(await page.textContent('.zoom-preset[data-zoom="1"]'), '1.6×');
    await page.click('#btn-zoom-slider-close');
    assert.equal(await page.locator('#zoom-bar').isVisible(), true);
    assert.equal(await page.locator('#zoom-slider-panel').isVisible(), false);

    await page.click('.zoom-preset[data-zoom="1"]');
    assert.equal(await page.textContent('#zoom-readout'), '1.0×');
    assert.equal(await page.textContent('.zoom-preset[data-zoom="1"]'), '1×');

    // 7. Verify WebGL pixel orientation, AVIF ISOBMFF signature, & main-thread offload path
    const orientationCheck = await page.evaluate(async () => {
      const readAvifSignature = async (blob) => {
        const bytes = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
        const ascii = (start, len) =>
          String.fromCharCode(...bytes.slice(start, start + len));
        return {
          boxType: ascii(4, 4),
          majorBrand: ascii(8, 4),
          compat: ascii(16, Math.min(16, Math.max(0, bytes.length - 16))),
        };
      };

      const makeTestCanvas = () => {
        const c = document.createElement('canvas');
        c.width = 120;
        c.height = 90;
        const ctx = c.getContext('2d');
        // Top-left red, top-right green, bottom-left blue, bottom-right yellow
        ctx.fillStyle = '#ff0000';
        ctx.fillRect(0, 0, 60, 45);
        ctx.fillStyle = '#00ff00';
        ctx.fillRect(60, 0, 60, 45);
        ctx.fillStyle = '#0000ff';
        ctx.fillRect(0, 45, 60, 45);
        ctx.fillStyle = '#ffff00';
        ctx.fillRect(60, 45, 60, 45);
        return c;
      };

      const sampleCorners = async (blob) => {
        const outBmp = await createImageBitmap(blob);
        const checkCanvas = document.createElement('canvas');
        checkCanvas.width = outBmp.width;
        checkCanvas.height = outBmp.height;
        const checkCtx = checkCanvas.getContext('2d');
        checkCtx.drawImage(outBmp, 0, 0);
        const sample = (x, y) => Array.from(checkCtx.getImageData(x, y, 1, 1).data);
        const corners = {
          tl: sample(15, 15),
          tr: sample(105, 15),
          bl: sample(15, 75),
        };
        outBmp.close();
        return corners;
      };

      const c = makeTestCanvas();
      const bmp1 = await createImageBitmap(c);
      const res = await window.__QCAM__.pipeline.process({
        mode: 'standard',
        frames: [bmp1],
        aspectRatio: '4:3',
        softwareZoom: 1,
        mirrorX: false,
        outputFormat: 'avif',
      });
      const sig = await readAvifSignature(res.blob);
      const corners = await sampleCorners(res.blob);

      // Also verify iOS 16.4-style main-thread WebGL + Worker AVIF encode offload path
      const bmp2 = await createImageBitmap(c);
      const mainRes = await window.__QCAM__.pipeline._processOnMainThread({
        mode: 'standard',
        frames: [bmp2],
        aspectRatio: '4:3',
        softwareZoom: 1,
        mirrorX: false,
        exposureEv: 0,
        outputFormat: 'avif',
        preCropped: false,
      });
      bmp2.close();
      const mainSig = await readAvifSignature(mainRes.blob);
      const mainCorners = await sampleCorners(mainRes.blob);

      return {
        ...corners,
        engine: res.engine,
        type: res.blob.type,
        sig,
        mainEngine: mainRes.engine,
        mainType: mainRes.blob.type,
        mainSig,
        mainCorners,
      };
    });

    assert.equal(orientationCheck.type, 'image/avif');
    assert.equal(orientationCheck.sig.boxType, 'ftyp');
    assert.ok(orientationCheck.sig.majorBrand === 'avif' || orientationCheck.sig.compat.includes('avif'));
    assert.ok(orientationCheck.tl[0] > 180 && orientationCheck.tl[1] < 80, `Top-left should be red, got ${orientationCheck.tl}`);
    assert.ok(orientationCheck.tr[1] > 180 && orientationCheck.tr[0] < 80, `Top-right should be green, got ${orientationCheck.tr}`);
    assert.ok(orientationCheck.bl[2] > 180 && orientationCheck.bl[0] < 80, `Bottom-left should be blue, got ${orientationCheck.bl}`);

    assert.equal(orientationCheck.mainType, 'image/avif');
    assert.equal(orientationCheck.mainSig.boxType, 'ftyp');
    assert.ok(orientationCheck.mainCorners.tl[0] > 180 && orientationCheck.mainCorners.tl[1] < 80);
    assert.ok(orientationCheck.mainCorners.bl[2] > 180 && orientationCheck.mainCorners.bl[0] < 80);

    console.log('[e2e] verifying Standard mode removal and always-on HQ HDR AVIF capture');
    // 8. Verify mode-switcher is removed and shutter is always in HDR mode even if legacy localStorage had mode: 'standard'
    assert.equal(await page.locator('.mode-switcher').count(), 0, 'Mode switcher UI must be removed');
    assert.equal(await page.locator('#mode-standard').count(), 0, 'Standard mode tab must not exist');
    assert.equal(await page.locator('#mode-hq').count(), 0, 'HQ mode tab must not exist');
    assert.equal(
      await page.evaluate(() => document.getElementById('btn-shutter').classList.contains('is-hq')),
      true,
      'Shutter must display active HDR ring by default'
    );

    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.click('#btn-shutter');
    const download = await downloadPromise;
    assert.ok(download.suggestedFilename().startsWith('Qcam_'));
    assert.ok(download.suggestedFilename().includes('_HDR.avif'));

    await page.waitForFunction(() => window.__QCAM__.photos.length === 1);
    const firstHdrPhoto = await page.evaluate(async () => {
      const p = window.__QCAM__.photos[0];
      const hdr = new Uint8Array(await p.blob.slice(0, 16).arrayBuffer());
      return {
        width: p.width,
        height: p.height,
        mode: p.mode,
        format: p.format,
        size: p.blob.size,
        type: p.blob.type,
        totalTimeMs: p.totalTimeMs,
        engine: p.engine,
        ftyp: String.fromCharCode(...hdr.slice(4, 12)),
      };
    });
    assert.equal(firstHdrPhoto.mode, 'hq');
    assert.equal(firstHdrPhoto.format, 'avif');
    assert.equal(firstHdrPhoto.type, 'image/avif');
    assert.equal(firstHdrPhoto.ftyp, 'ftypavif');
    assert.ok(firstHdrPhoto.size > 200);
    assert.ok(Math.abs(firstHdrPhoto.width / firstHdrPhoto.height - 4 / 3) < 0.02);

    console.log('[e2e] capturing second HQ HDR burst AVIF photo for gallery strip check');
    // 9. Capture a second HDR AVIF photo cleanly for gallery strip verification
    const hqDownloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.click('#btn-shutter');
    const hqDownload = await hqDownloadPromise;
    assert.ok(hqDownload.suggestedFilename().includes('_HDR.avif'));

    await page.waitForFunction(() => window.__QCAM__.photos.length === 2);
    const hqPhoto = await page.evaluate(async () => {
      const p = window.__QCAM__.photos[0];
      const hdr = new Uint8Array(await p.blob.slice(0, 16).arrayBuffer());
      return {
        width: p.width,
        height: p.height,
        mode: p.mode,
        format: p.format,
        size: p.blob.size,
        type: p.blob.type,
        totalTimeMs: p.totalTimeMs,
        engine: p.engine,
        ftyp: String.fromCharCode(...hdr.slice(4, 12)),
      };
    });
    assert.equal(hqPhoto.mode, 'hq');
    assert.equal(hqPhoto.format, 'avif');
    assert.equal(hqPhoto.type, 'image/avif');
    assert.equal(hqPhoto.ftyp, 'ftypavif');
    assert.ok(hqPhoto.size > 200);

    console.log('[e2e] checking preview modal, info sheet, format switcher, photo deletion, and camera switch');
    // 10. Open Photo Preview Modal, verify AVIF render & labels, zoom & inspect image, delete one photo, then close
    await page.click('#btn-gallery');
    await page.waitForSelector('#preview-modal:not([hidden])');
    const imgNaturalW = await page.evaluate(() => document.getElementById('preview-image').naturalWidth);
    assert.ok(imgNaturalW > 0, 'Preview modal AVIF image must decode & load cleanly');
    const previewMetaMetrics = await page.evaluate(() => {
      const el = document.getElementById('preview-meta');
      return {
        text: el.textContent || '',
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
      };
    });
    assert.ok(previewMetaMetrics.text.includes('AVIF') && previewMetaMetrics.text.includes('HDR'));
    assert.ok(previewMetaMetrics.scrollW <= previewMetaMetrics.clientW + 1, `Preview meta truncated: ${JSON.stringify(previewMetaMetrics)}`);
    assert.ok((await page.textContent('#btn-modal-save')).includes('AVIF'));

    await page.click('#btn-preview-zoom-2x');
    const zoomedWidth = await page.evaluate(() => document.getElementById('preview-image').getBoundingClientRect().width);
    assert.ok(zoomedWidth > 400, '2x zoom should enlarge preview image');

    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_preview_modal.png') });
    }

    // Delete 1st photo and verify gallery updates cleanly to 1 remaining photo
    await page.click('#btn-modal-delete');
    await page.waitForFunction(() => window.__QCAM__.photos.length === 1);

    await page.click('#btn-modal-close');
    assert.equal(await page.locator('#preview-modal').isVisible(), false);

    // 11. Verify HQ tone mapping lifts shadows on synthetic dark input (encoded to AVIF)
    const hdrCheck = await page.evaluate(async () => {
      const makeDarkFrame = async (val) => {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const ctx = c.getContext('2d');
        ctx.fillStyle = `rgb(${val},${val},${val})`;
        ctx.fillRect(0, 0, 64, 64);
        return createImageBitmap(c);
      };
      const frames = await Promise.all([
        makeDarkFrame(28),
        makeDarkFrame(30),
        makeDarkFrame(27),
        makeDarkFrame(29),
      ]);
      const res = await window.__QCAM__.pipeline.process({
        mode: 'hq',
        frames,
        aspectRatio: '4:3',
        softwareZoom: 1,
        outputFormat: 'avif',
      });
      const bmp = await createImageBitmap(res.blob);
      const outC = document.createElement('canvas');
      outC.width = bmp.width;
      outC.height = bmp.height;
      const octx = outC.getContext('2d');
      octx.drawImage(bmp, 0, 0);
      const px = octx.getImageData(32, 32, 1, 1).data;
      bmp.close();
      return { r: px[0], g: px[1], b: px[2], type: res.blob.type };
    });
    assert.equal(hdrCheck.type, 'image/avif');
    assert.ok(hdrCheck.r > 34, `HQ tone mapping should lift shadows (>34), got ${hdrCheck.r}`);

    // 12. Verify 3s timer countdown starts and cancels on second shutter press
    await page.click('#btn-timer');
    assert.equal(await page.textContent('#timer-label'), '3s');
    await page.click('#btn-shutter');
    const countdownHandle = await page.waitForFunction(() => {
      const overlay = document.getElementById('countdown-overlay');
      const num = document.getElementById('countdown-number')?.textContent?.trim();
      return overlay && !overlay.hidden && num ? num : null;
    }, { timeout: 3000 });
    const countdownVal = await countdownHandle.jsonValue();
    assert.ok(
      ['3', '2'].includes(countdownVal),
      `Expected active 3s countdown ('3' or '2'), got ${countdownVal}`
    );
    await page.click('#btn-shutter'); // Cancel countdown
    assert.equal(await page.locator('#countdown-overlay').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__QCAM__.photos.length), 1);
    // Reset timer back to OFF
    await page.click('#btn-timer');
    await page.click('#btn-timer');
    assert.equal(await page.locator('#timer-label').isVisible(), false);

    // 13. Verify distracting viewfinder chrome is absent, open Info Sheet, check v1.8.0 diagnostics, Look/Format/EIS controls
    assert.equal(await page.locator('#silent-badge').count(), 0);
    assert.equal(await page.locator('#resolution-badge').count(), 0);
    assert.equal(await page.locator('#btn-stabilization').count(), 0);
    assert.equal(await page.locator('#perm-hint-banner').count(), 0);
    assert.equal(await page.locator('#shake-warning-pill').count(), 0);

    await page.click('#btn-info');
    await page.waitForSelector('#info-modal:not([hidden])');
    assert.equal(await page.getAttribute('#btn-format-avif', 'aria-checked'), 'true');
    assert.equal(await page.getAttribute('#btn-stab-high', 'aria-checked'), 'true');
    assert.equal(await page.getAttribute('#btn-look-natural', 'aria-checked'), 'true');
    assert.ok((await page.locator('#resolution-options .lens-chip').count()) >= 1);
    assert.ok((await page.locator('#megapixels-options .lens-chip').count()) >= 1);
    const diagText = await page.textContent('#diagnostics-list');
    assert.ok(diagText.includes('アプリバージョン') && diagText.includes('v1.8.0'));
    assert.ok(diagText.includes('撮影画質モード') && diagText.includes('高画質 HDR (常時有効)'));
    assert.ok(diagText.includes('仕上がりトーン') && diagText.includes('Pro ナチュラル'));
    assert.ok(diagText.includes('手ぶれ補正モード') && diagText.includes('高品質 (強'));
    assert.ok(diagText.includes('直近のブレ補正') && diagText.includes('採用'));
    assert.ok(diagText.includes('解像度設定 / 上限'));
    assert.ok(diagText.includes('保存画素数設定'));
    assert.ok(diagText.includes('WebGL') || diagText.includes('worker') || diagText.includes('canvas'));
    assert.ok(diagText.includes('保存フォーマット') && diagText.includes('AVIF'));
    assert.ok(diagText.includes('直近の生成ファイル') && diagText.includes('.avif') && diagText.includes('image/avif'));
    assert.ok(diagText.includes('カメラ権限状態'));
    assert.ok(diagText.includes('超広角 (0.5×) カメラ') && diagText.includes('非対応'));
    assert.equal(await page.locator('#ios-sensor-note').isVisible(), false);
    const guideText = await page.textContent('#permission-guide');
    assert.ok(guideText.includes('iOS Safari') && guideText.includes('Android'));
    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_info_sheet.png') });
    }

    // Select 'vivid' Look profile and toggle stabilization to 'standard' inside Info Sheet
    await page.click('#btn-look-vivid');
    assert.equal(await page.getAttribute('#btn-look-vivid', 'aria-checked'), 'true');
    await page.click('#btn-stab-standard');
    assert.equal(await page.getAttribute('#btn-stab-standard', 'aria-checked'), 'true');

    // Switch output format to JPEG and verify capture saves .jpg
    await page.click('#btn-format-jpeg');
    assert.equal(await page.getAttribute('#btn-format-jpeg', 'aria-checked'), 'true');
    await page.click('#btn-info-close');

    const jpgDlPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.click('#btn-shutter');
    const jpgDl = await jpgDlPromise;
    assert.ok(jpgDl.suggestedFilename().endsWith('_HDR.jpg'));
    await page.waitForFunction(() => window.__QCAM__.photos.length === 2);
    assert.equal(await page.evaluate(() => window.__QCAM__.photos[0].blob.type), 'image/jpeg');

    // Switch back to AVIF default
    await page.click('#btn-info');
    await page.waitForSelector('#info-modal:not([hidden])');
    await page.click('#btn-format-avif');
    assert.equal(await page.getAttribute('#btn-format-avif', 'aria-checked'), 'true');
    await page.click('#btn-info-close');

    // 14. Switch Camera (environment -> user) and verify settings persistence across reload
    await page.click('#btn-aspect'); // 4:3 -> 16:9
    await page.click('#btn-switch-camera');
    await page.waitForFunction(
      () =>
        window.__QCAM__.camera.facingMode === 'user' &&
        window.__QCAM__.camera.track &&
        window.__QCAM__.camera.track.readyState === 'live'
    );
    const trackIdBeforeVis = await page.evaluate(() => window.__QCAM__.camera.track?.id || '');

    // 15. Simulate transient visibilitychange (Share Sheet / Control Center) and verify track stays alive
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(80);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(80);
    const trackIdAfterVis = await page.evaluate(() => window.__QCAM__.camera.track?.id || '');
    assert.equal(
      trackIdAfterVis,
      trackIdBeforeVis,
      'Transient visibilitychange must keep active camera stream alive without re-prompting'
    );

    // 16. Verify persisted settings (16:9, grid ON, HDR always on, Look vivid, EIS standard, user facing) survive page reload cleanly
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForFunction(() => {
      const v = document.getElementById('camera-video');
      return Boolean(window.__QCAM__?.streamInfo && v && v.videoWidth > 0 && v.videoHeight > 0);
    }, { timeout: 6000 });
    assert.equal(await page.textContent('#aspect-label'), '16:9');
    assert.equal(await page.getAttribute('#btn-grid', 'aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.__QCAM__.settings.mode), 'hq');
    assert.equal(await page.evaluate(() => window.__QCAM__.settings.colorProfile), 'vivid');
    assert.equal(await page.evaluate(() => window.__QCAM__.settings.stabilization), 'standard');
    assert.equal(await page.evaluate(() => window.__QCAM__.camera.facingMode), 'user');

    // Switch EIS mode inside Info Sheet: standard -> off -> high
    await page.click('#btn-info');
    await page.waitForSelector('#info-modal:not([hidden])');
    await page.click('#btn-stab-off');
    assert.equal(await page.getAttribute('#btn-stab-off', 'aria-checked'), 'true');
    assert.equal(await page.evaluate(() => window.__QCAM__.settings.stabilization), 'off');
    await page.click('#btn-stab-high');
    assert.equal(await page.getAttribute('#btn-stab-high', 'aria-checked'), 'true');
    assert.equal(await page.evaluate(() => window.__QCAM__.settings.stabilization), 'high');
    await page.click('#btn-info-close');

    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_viewfinder_169.png') });
    }

    // 17. Responsive layout checks across smartphone viewports (360x640 compact Android, 375x667 SE, 844x390 landscape)
    console.log('[e2e] checking multi-smartphone viewports (360x640, 375x667, 844x390)');
    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(140);
    const compactStats = await page.evaluate(() => {
      const topBar = document.querySelector('.top-bar');
      const zoomBar = document.getElementById('zoom-bar');
      const zoomBarRect = zoomBar.getBoundingClientRect();
      const btnInfoRect = document.getElementById('btn-info').getBoundingClientRect();
      const shutterRect = document.getElementById('btn-shutter').getBoundingClientRect();
      const vfRect = document.getElementById('viewfinder-frame').getBoundingClientRect();

      return {
        topBarScrollW: topBar.scrollWidth,
        topBarClientW: topBar.clientWidth,
        zoomBarScrollW: zoomBar.scrollWidth,
        zoomBarClientW: zoomBar.clientWidth,
        zoomBarRight: zoomBarRect.right,
        zoomBarLeft: zoomBarRect.left,
        btnInfoRight: btnInfoRect.right,
        shutterBottom: shutterRect.bottom,
        shutterTop: shutterRect.top,
        vfWidth: vfRect.width,
        vfHeight: vfRect.height,
      };
    });
    assert.ok(compactStats.topBarScrollW <= compactStats.topBarClientW + 1, `Top bar overflowed on 360px: ${JSON.stringify(compactStats)}`);
    assert.ok(compactStats.zoomBarScrollW <= compactStats.zoomBarClientW + 1, `Zoom bar overflowed on 360px: ${JSON.stringify(compactStats)}`);
    assert.ok(compactStats.zoomBarLeft >= 0 && compactStats.zoomBarRight <= 360, `Zoom bar out of bounds on 360px: ${JSON.stringify(compactStats)}`);
    assert.ok(compactStats.btnInfoRight <= 360, `btn-info clipped on 360px: ${compactStats.btnInfoRight}`);
    assert.ok(compactStats.shutterBottom <= 640 && compactStats.shutterTop > 0, `Shutter out of bounds: ${JSON.stringify(compactStats)}`);
    assert.ok(compactStats.vfWidth >= 358, `16:9 portrait on 360x640 should use full 360px width, got ${compactStats.vfWidth}`);

    // Verify expanded zoom slider fits cleanly on 360px as well
    await page.click('#btn-zoom-slider-toggle');
    const compactSliderStats = await page.evaluate(() => {
      const panel = document.getElementById('zoom-slider-panel');
      const pr = panel.getBoundingClientRect();
      return { scrollW: panel.scrollWidth, clientW: panel.clientWidth, left: pr.left, right: pr.right };
    });
    assert.ok(
      compactSliderStats.scrollW <= compactSliderStats.clientW + 1 && compactSliderStats.left >= 0 && compactSliderStats.right <= 360,
      `Zoom slider overflowed 360px: ${JSON.stringify(compactSliderStats)}`
    );
    await page.click('#btn-zoom-slider-close');

    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_compact_360x640.png') });
    }

    // Check 375x667 (iPhone SE) in 4:3 as well
    await page.click('#btn-aspect'); // back to 4:3
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(140);
    const seBox = await page.locator('#viewfinder-frame').boundingBox();
    assert.ok(seBox.width >= 335, `4:3 on 375x667 too narrow: ${seBox.width}`);
    assert.ok(Math.abs(seBox.width / seBox.height - 3 / 4) < 0.04);

    // Check 844x390 Smartphone Landscape
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(160);
    const landStats = await page.evaluate(() => {
      const dock = document.querySelector('.bottom-dock').getBoundingClientRect();
      const zoomDock = document.getElementById('zoom-dock').getBoundingClientRect();
      const zoomBar = document.querySelector('.zoom-bar').getBoundingClientRect();
      const topHud = document.getElementById('top-hud').getBoundingClientRect();
      const shutter = document.getElementById('btn-shutter').getBoundingClientRect();
      const shutterRow = document.querySelector('.shutter-row').getBoundingClientRect();
      const vf = document.getElementById('viewfinder-frame').getBoundingClientRect();
      return {
        dock,
        zoomDock,
        zoomBar,
        topHud,
        shutter,
        shutterRow,
        vf,
        dockScrollH: document.querySelector('.bottom-dock').scrollHeight,
      };
    });
    assert.ok(landStats.dock.height <= 391 && landStats.dockScrollH <= 391, `Landscape dock overflowed vertically: ${JSON.stringify(landStats)}`);
    assert.ok(landStats.zoomBar.right <= landStats.dock.left + 1, `Zoom bar overlaps landscape right dock: ${JSON.stringify(landStats)}`);
    assert.ok(landStats.zoomDock.right <= landStats.dock.left + 1, `Zoom dock overlaps landscape right dock: ${JSON.stringify(landStats)}`);
    assert.ok(landStats.topHud.right <= landStats.dock.left + 1, `Top HUD overlaps landscape right dock: ${JSON.stringify(landStats)}`);
    assert.ok(landStats.shutter.bottom <= 390 && landStats.shutterRow.top >= 0);
    assert.ok(
      Math.abs((landStats.shutterRow.top + landStats.shutterRow.bottom) / 2 - 195) < 40,
      `Landscape shutter row should sit balanced near vertical center, got ${JSON.stringify(landStats.shutterRow)}`
    );
    assert.ok(landStats.vf.left + landStats.vf.width <= landStats.dock.left + 2, `Landscape viewfinder hidden under dock: ${JSON.stringify(landStats.vf)}`);

    // Check expanded zoom slider also avoids right dock in landscape
    await page.click('#btn-zoom-slider-toggle');
    const landSliderStats = await page.evaluate(() => {
      const panel = document.getElementById('zoom-slider-panel').getBoundingClientRect();
      const dock = document.querySelector('.bottom-dock').getBoundingClientRect();
      return { left: panel.left, right: panel.right, dockLeft: dock.left };
    });
    assert.ok(landSliderStats.left >= 0 && landSliderStats.right <= landSliderStats.dockLeft + 1, `Landscape zoom slider overlaps dock: ${JSON.stringify(landSliderStats)}`);
    await page.click('#btn-zoom-slider-close');

    // Tap near right edge of landscape viewfinder and verify EV slider flips left cleanly
    await page.mouse.click(landStats.vf.left + landStats.vf.width - 14, landStats.vf.top + landStats.vf.height * 0.5);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => document.getElementById('focus-reticle').classList.contains('is-ev-left')), true);
    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_landscape_844x390.png') });
    }
    await context.close();

    // 18. Camera denied recovery flow in isolated context
    console.log('[e2e] checking camera denied fallback UX');
    const deniedContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const deniedPage = await deniedContext.newPage();
    await deniedPage.addInitScript(() => {
      if (navigator.permissions) {
        navigator.permissions.query = (desc) => {
          if (desc && desc.name === 'camera') {
            return Promise.resolve({ state: 'denied' });
          }
          return Promise.resolve({ state: 'prompt' });
        };
      }
    });
    await deniedPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await deniedPage.waitForSelector('#camera-overlay:not([hidden])', { timeout: 6000 });
    assert.equal(await deniedPage.locator('#btn-overlay-help').isVisible(), true);
    await deniedPage.click('#btn-overlay-help');
    await deniedPage.waitForSelector('#info-modal:not([hidden])');
    await deniedContext.close();

    // 19. iPhone Safari simulation: auto Share Sheet on shutter, NotAllowedError fallback to Preview Modal, direct .avif DL, & standalone PWA guard
    console.log('[e2e] checking iPhone Safari auto Share Sheet, .avif direct DL, & manual save fallback flow');
    const iosContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      acceptDownloads: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
      permissions: ['camera'],
    });
    const iosPage = await iosContext.newPage();
    iosPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[ios] ${msg.text()}`);
    });
    iosPage.on('pageerror', (err) => {
      pageErrors.push(`[ios] ${err.message}`);
    });
    await iosPage.addInitScript(() => {
      // Simulate legacy v1.1.0 persisted iOS setting (autoSave: false without autoSaveExplicit)
      localStorage.setItem(
        'qcam_settings_v1',
        JSON.stringify({ aspectRatio: '4:3', autoSave: false, mode: 'standard' })
      );
      window.__SHARE_CALLS__ = [];
      window.__SHARE_MODE__ = 'resolve';
      navigator.canShare = (data) => Array.isArray(data?.files) && data.files.length === 1;
      navigator.share = async (data) => {
        const file = data?.files?.[0];
        window.__SHARE_CALLS__.push({
          keys: Object.keys(data || {}),
          fileName: file?.name || '',
          fileType: file?.type || '',
          mode: window.__SHARE_MODE__,
        });
        if (window.__SHARE_MODE__ === 'expire') {
          throw new DOMException('Transient activation expired', 'NotAllowedError');
        }
      };
    });

    await iosPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await iosPage.waitForFunction(() => {
      const v = document.getElementById('camera-video');
      return Boolean(window.__QCAM__?.streamInfo && v && v.videoWidth > 0 && v.videoHeight > 0);
    }, { timeout: 6000 });

    // Confirm legacy iOS setting migrated autoSave to true and mode to 'hq' HDR automatically
    assert.equal(await iosPage.evaluate(() => window.__QCAM__.settings.autoSave), true);
    assert.equal(await iosPage.evaluate(() => window.__QCAM__.settings.mode), 'hq');

    // Direct capture triggers Web Share immediately with strictly { files: [...] } and _HDR.avif / image/avif
    await iosPage.click('#btn-shutter');
    await iosPage.waitForFunction(() => window.__SHARE_CALLS__.length === 1, null, { timeout: 20000 });
    const firstShareCall = await iosPage.evaluate(() => window.__SHARE_CALLS__[0]);
    assert.deepEqual(firstShareCall.keys, ['files']);
    assert.ok(firstShareCall.fileName.includes('_HDR.avif'), `Expected _HDR.avif filename, got ${firstShareCall.fileName}`);
    assert.equal(firstShareCall.fileType, 'image/avif');
    assert.equal(await iosPage.locator('#preview-modal').isVisible(), false);

    // Simulate NotAllowedError on next capture (e.g., slow burst) -> Preview Modal opens automatically with visible toast & direct .avif DL
    await iosPage.waitForFunction(() => !window.__QCAM__.isCapturing, null, { timeout: 10000 });
    await iosPage.evaluate(() => {
      window.__SHARE_MODE__ = 'expire';
    });
    await iosPage.click('#btn-shutter');
    await iosPage.waitForSelector('#preview-modal:not([hidden])', { timeout: 20000 });
    assert.ok(
      (await iosPage.textContent('#btn-modal-save')).includes('AVIF') ||
        (await iosPage.textContent('#btn-modal-save')).includes('.avif'),
      'iOS AVIF preview primary save button should reference .avif'
    );
    assert.equal(
      await iosPage.locator('#btn-modal-share').isVisible(),
      true,
      'Non-standalone iOS Safari should show direct .avif download button'
    );
    assert.ok((await iosPage.textContent('#btn-modal-share')).includes('.avif'));
    const iosHintText = await iosPage.textContent('#preview-save-hint');
    assert.ok(iosHintText.includes('ファイル') && iosHintText.includes('JPEG'));
    assert.equal(await iosPage.locator('#modal-toast').isVisible(), true);
    assert.ok(
      (await iosPage.evaluate(() => document.getElementById('preview-image').naturalWidth)) > 0,
      'iOS preview AVIF image must decode cleanly'
    );
    const iosModalLayout = await iosPage.evaluate(() => {
      const saveBtn = document.getElementById('btn-modal-save').getBoundingClientRect();
      const dlBtn = document.getElementById('btn-modal-share').getBoundingClientRect();
      const hint = document.getElementById('preview-save-hint').getBoundingClientRect();
      const stage = document.getElementById('preview-stage').getBoundingClientRect();
      return { saveBtn, dlBtn, hint, stage };
    });
    assert.ok(
      iosModalLayout.dlBtn.right <= iosModalLayout.saveBtn.left + 1 &&
        iosModalLayout.saveBtn.right <= 390 &&
        iosModalLayout.stage.height >= 200,
      `iOS preview modal layout issue: ${JSON.stringify(iosModalLayout)}`
    );
    if (screenshotDir) {
      await iosPage.screenshot({ path: path.join(screenshotDir, 'e2e_ios_preview_avif.png') });
    }

    // Clicking the secondary direct-DL button on non-standalone iPhone Safari triggers an actual .avif download
    const iosDirectDlPromise = iosPage.waitForEvent('download', { timeout: 6000 });
    await iosPage.click('#btn-modal-share');
    const iosDirectDl = await iosDirectDlPromise;
    assert.ok(
      iosDirectDl.suggestedFilename().endsWith('.avif'),
      `iOS direct DL should save .avif, got ${iosDirectDl.suggestedFilename()}`
    );

    // Clicking the modal save button retries Share Sheet with fresh click gesture
    await iosPage.evaluate(() => {
      window.__SHARE_MODE__ = 'resolve';
    });
    await iosPage.click('#btn-modal-save');
    await iosPage.waitForFunction(() => window.__SHARE_CALLS__.length === 3, { timeout: 4000 });
    const modalShareCall = await iosPage.evaluate(() => window.__SHARE_CALLS__[2]);
    assert.ok(modalShareCall.fileName.endsWith('.avif'));
    assert.equal(modalShareCall.fileType, 'image/avif');
    assert.ok((await iosPage.textContent('#modal-toast')).includes('ファイル'));

    await iosPage.click('#btn-modal-close');
    await iosPage.click('#btn-info');
    await iosPage.waitForSelector('#info-modal:not([hidden])');
    // Switching iOS setting to JPEG hides direct .avif DL and uses Photos save wording
    await iosPage.click('#btn-format-jpeg');
    const iosGuideText = await iosPage.textContent('#permission-guide');
    assert.ok(iosGuideText.includes('設定') && iosGuideText.includes('Safari') && iosGuideText.includes('許可'));
    await iosPage.click('#btn-info-close');

    await iosPage.evaluate(() => {
      window.__SHARE_MODE__ = 'expire';
    });
    await iosPage.click('#btn-shutter');
    await iosPage.waitForSelector('#preview-modal:not([hidden])', { timeout: 10000 });
    assert.ok((await iosPage.textContent('#btn-modal-save')).includes('写真'));
    assert.equal(await iosPage.locator('#btn-modal-share').isVisible(), false);
    await iosPage.click('#btn-modal-close');
    await iosContext.close();

    // 19b. iPhone Standalone PWA simulation: direct <a download> button stays hidden to prevent PWA navigation trap
    const iosPwaContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
      permissions: ['camera'],
    });
    const iosPwaPage = await iosPwaContext.newPage();
    await iosPwaPage.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => true });
      navigator.canShare = (data) => Array.isArray(data?.files) && data.files.length === 1;
      navigator.share = async () => {
        throw new DOMException('Activation expired', 'NotAllowedError');
      };
    });
    await iosPwaPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await iosPwaPage.waitForFunction(() => {
      const v = document.getElementById('camera-video');
      return Boolean(window.__QCAM__?.streamInfo && v && v.videoWidth > 0 && v.videoHeight > 0);
    }, { timeout: 6000 });
    await iosPwaPage.click('#btn-shutter');
    await iosPwaPage.waitForSelector('#preview-modal:not([hidden])', { timeout: 10000 });
    assert.equal(
      await iosPwaPage.locator('#btn-modal-share').isVisible(),
      false,
      'Standalone iOS PWA must hide direct anchor download button'
    );
    assert.ok((await iosPwaPage.textContent('#btn-modal-save')).includes('.avif'));
    assert.ok(!(await iosPwaPage.textContent('#preview-save-hint')).includes('直接DL'));
    await iosPwaContext.close();

    // 20. Android Chrome 0.5x hardware zoom simulation (capabilities.zoom.min = 0.5) & compact layout check
    console.log('[e2e] checking Android 0.5x hardware zoom & compact 360x640 / landscape layout');
    const androidUwContext = await browser.newContext({
      viewport: { width: 360, height: 640 },
      hasTouch: true,
      isMobile: true,
      acceptDownloads: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 15; SC-51E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
      permissions: ['camera'],
    });
    const androidUwPage = await androidUwContext.newPage();
    androidUwPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[android-uw] ${msg.text()}`);
    });
    androidUwPage.on('pageerror', (err) => {
      pageErrors.push(`[android-uw] ${err.message}`);
    });
    await androidUwPage.addInitScript(() => {
      window.__APPLIED_CONSTRAINTS__ = [];
      const devicesList = [
        {
          kind: 'videoinput',
          deviceId: 'android-back-0',
          groupId: 'g-back',
          label: 'camera2 0, facing back',
          toJSON() { return this; },
          getCapabilities: () => ({
            facingMode: ['environment'],
            zoom: { min: 0.5, max: 6.0, step: 0.1 },
            width: { min: 320, max: 1920 },
            height: { min: 240, max: 1080 },
          }),
        },
        {
          kind: 'videoinput',
          deviceId: 'android-front-1',
          groupId: 'g-front',
          label: 'camera2 1, facing front',
          toJSON() { return this; },
          getCapabilities: () => ({
            facingMode: ['user'],
            width: { min: 320, max: 1920 },
            height: { min: 240, max: 1080 },
          }),
        },
      ];

      navigator.mediaDevices.enumerateDevices = async () => devicesList;
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const v = constraints?.video || {};
        const reqFacing = typeof v === 'object' ? (v.facingMode?.ideal || v.facingMode || 'environment') : 'environment';
        const isFront = reqFacing === 'user';
        const deviceId = isFront ? 'android-front-1' : 'android-back-0';
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        let tick = 0;
        const paint = () => {
          tick += 1;
          ctx.fillStyle = isFront ? '#122233' : '#182418';
          ctx.fillRect(0, 0, 1280, 720);
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(40 + (tick % 10), 40, 220, 90);
        };
        paint();
        const iv = setInterval(paint, 120);
        const stream = canvas.captureStream(15);
        const track = stream.getVideoTracks()[0];
        const origStop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(iv);
          return origStop();
        };
        track.getSettings = () => ({
          deviceId,
          facingMode: isFront ? 'user' : 'environment',
          width: 1280,
          height: 720,
          frameRate: 30,
        });
        track.getCapabilities = () =>
          isFront
            ? { facingMode: ['user'], width: { min: 320, max: 1920 }, height: { min: 240, max: 1080 } }
            : {
                facingMode: ['environment'],
                zoom: { min: 0.5, max: 6.0, step: 0.1 },
                width: { min: 320, max: 1920 },
                height: { min: 240, max: 1080 },
              };
        track.applyConstraints = async (c) => {
          window.__APPLIED_CONSTRAINTS__.push(c);
        };
        return stream;
      };
    });

    await androidUwPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await androidUwPage.waitForFunction(() => {
      const v = document.getElementById('camera-video');
      return Boolean(window.__QCAM__?.streamInfo && v && v.videoWidth > 0 && v.videoHeight > 0);
    }, { timeout: 6000 });

    assert.equal(await androidUwPage.locator('#btn-zoom-05').isVisible(), true);
    assert.equal((await androidUwPage.textContent('#btn-zoom-05')).trim(), '0.5');
    assert.equal((await androidUwPage.textContent('.zoom-preset[data-zoom="1"]')).trim(), '1×');

    const uwCompactOverflow = await androidUwPage.evaluate(() => {
      const zb = document.querySelector('.zoom-bar');
      const zbr = zb.getBoundingClientRect();
      return {
        scrollW: zb.scrollWidth,
        clientW: zb.clientWidth,
        barLeft: zbr.left,
        barRight: zbr.right,
      };
    });
    assert.ok(
      uwCompactOverflow.scrollW <= uwCompactOverflow.clientW + 1 &&
        uwCompactOverflow.barLeft >= 0 &&
        uwCompactOverflow.barRight <= 360,
      `0.5x zoom bar overflowed 360px: ${JSON.stringify(uwCompactOverflow)}`
    );

    await androidUwPage.click('#btn-zoom-slider-toggle');
    const uwSliderOverflow = await androidUwPage.evaluate(() => {
      const panel = document.getElementById('zoom-slider-panel');
      const sl = document.getElementById('zoom-slider').getBoundingClientRect();
      const pr = panel.getBoundingClientRect();
      return {
        scrollW: panel.scrollWidth,
        clientW: panel.clientWidth,
        sliderRight: sl.right,
        panelRight: pr.right,
      };
    });
    assert.ok(
      uwSliderOverflow.scrollW <= uwSliderOverflow.clientW + 1 && uwSliderOverflow.panelRight <= 360,
      `0.5x zoom slider overflowed 360px: ${JSON.stringify(uwSliderOverflow)}`
    );
    await androidUwPage.click('#btn-zoom-slider-close');

    await androidUwPage.click('#btn-zoom-05');
    await androidUwPage.waitForFunction(
      () => Math.abs(window.__QCAM__.camera.targetZoom - 0.5) < 0.01
    );
    assert.equal(await androidUwPage.textContent('#zoom-readout'), '0.5×');
    assert.equal((await androidUwPage.textContent('#btn-zoom-05')).trim(), '0.5×');
    assert.equal((await androidUwPage.textContent('.zoom-preset[data-zoom="1"]')).trim(), '1');
    const hwUwState = await androidUwPage.evaluate(() => ({
      softwareZoom: window.__QCAM__.camera.softwareZoom,
      hardwareZoom: window.__QCAM__.camera.hardwareZoom,
      constraints: window.__APPLIED_CONSTRAINTS__,
      transform: document.getElementById('camera-video').style.transform,
      uwActive: document.getElementById('btn-zoom-05').classList.contains('is-active'),
      wideActive: document.querySelector('.zoom-preset[data-zoom="1"]').classList.contains('is-active'),
    }));
    assert.equal(hwUwState.softwareZoom, 1);
    assert.equal(hwUwState.hardwareZoom, 0.5);
    assert.equal(hwUwState.transform, 'scale(1, 1)');
    assert.equal(hwUwState.uwActive, true);
    assert.equal(hwUwState.wideActive, false);
    assert.ok(
      hwUwState.constraints.some((c) => c?.advanced?.[0]?.zoom === 0.5),
      `Expected hardware zoom 0.5 constraint, got ${JSON.stringify(hwUwState.constraints)}`
    );
    if (screenshotDir) {
      await androidUwPage.waitForTimeout(200);
      await androidUwPage.screenshot({ path: path.join(screenshotDir, 'e2e_ultrawide_360x640.png') });
    }

    const uwDlPromise = androidUwPage.waitForEvent('download', { timeout: 10000 });
    await androidUwPage.click('#btn-shutter');
    const uwDl = await uwDlPromise;
    assert.ok(uwDl.suggestedFilename().endsWith('.avif'));

    // Check 844x390 landscape with 0.5x visible
    await androidUwPage.setViewportSize({ width: 844, height: 390 });
    await androidUwPage.waitForTimeout(160);
    const uwLandStats = await androidUwPage.evaluate(() => {
      const zb = document.querySelector('.zoom-bar');
      const zbr = zb.getBoundingClientRect();
      const dock = document.querySelector('.bottom-dock').getBoundingClientRect();
      return {
        scrollW: zb.scrollWidth,
        clientW: zb.clientWidth,
        zbRight: zbr.right,
        dockLeft: dock.left,
      };
    });
    assert.ok(uwLandStats.scrollW <= uwLandStats.clientW + 1);
    assert.ok(uwLandStats.zbRight <= uwLandStats.dockLeft + 1);
    if (screenshotDir) {
      await androidUwPage.screenshot({ path: path.join(screenshotDir, 'e2e_ultrawide_landscape.png') });
    }

    // Switch to front camera -> 0.5x must hide cleanly; switch back -> reappears
    await androidUwPage.click('#btn-switch-camera');
    await androidUwPage.waitForFunction(
      () => !window.__QCAM__.isSwitchingCamera && window.__QCAM__.streamInfo?.facingMode === 'user'
    );
    assert.equal(await androidUwPage.locator('#btn-zoom-05').isVisible(), false);
    assert.equal(await androidUwPage.evaluate(() => window.__QCAM__.ui.state.minZoom), 1);

    await androidUwPage.click('#btn-switch-camera');
    await androidUwPage.waitForFunction(
      () => !window.__QCAM__.isSwitchingCamera && window.__QCAM__.streamInfo?.facingMode === 'environment'
    );
    assert.equal(await androidUwPage.locator('#btn-zoom-05').isVisible(), true);

    await androidUwPage.click('#btn-info');
    await androidUwPage.waitForSelector('#info-modal:not([hidden])');
    const hwDiag = await androidUwPage.textContent('#diagnostics-list');
    assert.ok(hwDiag.includes('光学ズーム倍率制御'));
    await androidUwContext.close();

    // 21. iPhone Safari multi-lens enumeration ("背面超広角カメラ") -> 0.5x switch & persistence guard
    console.log('[e2e] checking iPhone Safari enumerateDevices 0.5x ultra-wide switch & rollback');
    const iosUwContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
      permissions: ['camera'],
    });
    const iosUwPage = await iosUwContext.newPage();
    iosUwPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[ios-uw] ${msg.text()}`);
    });
    iosUwPage.on('pageerror', (err) => {
      pageErrors.push(`[ios-uw] ${err.message}`);
    });
    await iosUwPage.addInitScript(() => {
      window.__GUM_CALLS__ = [];
      navigator.canShare = (d) => Array.isArray(d?.files) && d.files.length === 1;
      navigator.share = async () => {};

      const iosDevices = [
        { kind: 'videoinput', deviceId: 'ios-front', groupId: 'f1', label: '前面カメラ', toJSON() { return this; } },
        { kind: 'videoinput', deviceId: 'ios-front-uw', groupId: 'f2', label: 'Front Ultra Wide Camera', toJSON() { return this; } },
        { kind: 'videoinput', deviceId: 'ios-desk', groupId: 'f3', label: 'デスクビューカメラ', toJSON() { return this; } },
        { kind: 'videoinput', deviceId: 'ios-back-std', groupId: 'b1', label: '背面カメラ', toJSON() { return this; } },
        { kind: 'videoinput', deviceId: 'ios-back-uw', groupId: 'b2', label: '背面超広角カメラ', toJSON() { return this; } },
        { kind: 'videoinput', deviceId: 'ios-back-triple', groupId: 'b3', label: '背面トリプルカメラ', toJSON() { return this; } },
      ];

      navigator.mediaDevices.enumerateDevices = async () => iosDevices;
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const v = constraints?.video || {};
        window.__GUM_CALLS__.push(JSON.parse(JSON.stringify(v)));
        const exactId = typeof v === 'object' ? (v.deviceId?.exact || v.deviceId?.ideal) : null;
        const reqFacing = typeof v === 'object' ? (v.facingMode?.ideal || v.facingMode) : null;

        let chosen = iosDevices.find((d) => d.deviceId === exactId);
        if (!chosen) {
          chosen = reqFacing === 'user' ? iosDevices[0] : iosDevices[3]; // ios-back-std by default
        }

        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 960;
        const ctx = canvas.getContext('2d');
        const paint = () => {
          ctx.fillStyle = chosen.deviceId === 'ios-back-uw' ? '#0f2d2e' : '#1b1d29';
          ctx.fillRect(0, 0, 1280, 960);
          ctx.fillStyle = '#38bdf8';
          ctx.fillRect(80, 80, 180, 180);
        };
        paint();
        const iv = setInterval(paint, 120);
        const stream = canvas.captureStream(15);
        const track = stream.getVideoTracks()[0];
        const origStop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(iv);
          return origStop();
        };
        Object.defineProperty(track, 'label', { configurable: true, get: () => chosen.label });
        track.getSettings = () => ({
          deviceId: chosen.deviceId,
          facingMode: chosen.deviceId.startsWith('ios-front') ? 'user' : 'environment',
          width: 1280,
          height: 960,
          frameRate: 30,
        });
        // iOS Safari omits track.getCapabilities().zoom
        track.getCapabilities = () => ({
          facingMode: [chosen.deviceId.startsWith('ios-front') ? 'user' : 'environment'],
          width: { min: 320, max: 1920 },
          height: { min: 240, max: 1440 },
        });
        return stream;
      };
    });

    await iosUwPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await iosUwPage.waitForFunction(() => {
      const v = document.getElementById('camera-video');
      return v && v.videoWidth > 0 && v.videoHeight > 0 && window.__QCAM__.streamInfo?.activeDeviceId === 'ios-back-std';
    }, { timeout: 6000 });

    assert.equal(await iosUwPage.locator('#btn-zoom-05').isVisible(), true);
    assert.equal(await iosUwPage.evaluate(() => window.__QCAM__.camera.activeDeviceId), 'ios-back-std');

    // Click 0.5x preset -> switches strictly via deviceId: { exact: 'ios-back-uw' } without facingMode
    await iosUwPage.click('#btn-zoom-05');
    await iosUwPage.waitForFunction(
      () =>
        window.__QCAM__.streamInfo?.activeDeviceId === 'ios-back-uw' &&
        Math.abs(window.__QCAM__.camera.targetZoom - 0.5) < 0.01
    );
    assert.equal(await iosUwPage.textContent('#zoom-readout'), '0.5×');
    assert.equal(await iosUwPage.evaluate(() => window.__QCAM__.camera.softwareZoom), 1);

    const uwGumCall = await iosUwPage.evaluate(() =>
      window.__GUM_CALLS__.find((c) => c?.deviceId?.exact === 'ios-back-uw')
    );
    assert.ok(uwGumCall, 'Expected exact deviceId call for ios-back-uw');
    assert.equal(uwGumCall.facingMode, undefined, 'Exact lens switch must not pair facingMode');

    // Persisted standard environment ID must NOT be overwritten by ios-back-uw
    const storedMap = await iosUwPage.evaluate(() =>
      JSON.parse(localStorage.getItem('qcam_device_ids_v1') || '{}')
    );
    assert.equal(storedMap.environment, 'ios-back-std');

    // Manual back lens list inside #info-modal excludes Front Ultra Wide and Desk View
    await iosUwPage.click('#btn-info');
    await iosUwPage.waitForSelector('#back-lens-section:not([hidden])');
    const chipTexts = await iosUwPage.locator('#back-lens-options .lens-chip').allTextContents();
    assert.equal(chipTexts.length, 3);
    assert.ok(chipTexts.some((t) => t.includes('超広角 (0.5×)')));
    assert.ok(!chipTexts.some((t) => t.includes('Front') || t.includes('デスク')));
    await iosUwPage.click('#btn-info-close');

    // Clicking 2x while on 0.5x switches cleanly back to standard lens ('ios-back-std') then zooms to 2.0x
    await iosUwPage.click('.zoom-preset[data-zoom="2"]');
    await iosUwPage.waitForFunction(
      () =>
        window.__QCAM__.streamInfo?.activeDeviceId === 'ios-back-std' &&
        Math.abs(window.__QCAM__.camera.targetZoom - 2.0) < 0.01
    );
    assert.equal(await iosUwPage.textContent('#zoom-readout'), '2.0×');
    assert.equal(await iosUwPage.evaluate(() => window.__QCAM__.camera.softwareZoom), 2);

    // Reload comes back on 1.0x standard lens cleanly
    await iosUwPage.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await iosUwPage.waitForFunction(
      () => window.__QCAM__.streamInfo?.activeDeviceId === 'ios-back-std'
    );
    assert.equal(await iosUwPage.textContent('#zoom-readout'), '1.0×');
    await iosUwContext.close();

    // 22. Per-device max resolution auto-upgrade, camera resolution/megapixels UI, and Android high-res takePhoto() + HDR pipeline
    console.log('[e2e] checking per-device max resolution upgrade, resolution/MP settings UI & takePhoto+HDR');
    const hiResContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      acceptDownloads: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
      permissions: ['camera'],
    });
    const hiResPage = await hiResContext.newPage();
    hiResPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[android-hires] ${msg.text()}`);
    });
    hiResPage.on('pageerror', (err) => {
      pageErrors.push(`[android-hires] ${err.message}`);
    });
    await hiResPage.addInitScript(() => {
      window.__HIRES_APPLIED__ = [];
      window.__HIRES_TAKEPHOTO__ = [];

      window.ImageCapture = class MockImageCapture {
        constructor(track) {
          this.track = track;
        }
        async getPhotoCapabilities() {
          await new Promise((r) => setTimeout(r, 25));
          return {
            imageWidth: { min: 640, max: 4800, step: 2 },
            imageHeight: { min: 480, max: 3600, step: 2 },
          };
        }
        async grabFrame() {
          const canvas = this.track?.__qcamCanvas;
          return createImageBitmap(canvas);
        }
        async takePhoto(settings = {}) {
          const w = Math.min(4800, Math.max(640, Number(settings.imageWidth) || 4800));
          const h = Math.min(3600, Math.max(480, Number(settings.imageHeight) || 3600));
          window.__HIRES_TAKEPHOTO__.push({ width: w, height: h });
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          const ctx = c.getContext('2d');
          ctx.fillStyle = '#1e293b';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = '#ef4444';
          ctx.fillRect(0, 0, Math.round(w * 0.2), Math.round(h * 0.2));
          ctx.fillStyle = '#22c55e';
          ctx.fillRect(Math.round(w * 0.8), 0, Math.round(w * 0.2), Math.round(h * 0.2));
          ctx.fillStyle = '#38bdf8';
          ctx.fillRect(Math.round(w * 0.35), Math.round(h * 0.35), Math.round(w * 0.3), Math.round(h * 0.3));
          return await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
        }
      };

      const capW = 2560;
      const capH = 1920;
      navigator.mediaDevices.enumerateDevices = async () => [
        {
          kind: 'videoinput',
          deviceId: 'hires-back-0',
          groupId: 'g-hi',
          label: 'camera2 0, facing back',
          toJSON() { return this; },
          getCapabilities: () => ({
            facingMode: ['environment'],
            width: { min: 320, max: capW },
            height: { min: 240, max: capH },
          }),
        },
      ];

      navigator.mediaDevices.getUserMedia = async () => {
        // Simulate driver that initially opens at 1280x720 before applyConstraints upgrades it to sensor max (2560x1920)
        let curW = 1280;
        let curH = 720;
        const canvas = document.createElement('canvas');
        canvas.width = curW;
        canvas.height = curH;
        const ctx = canvas.getContext('2d');
        const paint = () => {
          ctx.fillStyle = '#162230';
          ctx.fillRect(0, 0, curW, curH);
          ctx.fillStyle = '#fbbf24';
          ctx.fillRect(40, 40, Math.round(curW * 0.18), Math.round(curH * 0.18));
        };
        paint();
        const iv = setInterval(paint, 120);
        const stream = canvas.captureStream(15);
        const track = stream.getVideoTracks()[0];
        track.__qcamCanvas = canvas;
        const origStop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(iv);
          return origStop();
        };
        track.getSettings = () => ({
          deviceId: 'hires-back-0',
          facingMode: 'environment',
          width: curW,
          height: curH,
          frameRate: 30,
        });
        track.getCapabilities = () => ({
          facingMode: ['environment'],
          width: { min: 320, max: capW },
          height: { min: 240, max: capH },
        });
        track.applyConstraints = async (c) => {
          window.__HIRES_APPLIED__.push(JSON.parse(JSON.stringify(c || {})));
          const reqW = Number(c?.width?.ideal);
          const reqH = Number(c?.height?.ideal);
          if (reqW > 0 && reqH > 0) {
            curW = Math.min(capW, Math.max(320, Math.round(reqW)));
            curH = Math.min(capH, Math.max(240, Math.round(reqH)));
            canvas.width = curW;
            canvas.height = curH;
            paint();
          }
        };
        return stream;
      };
    });

    await hiResPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    // Verify initial 1280x720 stream automatically upgraded via applyConstraints to 2560x1920 max
    await hiResPage.waitForFunction(
      () =>
        window.__QCAM__.streamInfo?.videoWidth === 2560 &&
        window.__QCAM__.streamInfo?.videoHeight === 1920 &&
        window.__QCAM__.streamInfo?.photoMaxWidth === 4800 &&
        document.getElementById('camera-video').videoWidth === 2560,
      { timeout: 10000 }
    );
    assert.ok(
      await hiResPage.evaluate(() =>
        window.__HIRES_APPLIED__.some((c) => c?.width?.ideal === 2560 && c?.height?.ideal === 1920)
      ),
      'Expected automatic applyConstraints upgrade to 2560x1920 sensor max'
    );

    // Open settings and inspect per-device tailored resolution & megapixel chips
    await hiResPage.click('#btn-info');
    await hiResPage.waitForSelector('#info-modal:not([hidden])');
    const resChipTexts = await hiResPage.locator('#resolution-options .lens-chip').allTextContents();
    assert.ok(resChipTexts.some((t) => t.includes('最高 (2560×1920)')), `Missing max 2560x1920 option: ${resChipTexts}`);
    assert.ok(resChipTexts.some((t) => t.includes('FHD')), `Missing FHD option: ${resChipTexts}`);
    assert.ok(!resChipTexts.some((t) => t.includes('4K')), `4K option should not appear when sensor max is 2560x1920: ${resChipTexts}`);
    assert.equal(await hiResPage.getAttribute('#resolution-options [data-resolution-preset="max"]', 'aria-checked'), 'true');
    assert.ok((await hiResPage.textContent('#diagnostics-list')).includes('2560×1920'));

    // AVIF caps >16MP sensor cleanly with clear note and allows full 17.3 MP in JPEG
    const avifMpTopText = await hiResPage.textContent('#megapixels-options [data-megapixels="max"]');
    const avifMpNote = await hiResPage.textContent('#megapixels-setting-note');
    assert.ok(avifMpTopText.includes('AVIF上限'), `Expected AVIF cap label on 17.3MP sensor, got ${avifMpTopText}`);
    assert.ok(avifMpNote.includes('JPEG時はさらに高画素可'), `Expected JPEG upgrade hint, got ${avifMpNote}`);

    // Switch resolution preset to FHD and verify live stream updates & persists across reload
    await hiResPage.click('#resolution-options [data-resolution-preset="fhd"]');
    await hiResPage.waitForFunction(
      () =>
        window.__QCAM__.streamInfo?.videoWidth === 1920 &&
        window.__QCAM__.streamInfo?.videoHeight === 1440 &&
        document.getElementById('camera-video').videoWidth === 1920,
      { timeout: 6000 }
    );
    await hiResPage.click('#btn-info-close');

    await hiResPage.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await hiResPage.waitForFunction(
      () =>
        window.__QCAM__.settings.cameraResolution === 'fhd' &&
        window.__QCAM__.streamInfo?.videoWidth === 1920 &&
        window.__QCAM__.streamInfo?.videoHeight === 1440 &&
        document.getElementById('camera-video').videoWidth === 1920,
      { timeout: 10000 }
    );

    // Capture in AVIF with '8 MP' selected -> uses Android takePhoto() + HDR and outputs 8MP AVIF
    await hiResPage.click('#btn-info');
    await hiResPage.waitForSelector('#info-modal:not([hidden])');
    assert.ok((await hiResPage.textContent('#diagnostics-list')).includes('1920×1440'));
    await hiResPage.click('#megapixels-options [data-megapixels="8"]');
    assert.equal(await hiResPage.evaluate(() => window.__QCAM__.settings.outputMegapixels), 8);
    await hiResPage.click('#btn-info-close');

    const avif8MpDlPromise = hiResPage.waitForEvent('download', { timeout: 20000 });
    await hiResPage.click('#btn-shutter');
    const avif8MpDl = await avif8MpDlPromise;
    assert.ok(avif8MpDl.suggestedFilename().includes('_HDR.avif'));
    await hiResPage.waitForFunction(() => window.__QCAM__.photos.length === 1 && !window.__QCAM__.isCapturing, { timeout: 20000 });
    const avif8MpPhoto = await hiResPage.evaluate(() => {
      const p = window.__QCAM__.photos[0];
      return {
        width: p.width,
        height: p.height,
        mode: p.mode,
        format: p.format,
        source: window.__QCAM__.lastCaptureSource,
      };
    });
    assert.equal(avif8MpPhoto.mode, 'hq');
    assert.equal(avif8MpPhoto.format, 'avif');
    assert.equal(avif8MpPhoto.source, 'takePhoto');
    assert.ok(avif8MpPhoto.width >= 3200 && avif8MpPhoto.width <= 3320, `Expected ~3266px width for 8MP, got ${avif8MpPhoto.width}`);
    assert.ok(avif8MpPhoto.height >= 2400 && avif8MpPhoto.height <= 2500, `Expected ~2450px height for 8MP, got ${avif8MpPhoto.height}`);

    // Switch back to 'max' MP + JPEG format -> unlocks full 4800x3600 (17.3 MP) takePhoto() + HDR output
    await hiResPage.click('#btn-info');
    await hiResPage.waitForSelector('#info-modal:not([hidden])');
    await hiResPage.click('#btn-format-jpeg');
    await hiResPage.click('#megapixels-options [data-megapixels="max"]');
    const jpegMpTopText = await hiResPage.textContent('#megapixels-options [data-megapixels="max"]');
    assert.ok(jpegMpTopText.includes('17.3 MP') && !jpegMpTopText.includes('AVIF上限'), `Expected unlocked 17.3 MP in JPEG, got ${jpegMpTopText}`);
    await hiResPage.click('#btn-info-close');

    const jpegMaxDlPromise = hiResPage.waitForEvent('download', { timeout: 20000 });
    await hiResPage.click('#btn-shutter');
    const jpegMaxDl = await jpegMaxDlPromise;
    assert.ok(jpegMaxDl.suggestedFilename().includes('_HDR.jpg'));
    await hiResPage.waitForFunction(() => window.__QCAM__.photos.length === 2 && !window.__QCAM__.isCapturing, { timeout: 20000 });
    const jpegMaxPhoto = await hiResPage.evaluate(() => {
      const p = window.__QCAM__.photos[0];
      return {
        width: p.width,
        height: p.height,
        mode: p.mode,
        format: p.format,
        source: window.__QCAM__.lastCaptureSource,
      };
    });
    assert.equal(jpegMaxPhoto.width, 4800);
    assert.equal(jpegMaxPhoto.height, 3600);
    assert.equal(jpegMaxPhoto.mode, 'hq');
    assert.equal(jpegMaxPhoto.format, 'jpeg');
    assert.equal(jpegMaxPhoto.source, 'takePhoto');

    if (screenshotDir) {
      await hiResPage.click('#btn-info');
      await hiResPage.waitForSelector('#info-modal:not([hidden])');
      assert.equal(await hiResPage.locator('#ios-sensor-note').isVisible(), false);
      await hiResPage.screenshot({ path: path.join(screenshotDir, 'e2e_hires_settings.png') });
      await hiResPage.click('#btn-info-close');
    } else {
      await hiResPage.click('#btn-info');
      await hiResPage.waitForSelector('#info-modal:not([hidden])');
      assert.equal(await hiResPage.locator('#ios-sensor-note').isVisible(), false);
      await hiResPage.click('#btn-info-close');
    }
    await hiResContext.close();

    // 23. iPhone 17 (iOS 26 / 48MP hardware + ImageCapture API present):
    // verifies 4:3 (12.2MP) vs 16:9 (9.1MP) crop UX, clear 48MP silent-stream explanation,
    // no misleading "センサー上限" copy, and strict zero-takePhoto silence guarantee.
    console.log('[e2e] checking iPhone 17 48MP vs 9.1MP/12.2MP settings UX & silent burst invariant');
    const ios17Context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
      permissions: ['camera'],
    });
    const ios17Page = await ios17Context.newPage();
    ios17Page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[ios17] ${msg.text()}`);
    });
    ios17Page.on('pageerror', (err) => {
      pageErrors.push(`[ios17] ${err.message}`);
    });
    await ios17Page.addInitScript(() => {
      window.__IOS17_TAKEPHOTO_CALLS__ = 0;
      window.__IOS17_SHARE_CALLS__ = [];
      navigator.canShare = (d) => Array.isArray(d?.files) && d.files.length === 1;
      navigator.share = async (d) => {
        window.__IOS17_SHARE_CALLS__.push({
          fileName: d?.files?.[0]?.name || '',
          fileType: d?.files?.[0]?.type || '',
        });
      };

      // Safari 18.4+ / iOS 26 exposes ImageCapture; Qcam MUST NOT call takePhoto() on iOS to preserve shutter silence
      window.ImageCapture = class MockSafariImageCapture {
        constructor(track) {
          this.track = track;
        }
        async getPhotoCapabilities() {
          return {
            imageWidth: { min: 640, max: 4032, step: 2 },
            imageHeight: { min: 480, max: 3024, step: 2 },
          };
        }
        async takePhoto() {
          window.__IOS17_TAKEPHOTO_CALLS__ += 1;
          throw new Error('takePhoto must never be invoked on iOS');
        }
      };

      navigator.mediaDevices.enumerateDevices = async () => [
        { kind: 'videoinput', deviceId: 'ios17-back', groupId: 'b', label: '背面カメラ', toJSON() { return this; } },
        { kind: 'videoinput', deviceId: 'ios17-uw', groupId: 'b', label: '背面超広角カメラ', toJSON() { return this; } },
      ];
      navigator.mediaDevices.getUserMedia = async () => {
        const w = 4032;
        const h = 3024;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        const paint = () => {
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(240, 240, 800, 600);
        };
        paint();
        const stream = canvas.captureStream(2);
        const track = stream.getVideoTracks()[0];
        Object.defineProperty(track, 'label', { configurable: true, get: () => '背面カメラ' });
        track.getSettings = () => ({
          deviceId: 'ios17-back',
          facingMode: 'environment',
          width: w,
          height: h,
          frameRate: 30,
        });
        track.getCapabilities = () => ({
          facingMode: ['environment'],
          width: { min: 320, max: w },
          height: { min: 240, max: h },
        });
        return stream;
      };
    });

    await ios17Page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await ios17Page.waitForFunction(
      () => window.__QCAM__?.streamInfo?.videoWidth === 4032 && window.__QCAM__?.streamInfo?.videoHeight === 3024,
      null,
      { timeout: 10000 }
    );
    assert.equal(await ios17Page.evaluate(() => window.__QCAM__.camera.stream.getAudioTracks().length), 0);

    // Check 4:3 -> 12.2 MP in settings
    await ios17Page.click('#btn-info');
    await ios17Page.waitForSelector('#info-modal:not([hidden])');
    const resNote43 = await ios17Page.textContent('#resolution-setting-note');
    const mpNote43 = await ios17Page.textContent('#megapixels-setting-note');
    assert.ok(resNote43.includes('ブラウザ取得上限 4032×3024'), `Unexpected resolution note: ${resNote43}`);
    assert.ok(!resNote43.includes('センサー上限'), `Misleading sensor max label still present: ${resNote43}`);
    assert.ok(mpNote43.includes('4032×3024') && mpNote43.includes('12.2 MP'), `Expected 12.2 MP in 4:3, got ${mpNote43}`);
    assert.ok(!mpNote43.includes('16:9切抜中'), `Unexpected crop note in 4:3: ${mpNote43}`);
    assert.equal(await ios17Page.locator('#ios-sensor-note').isVisible(), true);
    const ios17NoteText = await ios17Page.textContent('#ios-sensor-note');
    assert.ok(
      ios17NoteText.includes('48MP') && ios17NoteText.includes('無音') && ios17NoteText.includes('takePhoto'),
      `Missing 48MP silent note copy: ${ios17NoteText}`
    );
    await ios17Page.click('#btn-info-close');

    // Toggle 16:9 -> Settings explains 9.1 MP crop & 4:3 gives 12.2 MP
    await ios17Page.click('#btn-aspect');
    await ios17Page.waitForTimeout(80);
    await ios17Page.click('#btn-info');
    await ios17Page.waitForSelector('#info-modal:not([hidden])');
    const mpNote169 = await ios17Page.textContent('#megapixels-setting-note');
    const ios17DiagText = await ios17Page.textContent('#diagnostics-list');
    assert.ok(mpNote169.includes('4032×2268') && mpNote169.includes('9.1 MP'), `Expected 9.1 MP in 16:9, got ${mpNote169}`);
    assert.ok(mpNote169.includes('16:9切抜中（4:3切替で最大 12.2 MP 可）'), `Missing 4:3 unlock hint: ${mpNote169}`);
    assert.ok(ios17DiagText.includes('ブラウザ取得上限 4032×3024'), `Missing browser cap in diagnostics: ${ios17DiagText}`);
    assert.ok(ios17DiagText.includes('静止画 API (takePhoto)') && ios17DiagText.includes('無音維持のため無効'));
    const sheetLayout = await ios17Page.evaluate(() => {
      const card = document.querySelector('.sheet-card');
      const note = document.getElementById('ios-sensor-note');
      return {
        scrollW: card.scrollWidth,
        clientW: card.clientWidth,
        noteRight: note.getBoundingClientRect().right,
        cardRight: card.getBoundingClientRect().right,
      };
    });
    assert.ok(
      sheetLayout.scrollW <= sheetLayout.clientW + 1 && sheetLayout.noteRight <= sheetLayout.cardRight + 1,
      `iOS 17 settings sheet overflowed: ${JSON.stringify(sheetLayout)}`
    );
    if (screenshotDir) {
      await ios17Page.screenshot({ path: path.join(screenshotDir, 'e2e_ios17_settings.png') });
    }
    await ios17Page.click('#btn-info-close');

    // Capture 9.1 MP 16:9 photo and verify takePhoto() was NEVER called even when ImageCapture existed
    await ios17Page.click('#btn-shutter');
    await ios17Page.waitForFunction(
      () => window.__QCAM__.photos.length === 1 && !window.__QCAM__.isCapturing,
      null,
      { timeout: 25000 }
    );
    const ios17Photo = await ios17Page.evaluate(() => ({
      width: window.__QCAM__.photos[0].width,
      height: window.__QCAM__.photos[0].height,
      format: window.__QCAM__.photos[0].format,
      source: window.__QCAM__.lastCaptureSource,
      takePhotoCalls: window.__IOS17_TAKEPHOTO_CALLS__,
      shareCalls: window.__IOS17_SHARE_CALLS__.length,
    }));
    assert.equal(ios17Photo.takePhotoCalls, 0, 'Qcam must never invoke takePhoto() on iOS');
    assert.equal(ios17Photo.source, 'burstStream');
    assert.equal(ios17Photo.format, 'avif');
    assert.equal(ios17Photo.width, 4032);
    assert.equal(ios17Photo.height, 2268);
    assert.equal(ios17Photo.shareCalls, 1);
    await ios17Context.close();

    // 24. Shaky Burst Image Stabilization E2E Test:
    // Verifies blurry frame 0 rejection, sharp ref switch, rotational+translational registration,
    // double-edge ghost elimination, live shaky stream shutter capture, and shake warning HUD bounds.
    console.log('[e2e] checking shaky burst stabilization, ghost-free sharpness & HUD placement');
    const stabContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      acceptDownloads: true,
      userAgent:
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
      permissions: ['camera'],
    });
    const stabPage = await stabContext.newPage();
    stabPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[stab] ${msg.text()}`);
    });
    stabPage.on('pageerror', (err) => {
      pageErrors.push(`[stab] ${err.message}`);
    });
    await stabPage.addInitScript(() => {
      const poses = [
        [0, 0, 0],
        [15, -10, 1.2],
        [-13, 9, -0.9],
        [7, 5, 0.4],
      ];
      navigator.mediaDevices.enumerateDevices = async () => [
        {
          kind: 'videoinput',
          deviceId: 'stab-cam-0',
          groupId: 'g-stab',
          label: 'camera2 0, facing back',
          toJSON() { return this; },
        },
      ];
      navigator.mediaDevices.getUserMedia = async () => {
        const w = 960;
        const h = 720;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        let idx = 0;
        const paint = () => {
          const [dx, dy, deg] = poses[idx % poses.length];
          idx += 1;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = '#0f172a';
          ctx.fillRect(0, 0, w, h);
          ctx.save();
          ctx.translate(w * 0.5 + dx, h * 0.5 + dy);
          ctx.rotate((deg * Math.PI) / 180);
          ctx.translate(-w * 0.5, -h * 0.5);
          ctx.fillStyle = '#e2e8f0';
          for (let x = 180; x < 780; x += 16) {
            ctx.fillRect(x, 150, 8, 220);
          }
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 6;
          ctx.strokeRect(200, 410, 560, 170);
          ctx.fillStyle = '#fbbf24';
          ctx.beginPath();
          ctx.arc(480, 495, 58, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        };
        paint();
        const iv = setInterval(paint, 45);
        const stream = canvas.captureStream(24);
        const track = stream.getVideoTracks()[0];
        const origStop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(iv);
          return origStop();
        };
        track.getSettings = () => ({
          deviceId: 'stab-cam-0',
          facingMode: 'environment',
          width: w,
          height: h,
          frameRate: 24,
        });
        track.getCapabilities = () => ({
          facingMode: ['environment'],
          width: { min: 320, max: w },
          height: { min: 240, max: h },
        });
        return stream;
      };
    });

    await stabPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await stabPage.waitForFunction(() => {
      const v = document.getElementById('camera-video');
      return Boolean(window.__QCAM__?.streamInfo && v && v.videoWidth > 0 && v.videoHeight > 0);
    }, { timeout: 6000 });

    // Part A: Deterministic shaky + blurry 5-frame burst comparison (EIS 'high' vs 'off')
    const stabCompare = await stabPage.evaluate(async () => {
      const drawChart = (ctx, w, h, dx, dy, angleDeg) => {
        ctx.fillStyle = '#141a24';
        ctx.fillRect(0, 0, w, h);
        ctx.save();
        ctx.translate(w * 0.5 + dx, h * 0.5 + dy);
        ctx.rotate((angleDeg * Math.PI) / 180);
        ctx.translate(-w * 0.5, -h * 0.5);

        // Background texture grid across full FOV for multi-anchor tracking
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 2;
        for (let gx = 40; gx < w; gx += 48) {
          ctx.beginPath();
          ctx.moveTo(gx, 24);
          ctx.lineTo(gx, h - 24);
          ctx.stroke();
        }
        for (let gy = 32; gy < h; gy += 48) {
          ctx.beginPath();
          ctx.moveTo(24, gy);
          ctx.lineTo(w - 24, gy);
          ctx.stroke();
        }

        // High-contrast vertical resolution bars in center ROI
        for (let bx = 180; bx < 460; bx += 8) {
          ctx.fillStyle = ((bx - 180) / 8) % 2 === 0 ? '#f8fafc' : '#090d14';
          ctx.fillRect(bx, 130, 8, 120);
        }

        // High-contrast crosshair & circle in lower center ROI
        ctx.strokeStyle = '#f8fafc';
        ctx.lineWidth = 4;
        ctx.strokeRect(180, 270, 280, 96);
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(320, 318, 32, 0, Math.PI * 2);
        ctx.fill();

        // Corner fiducial squares to drive strong rotational constraint
        ctx.fillStyle = '#e2e8f0';
        ctx.fillRect(54, 46, 34, 34);
        ctx.fillRect(w - 88, 46, 34, 34);
        ctx.fillRect(54, h - 80, 34, 34);
        ctx.fillRect(w - 88, h - 80, 34, 34);

        ctx.restore();
      };

      const makeCanvas = (dx, dy, angleDeg, blurred = false) => {
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 480;
        const ctx = c.getContext('2d');
        if (!blurred) {
          drawChart(ctx, 640, 480, dx, dy, angleDeg);
        } else {
          // Simulate genuine handheld directional motion blur across the 8px bar pitch (~16px travel)
          const sharpC = document.createElement('canvas');
          sharpC.width = 640;
          sharpC.height = 480;
          drawChart(sharpC.getContext('2d'), 640, 480, dx, dy, angleDeg);
          ctx.fillStyle = '#141a24';
          ctx.fillRect(0, 0, 640, 480);
          const taps = 9;
          for (let t = 0; t < taps; t++) {
            const frac = (t / (taps - 1)) - 0.5;
            ctx.globalAlpha = 1 / (t + 1);
            ctx.drawImage(sharpC, frac * 14, frac * 6);
          }
          ctx.globalAlpha = 1;
        }
        return c;
      };

      const specs = [
        [8, -6, 0.6, true],     // Frame 0: tap-shaken & blurred
        [18, -12, 1.4, false],  // Frame 1: crisp + shifted + rotated
        [0, 0, 0, false],       // Frame 2: crisp centered reference
        [-15, 11, -1.1, false], // Frame 3: crisp + opposite shift + rotation
        [9, 7, 0.4, false],     // Frame 4: crisp slight offset
      ];
      const canvases = specs.map(([dx, dy, deg, blur]) => makeCanvas(dx, dy, deg, blur));

      const highFrames = await Promise.all(canvases.map((c) => createImageBitmap(c)));
      const offFrames = await Promise.all(canvases.map((c) => createImageBitmap(c)));

      const highRes = await window.__QCAM__.pipeline.process({
        mode: 'hq',
        frames: highFrames,
        aspectRatio: '4:3',
        softwareZoom: 1,
        outputFormat: 'avif',
        stabilizationMode: 'high',
      });
      const offRes = await window.__QCAM__.pipeline.process({
        mode: 'hq',
        frames: offFrames,
        aspectRatio: '4:3',
        softwareZoom: 1,
        outputFormat: 'avif',
        stabilizationMode: 'off',
      });

      const measureBlobSharpness = async (blob) => {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        // Sample cleanly inside the vertical resolution bars ROI
        const x0 = Math.round(bmp.width * 0.34);
        const y0 = Math.round(bmp.height * 0.31);
        const rw = Math.round(bmp.width * 0.32);
        const rh = Math.round(bmp.height * 0.17);
        const data = ctx.getImageData(x0, y0, rw, rh).data;
        let gradSum = 0;
        let lumaSum = 0;
        let lumaSqSum = 0;
        let samples = 0;
        const lumaAt = (px, py) => {
          const idx = (py * rw + px) * 4;
          return 0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2];
        };
        for (let y = 1; y < rh - 1; y++) {
          for (let x = 1; x < rw - 1; x++) {
            const cL = lumaAt(x, y);
            const gx = lumaAt(x + 1, y) - lumaAt(x - 1, y);
            const gy = lumaAt(x, y + 1) - lumaAt(x, y - 1);
            gradSum += gx * gx + gy * gy;
            lumaSum += cL;
            lumaSqSum += cL * cL;
            samples++;
          }
        }
        bmp.close();
        const meanL = lumaSum / Math.max(1, samples);
        const rmsContrast = Math.sqrt(Math.max(0, lumaSqSum / Math.max(1, samples) - meanL * meanL));
        return {
          width: c.width,
          height: c.height,
          edgeEnergy: Math.sqrt(gradSum / Math.max(1, samples)),
          rmsContrast,
        };
      };

      const highMetrics = await measureBlobSharpness(highRes.blob);
      const offMetrics = await measureBlobSharpness(offRes.blob);

      return {
        stabInfo: highRes.stabilizationInfo,
        highMetrics,
        offMetrics,
      };
    });

    assert.equal(stabCompare.stabInfo.mode, 'high');
    assert.ok(stabCompare.stabInfo.refIndex >= 1, `Should switch away from blurred frame 0, got refIndex=${stabCompare.stabInfo.refIndex}`);
    assert.ok(stabCompare.stabInfo.adoptedFrames >= 3 && stabCompare.stabInfo.adoptedFrames <= 4, `Unexpected adoptedFrames: ${JSON.stringify(stabCompare.stabInfo)}`);
    assert.ok(stabCompare.stabInfo.maxShiftPx >= 12, `Expected >=12px shift compensation, got ${stabCompare.stabInfo.maxShiftPx}`);
    assert.ok(stabCompare.stabInfo.maxAngleDeg >= 0.7, `Expected >=0.7deg rotational compensation, got ${stabCompare.stabInfo.maxAngleDeg}`);
    assert.ok(
      stabCompare.highMetrics.edgeEnergy > stabCompare.offMetrics.edgeEnergy * 1.25,
      `Expected stabilized edge sharpness >> off edge sharpness, got high=${stabCompare.highMetrics.edgeEnergy.toFixed(2)} vs off=${stabCompare.offMetrics.edgeEnergy.toFixed(2)}`
    );
    assert.ok(
      stabCompare.highMetrics.rmsContrast > stabCompare.offMetrics.rmsContrast * 1.25,
      `Expected crisper bar RMS contrast in stabilized output, got high=${stabCompare.highMetrics.rmsContrast.toFixed(1)} vs off=${stabCompare.offMetrics.rmsContrast.toFixed(1)}`
    );

    // Part B: Full live shaky camera capture + diagnostics check
    const liveStabDlPromise = stabPage.waitForEvent('download', { timeout: 12000 });
    await stabPage.click('#btn-shutter');
    const liveStabDl = await liveStabDlPromise;
    assert.ok(liveStabDl.suggestedFilename().includes('_HDR.avif'));
    await stabPage.waitForFunction(() => window.__QCAM__.photos.length === 1 && !window.__QCAM__.isCapturing);
    const liveStabInfo = await stabPage.evaluate(() => window.__QCAM__.lastStabilizationInfo);
    assert.ok(liveStabInfo && liveStabInfo.mode === 'high' && liveStabInfo.adoptedFrames >= 2);

    await stabPage.click('#btn-info');
    await stabPage.waitForSelector('#info-modal:not([hidden])');
    const stabDiagText = await stabPage.textContent('#diagnostics-list');
    assert.ok(stabDiagText.includes('手ぶれ補正モード') && stabDiagText.includes('高品質 (強'));
    assert.ok(stabDiagText.includes('直近のブレ補正') && stabDiagText.includes('採用') && stabDiagText.includes('シフト補正'));
    await stabPage.click('#btn-info-close');

    await stabContext.close();

    // 25. Pro ISP 2.0 Computational Photography E2E Test:
    // Verifies 5-pass linear HDR pipeline: low-light 4-frame denoising with sharp edge preservation,
    // halo-free backlit Local HDR + AgX highlight rolloff, smooth gradient ramp, 3-Look tone/color differentiation,
    // and RGBA8 packed HDR shader fallback (`forcePackedHdr: true`).
    console.log('[e2e] checking Pro ISP 2.0 linear HDR, burst denoise, Look profiles & packed HDR fallback');
    const proIspContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      permissions: ['camera'],
    });
    const proIspPage = await proIspContext.newPage();
    proIspPage.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(`[pro-isp] ${msg.text()}`);
    });
    proIspPage.on('pageerror', (err) => {
      pageErrors.push(`[pro-isp] ${err.message}`);
    });
    await proIspPage.addInitScript(() => {
      navigator.mediaDevices.enumerateDevices = async () => [
        {
          kind: 'videoinput',
          deviceId: 'pro-isp-cam',
          groupId: 'g-pro',
          label: 'Pro Camera',
          toJSON() { return this; },
        },
      ];
      navigator.mediaDevices.getUserMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 240;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#1f2937';
        ctx.fillRect(0, 0, 320, 240);
        const stream = c.captureStream(5);
        const track = stream.getVideoTracks()[0];
        track.getSettings = () => ({ deviceId: 'pro-isp-cam', facingMode: 'environment', width: 320, height: 240 });
        track.getCapabilities = () => ({ facingMode: ['environment'], width: { min: 320, max: 320 }, height: { min: 240, max: 240 } });
        return stream;
      };
    });
    await proIspPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await proIspPage.waitForFunction(() => Boolean(window.__QCAM__?.pipeline), { timeout: 6000 });

    const proIspResult = await proIspPage.evaluate(async ({ wantVisuals }) => {
      const { WebGLImageProcessor } = await import('/src/processing/webgl-processor.js');
      const { analyzeRgbaScene, computeProDevelopProfile } = await import('/src/processing/frame-aligner.js');

      const decodeBlobToImageData = async (blob) => {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        return { canvas: c, imageData: ctx.getImageData(0, 0, c.width, c.height) };
      };

      const measureRegionStats = (imgData, x0, y0, x1, y1) => {
        const { width, data } = imgData;
        let sumL = 0;
        let sumL2 = 0;
        let sumChroma = 0;
        let sumR = 0;
        let sumG = 0;
        let sumB = 0;
        let minL = 255;
        let maxL = 0;
        let n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const p = (y * width + x) * 4;
            const r = data[p];
            const g = data[p + 1];
            const b = data[p + 2];
            const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            sumL += l;
            sumL2 += l * l;
            sumR += r;
            sumG += g;
            sumB += b;
            sumChroma += Math.max(r, g, b) - Math.min(r, g, b);
            if (l < minL) minL = l;
            if (l > maxL) maxL = l;
            n += 1;
          }
        }
        const meanL = sumL / Math.max(1, n);
        const stdL = Math.sqrt(Math.max(0, sumL2 / Math.max(1, n) - meanL * meanL));
        return {
          meanL,
          stdL,
          meanChroma: sumChroma / Math.max(1, n),
          meanRgb: [sumR / Math.max(1, n), sumG / Math.max(1, n), sumB / Math.max(1, n)],
          minL,
          maxL,
        };
      };

      // (a) Low-light noisy 4-frame burst + crisp architectural bar
      const w = 320;
      const h = 240;
      const noisyCanvases = [];
      for (let f = 0; f < 4; f++) {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        const d = img.data;
        let seed = 0x2468ace0 + f * 7919;
        const nextRand = () => {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          return seed / 4294967296;
        };
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const p = (y * w + x) * 4;
            const inBar = x >= 150 && x < 180 && y >= 40 && y < 200;
            const baseR = inBar ? 228 : 40;
            const baseG = inBar ? 222 : 42;
            const baseB = inBar ? 208 : 48;
            const nR = Math.round((nextRand() + nextRand() - 1) * 28);
            const nG = Math.round((nextRand() + nextRand() - 1) * 28);
            const nB = Math.round((nextRand() + nextRand() - 1) * 28);
            d[p] = Math.max(0, Math.min(255, baseR + nR));
            d[p + 1] = Math.max(0, Math.min(255, baseG + nG));
            d[p + 2] = Math.max(0, Math.min(255, baseB + nB));
            d[p + 3] = 255;
          }
        }
        ctx.putImageData(img, 0, 0);
        noisyCanvases.push(c);
      }
      const rawFrame0Data = noisyCanvases[0].getContext('2d').getImageData(0, 0, w, h);
      const rawFlatStats = measureRegionStats(rawFrame0Data, 24, 48, 120, 192);
      const noisyBmps = await Promise.all(noisyCanvases.map((c) => createImageBitmap(c)));
      const denoiseRes = await window.__QCAM__.pipeline.process({
        mode: 'hq',
        frames: noisyBmps,
        aspectRatio: '4:3',
        softwareZoom: 1,
        outputFormat: 'avif',
        stabilizationMode: 'high',
        colorProfile: 'natural',
      });
      const denoisedDecoded = await decodeBlobToImageData(denoiseRes.blob);
      const denoisedFlatStats = measureRegionStats(denoisedDecoded.imageData, 24, 48, 120, 192);
      // Measure edge sharpness across x=150 vertical boundary inside the denoised image
      let maxEdgeGrad = 0;
      for (let y = 70; y < 170; y++) {
        for (let x = 146; x <= 154; x++) {
          const idxL = (y * w + (x - 1)) * 4;
          const idxR = (y * w + (x + 1)) * 4;
          const gL = 0.2126 * denoisedDecoded.imageData.data[idxL] + 0.7152 * denoisedDecoded.imageData.data[idxL + 1] + 0.0722 * denoisedDecoded.imageData.data[idxL + 2];
          const gR = 0.2126 * denoisedDecoded.imageData.data[idxR] + 0.7152 * denoisedDecoded.imageData.data[idxR + 1] + 0.0722 * denoisedDecoded.imageData.data[idxR + 2];
          maxEdgeGrad = Math.max(maxEdgeGrad, Math.abs(gR - gL));
        }
      }

      // (b) Halo-free high-DR backlit chart + AgX highlights + vibrant red + skin patch
      const makeBacklitCanvas = () => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        const skyGrad = ctx.createLinearGradient(0, 0, 0, 100);
        skyGrad.addColorStop(0, 'rgb(255, 245, 212)');
        skyGrad.addColorStop(1, 'rgb(220, 232, 248)');
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, w, 100);

        ctx.fillStyle = 'rgb(24, 26, 30)';
        ctx.fillRect(0, 100, w, h - 100);

        // Dark architectural grid inside shadow building
        ctx.strokeStyle = 'rgb(42, 46, 54)';
        ctx.lineWidth = 2;
        for (let gx = 110; gx <= 198; gx += 18) {
          ctx.beginPath();
          ctx.moveTo(gx, 118);
          ctx.lineTo(gx, 224);
          ctx.stroke();
        }

        // Saturated primary red flower patch & warm skin tone reference square
        ctx.fillStyle = 'rgb(232, 30, 28)';
        ctx.fillRect(28, 132, 68, 68);
        ctx.fillStyle = 'rgb(220, 165, 130)';
        ctx.fillRect(220, 132, 68, 68);
        return c;
      };
      const backlitRawCanvas = makeBacklitCanvas();

      const processBacklitWithLook = async (look) => {
        const bmps = await Promise.all([
          createImageBitmap(backlitRawCanvas),
          createImageBitmap(backlitRawCanvas),
        ]);
        const res = await window.__QCAM__.pipeline.process({
          mode: 'hq',
          frames: bmps,
          aspectRatio: '4:3',
          softwareZoom: 1,
          outputFormat: 'avif',
          stabilizationMode: 'off',
          colorProfile: look,
        });
        return decodeBlobToImageData(res.blob);
      };

      const lookNat = await processBacklitWithLook('natural');
      const lookViv = await processBacklitWithLook('vivid');
      const lookFilm = await processBacklitWithLook('film');

      const shadowBorder = measureRegionStats(lookNat.imageData, 115, 105, 195, 112);
      const shadowInterior = measureRegionStats(lookNat.imageData, 115, 156, 195, 200);
      const skyTop = measureRegionStats(lookNat.imageData, 40, 8, 280, 22);
      const skyLower = measureRegionStats(lookNat.imageData, 40, 76, 280, 90);
      const redPatchNat = measureRegionStats(lookNat.imageData, 40, 144, 84, 184);
      const fullNat = measureRegionStats(lookNat.imageData, 20, 120, 300, 210);
      const fullViv = measureRegionStats(lookViv.imageData, 20, 120, 300, 210);
      const shadowFilm = measureRegionStats(lookFilm.imageData, 115, 156, 195, 200);

      // (c) Smooth gradient ramp continuity test (dark-to-mid tonal ramp at matching 4:3 aspect)
      const rampCanvas = document.createElement('canvas');
      rampCanvas.width = 256;
      rampCanvas.height = 192;
      const rctx = rampCanvas.getContext('2d');
      const rimg = rctx.createImageData(256, 192);
      for (let y = 0; y < 192; y++) {
        for (let x = 0; x < 256; x++) {
          const val = Math.round(16 + (x / 255) * 208);
          const p = (y * 256 + x) * 4;
          rimg.data[p] = val;
          rimg.data[p + 1] = val;
          rimg.data[p + 2] = val;
          rimg.data[p + 3] = 255;
        }
      }
      rctx.putImageData(rimg, 0, 0);
      const rampBmp = await createImageBitmap(rampCanvas);
      const rampRes = await window.__QCAM__.pipeline.process({
        mode: 'hq',
        frames: [rampBmp],
        aspectRatio: '4:3',
        softwareZoom: 1,
        outputFormat: 'avif',
        stabilizationMode: 'off',
        colorProfile: 'natural',
      });
      const rampDecoded = await decodeBlobToImageData(rampRes.blob);
      const rampW = rampDecoded.imageData.width;
      const rampH = rampDecoded.imageData.height;
      let maxRampJump = 0;
      let monotonicViolations = 0;
      let prevColL = -1;
      for (let x = 16; x <= rampW - 24; x += 8) {
        const st = measureRegionStats(rampDecoded.imageData, x, 32, x + 4, rampH - 32);
        if (prevColL >= 0) {
          const diff = st.meanL - prevColL;
          if (diff < -1.5) monotonicViolations += 1;
          maxRampJump = Math.max(maxRampJump, Math.abs(diff));
        }
        prevColL = st.meanL;
      }

      // (d) Forced RGBA8 packed HDR shader path (`forcePackedHdr: true`)
      const glCanvas = document.createElement('canvas');
      const packedProc = new WebGLImageProcessor(glCanvas, { forcePackedHdr: true });
      const rawBacklitData = backlitRawCanvas.getContext('2d').getImageData(0, 0, w, h);
      const sceneStats = analyzeRgbaScene(rawBacklitData.data, w, h);
      const packedDevProfile = computeProDevelopProfile(sceneStats, {
        frameCount: 1,
        colorProfile: 'natural',
      });
      packedProc.processHQ([backlitRawCanvas], {
        outWidth: w,
        outHeight: h,
        cropNorm: { x: 0, y: 0, w: 1, h: 1 },
        developProfile: packedDevProfile,
      });
      const packedRead = packedProc.readRgbaTopDown();
      const packedImgData = new ImageData(new Uint8ClampedArray(packedRead.data), packedRead.width, packedRead.height);
      const packedSky = measureRegionStats(packedImgData, 40, 12, 280, 32);
      const packedShadow = measureRegionStats(packedImgData, 115, 156, 195, 200);
      const packedRed = measureRegionStats(packedImgData, 40, 144, 84, 184);
      const usingPackedHdr = packedProc.usingPackedHdr;
      packedProc.dispose();

      // Optional side-by-side PNG visual sheets for visual inspection
      let looksDataUrl = null;
      let denoiseDataUrl = null;
      if (wantVisuals) {
        const panelGap = 12;
        const headerH = 26;
        const sheetW = w * 4 + panelGap * 5;
        const sheetH = h + headerH + 16;
        const sheet = document.createElement('canvas');
        sheet.width = sheetW;
        sheet.height = sheetH;
        const sctx = sheet.getContext('2d');
        sctx.fillStyle = '#0f172a';
        sctx.fillRect(0, 0, sheetW, sheetH);
        sctx.font = 'bold 14px sans-serif';
        const panels = [
          ['Raw Backlit Input', backlitRawCanvas],
          ['Pro Natural', lookNat.canvas],
          ['Pro Vivid', lookViv.canvas],
          ['Pro Film', lookFilm.canvas],
        ];
        panels.forEach(([title, srcCanvas], idx) => {
          const px = panelGap + idx * (w + panelGap);
          sctx.fillStyle = '#e2e8f0';
          sctx.fillText(title, px, 18);
          sctx.drawImage(srcCanvas, px, headerH, w, h);
        });
        looksDataUrl = sheet.toDataURL('image/png');

        const dSheetW = w * 2 + panelGap * 3;
        const dSheet = document.createElement('canvas');
        dSheet.width = dSheetW;
        dSheet.height = sheetH;
        const dctx = dSheet.getContext('2d');
        dctx.fillStyle = '#0f172a';
        dctx.fillRect(0, 0, dSheetW, sheetH);
        dctx.font = 'bold 14px sans-serif';
        [
          [`Raw Noisy Frame 0 (std=${rawFlatStats.stdL.toFixed(1)})`, noisyCanvases[0]],
          [`Pro ISP 4-Frame Burst (std=${denoisedFlatStats.stdL.toFixed(1)})`, denoisedDecoded.canvas],
        ].forEach(([title, srcCanvas], idx) => {
          const px = panelGap + idx * (w + panelGap);
          dctx.fillStyle = '#e2e8f0';
          dctx.fillText(title, px, 18);
          dctx.drawImage(srcCanvas, px, headerH, w, h);
        });
        denoiseDataUrl = dSheet.toDataURL('image/png');
      }

      return {
        rawFlatStd: Number(rawFlatStats.stdL.toFixed(2)),
        denoisedFlatStd: Number(denoisedFlatStats.stdL.toFixed(2)),
        maxEdgeGrad: Number(maxEdgeGrad.toFixed(1)),
        shadowBorderL: Number(shadowBorder.meanL.toFixed(1)),
        shadowInteriorL: Number(shadowInterior.meanL.toFixed(1)),
        skyTopL: Number(skyTop.meanL.toFixed(1)),
        skyLowerL: Number(skyLower.meanL.toFixed(1)),
        redPatchRgb: redPatchNat.meanRgb.map((v) => Math.round(v)),
        natChroma: Number(fullNat.meanChroma.toFixed(2)),
        vivChroma: Number(fullViv.meanChroma.toFixed(2)),
        natShadowL: Number(shadowInterior.meanL.toFixed(2)),
        filmShadowL: Number(shadowFilm.meanL.toFixed(2)),
        maxRampJump: Number(maxRampJump.toFixed(2)),
        monotonicViolations,
        usingPackedHdr,
        packedSkyL: Number(packedSky.meanL.toFixed(1)),
        packedShadowL: Number(packedShadow.meanL.toFixed(1)),
        packedRedRgb: packedRed.meanRgb.map((v) => Math.round(v)),
        looksDataUrl,
        denoiseDataUrl,
      };
    }, { wantVisuals: Boolean(screenshotDir) });

    if (screenshotDir && proIspResult.looksDataUrl && proIspResult.denoiseDataUrl) {
      const writeDataUrlPng = async (dataUrl, fileName) => {
        const base64 = dataUrl.split(',')[1];
        await fs.writeFile(path.join(screenshotDir, fileName), Buffer.from(base64, 'base64'));
      };
      await writeDataUrlPng(proIspResult.looksDataUrl, 'pro_isp_looks.png');
      await writeDataUrlPng(proIspResult.denoiseDataUrl, 'pro_isp_denoise.png');
    }

    assert.ok(
      proIspResult.denoisedFlatStd < proIspResult.rawFlatStd * 0.55,
      `Expected >45% low-light noise reduction, got raw=${proIspResult.rawFlatStd} -> denoised=${proIspResult.denoisedFlatStd}`
    );
    assert.ok(
      proIspResult.maxEdgeGrad > 60,
      `Expected sharp vertical edge preserved after denoising, got grad=${proIspResult.maxEdgeGrad}`
    );
    assert.ok(
      proIspResult.shadowInteriorL > 30,
      `Backlit shadow building should be lifted (>30), got ${proIspResult.shadowInteriorL}`
    );
    assert.ok(
      Math.abs(proIspResult.shadowBorderL - proIspResult.shadowInteriorL) < 10,
      `Expected halo-free border vs interior shadow: border=${proIspResult.shadowBorderL}, interior=${proIspResult.shadowInteriorL}`
    );
    assert.ok(
      proIspResult.skyTopL > proIspResult.skyLowerL && proIspResult.skyLowerL < 252,
      `AgX highlight shoulder should preserve sky gradient modulation: top=${proIspResult.skyTopL}, lower=${proIspResult.skyLowerL}`
    );
    assert.ok(
      proIspResult.redPatchRgb[0] > 180 && proIspResult.redPatchRgb[1] < 75 && proIspResult.redPatchRgb[2] < 75,
      `Pure red color accuracy check failed: ${proIspResult.redPatchRgb}`
    );
    assert.equal(proIspResult.monotonicViolations, 0, 'Smooth ramp should remain monotonic');
    assert.ok(proIspResult.maxRampJump < 14, `Ramp step too steep/banding: ${proIspResult.maxRampJump}`);
    assert.ok(
      proIspResult.vivChroma > proIspResult.natChroma + 2,
      `Vivid look should boost chroma over Natural: viv=${proIspResult.vivChroma}, nat=${proIspResult.natChroma}`
    );
    assert.ok(
      proIspResult.filmShadowL > proIspResult.natShadowL,
      `Film look matte fade should lift shadow black floor over Natural: film=${proIspResult.filmShadowL}, nat=${proIspResult.natShadowL}`
    );
    assert.equal(proIspResult.usingPackedHdr, true);
    assert.ok(proIspResult.packedSkyL > 180 && proIspResult.packedShadowL > 30);
    assert.ok(proIspResult.packedRedRgb[0] > 180 && proIspResult.packedRedRgb[1] < 75);

    await proIspContext.close();

    assert.deepEqual(consoleErrors, [], `Console errors encountered: ${consoleErrors.join('; ')}`);
    assert.deepEqual(pageErrors, [], `Page errors encountered: ${pageErrors.join('; ')}`);

    console.log('E2E PASS:', JSON.stringify({
      startupTimeMs: startupMetrics.startupTimeMs,
      firstHdrPhoto,
      hqPhoto,
      orientationEngine: orientationCheck.engine,
      mainOffloadEngine: orientationCheck.mainEngine,
      compactStats,
      pwa: {
        manifestOk: pwaStatus.manifestOk,
        display: pwaStatus.display,
        iconsCount: pwaStatus.iconsCount,
        swRegistered: pwaStatus.swRegistered,
        precacheAssetCount: pwaStatus.assetStatuses.length,
      },
      iosShareCalls: 3,
      ultraWideHardware05x: true,
      ultraWideDeviceSwitch05x: true,
      hdrResolutionCheck: {
        avif8MpPhoto,
        jpegMaxPhoto,
      },
      ios17Photo,
      stabCompare,
      proIspMetrics: {
        rawFlatStd: proIspResult.rawFlatStd,
        denoisedFlatStd: proIspResult.denoisedFlatStd,
        maxEdgeGrad: proIspResult.maxEdgeGrad,
        shadowBorderL: proIspResult.shadowBorderL,
        shadowInteriorL: proIspResult.shadowInteriorL,
        skyTopL: proIspResult.skyTopL,
        skyLowerL: proIspResult.skyLowerL,
        redPatchRgb: proIspResult.redPatchRgb,
        natChroma: proIspResult.natChroma,
        vivChroma: proIspResult.vivChroma,
        natShadowL: proIspResult.natShadowL,
        filmShadowL: proIspResult.filmShadowL,
        usingPackedHdr: proIspResult.usingPackedHdr,
      },
    }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
