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

async function main() {
  const { server, url } = await startStaticServer();
  const executablePath =
    process.env.CHROME_PATH ||
    (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const screenshotDir = process.env.QCAM_SCREENSHOT_DIR || null;

  console.log('[e2e] launching chromium:', executablePath || 'playwright-bundled');
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    timeout: 30000,
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
      return v && v.videoWidth > 0 && v.videoHeight > 0;
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

    console.log('[e2e] verifying PWA manifest and SW');
    // 2. Verify PWA manifest & Service Worker registration
    const pwaStatus = await page.evaluate(async () => {
      const manifestResp = await fetch('./manifest.webmanifest');
      const manifest = await manifestResp.json();
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
      };
    });
    assert.equal(pwaStatus.manifestOk, true);
    assert.equal(pwaStatus.display, 'standalone');
    assert.ok(pwaStatus.iconsCount >= 3);
    assert.equal(pwaStatus.swRegistered, true);

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
    await page.click('#btn-timer');
    assert.equal(await page.textContent('#timer-label'), '10s');
    await page.click('#btn-timer');
    assert.equal(await page.textContent('#timer-label'), 'OFF');

    // 5. Verify Tap-to-Focus reticle & EV control
    const vfBox = await page.locator('#viewfinder-frame').boundingBox();
    await page.mouse.click(vfBox.x + vfBox.width * 0.45, vfBox.y + vfBox.height * 0.4);
    assert.equal(await page.locator('#focus-reticle').isVisible(), true);
    assert.equal(await page.locator('#ev-slider').isVisible(), true);

    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_viewfinder.png') });
    }

    console.log('[e2e] checking zoom and WebGL orientation');
    // 6. Verify Zoom preset (2x)
    await page.click('.zoom-preset[data-zoom="2"]');
    assert.equal(await page.textContent('#zoom-readout'), '2.0×');
    await page.click('.zoom-preset[data-zoom="1"]');
    assert.equal(await page.textContent('#zoom-readout'), '1.0×');

    // 7. Verify WebGL pixel orientation & mirroring directly inside page context
    const orientationCheck = await page.evaluate(async () => {
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

      const bmp = await createImageBitmap(c);
      const res = await window.__QCAM__.pipeline.process({
        mode: 'standard',
        frames: [bmp],
        aspectRatio: '4:3',
        softwareZoom: 1,
        mirrorX: false,
      });

      const outBmp = await createImageBitmap(res.blob);
      const checkCanvas = document.createElement('canvas');
      checkCanvas.width = outBmp.width;
      checkCanvas.height = outBmp.height;
      const checkCtx = checkCanvas.getContext('2d');
      checkCtx.drawImage(outBmp, 0, 0);
      const sample = (x, y) => Array.from(checkCtx.getImageData(x, y, 1, 1).data);
      const tl = sample(15, 15);
      const tr = sample(105, 15);
      const bl = sample(15, 75);
      outBmp.close();
      return { tl, tr, bl, engine: res.engine, type: res.blob.type };
    });

    assert.equal(orientationCheck.type, 'image/jpeg');
    assert.ok(orientationCheck.tl[0] > 180 && orientationCheck.tl[1] < 80, `Top-left should be red, got ${orientationCheck.tl}`);
    assert.ok(orientationCheck.tr[1] > 180 && orientationCheck.tr[0] < 80, `Top-right should be green, got ${orientationCheck.tr}`);
    assert.ok(orientationCheck.bl[2] > 180 && orientationCheck.bl[0] < 80, `Bottom-left should be blue, got ${orientationCheck.bl}`);

    console.log('[e2e] capturing Standard mode photo');
    // 8. Capture Standard mode photo via shutter click
    const downloadPromise = page.waitForEvent('download', { timeout: 6000 });
    await page.click('#btn-shutter');
    const download = await downloadPromise;
    assert.ok(download.suggestedFilename().startsWith('Qcam_'));
    assert.ok(download.suggestedFilename().endsWith('.jpg'));

    await page.waitForFunction(() => window.__QCAM__.photos.length === 1);
    const stdPhoto = await page.evaluate(() => {
      const p = window.__QCAM__.photos[0];
      return {
        width: p.width,
        height: p.height,
        mode: p.mode,
        size: p.blob.size,
        type: p.blob.type,
        totalTimeMs: p.totalTimeMs,
        engine: p.engine,
      };
    });
    assert.equal(stdPhoto.mode, 'standard');
    assert.equal(stdPhoto.type, 'image/jpeg');
    assert.ok(stdPhoto.size > 3000);
    assert.ok(Math.abs(stdPhoto.width / stdPhoto.height - 4 / 3) < 0.02);

    console.log('[e2e] capturing High Quality HDR burst photo');
    // 9. Switch to High Quality HDR mode & capture 4-frame burst
    await page.click('#mode-hq');
    assert.equal(await page.getAttribute('#mode-hq', 'aria-selected'), 'true');
    const hqDownloadPromise = page.waitForEvent('download', { timeout: 6000 });
    await page.click('#btn-shutter');
    const hqDownload = await hqDownloadPromise;
    assert.ok(hqDownload.suggestedFilename().includes('_HDR.jpg'));

    await page.waitForFunction(() => window.__QCAM__.photos.length === 2);
    const hqPhoto = await page.evaluate(() => {
      const p = window.__QCAM__.photos[0];
      return {
        width: p.width,
        height: p.height,
        mode: p.mode,
        size: p.blob.size,
        type: p.blob.type,
        totalTimeMs: p.totalTimeMs,
        engine: p.engine,
      };
    });
    assert.equal(hqPhoto.mode, 'hq');
    assert.equal(hqPhoto.type, 'image/jpeg');
    assert.ok(hqPhoto.size > 3000);

    console.log('[e2e] checking preview modal, info sheet, photo deletion, and camera switch');
    // 10. Open Photo Preview Modal, test zoom & inspect image, delete one photo, then close
    await page.click('#btn-gallery');
    await page.waitForSelector('#preview-modal:not([hidden])');
    const imgNaturalW = await page.evaluate(() => document.getElementById('preview-image').naturalWidth);
    assert.ok(imgNaturalW > 0, 'Preview modal image must load cleanly');

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

    // 11. Verify HQ tone mapping lifts shadows on synthetic dark input
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
      });
      const bmp = await createImageBitmap(res.blob);
      const outC = document.createElement('canvas');
      outC.width = bmp.width;
      outC.height = bmp.height;
      const octx = outC.getContext('2d');
      octx.drawImage(bmp, 0, 0);
      const px = octx.getImageData(32, 32, 1, 1).data;
      bmp.close();
      return { r: px[0], g: px[1], b: px[2] };
    });
    assert.ok(hdrCheck.r > 34, `HQ tone mapping should lift shadows (>34), got ${hdrCheck.r}`);

    // 12. Verify 3s timer countdown starts and cancels on second shutter press
    await page.click('#btn-timer');
    assert.equal(await page.textContent('#timer-label'), '3s');
    await page.click('#btn-shutter');
    await page.waitForSelector('#countdown-overlay:not([hidden])');
    assert.equal(await page.textContent('#countdown-number'), '3');
    await page.click('#btn-shutter'); // Cancel countdown
    assert.equal(await page.locator('#countdown-overlay').isVisible(), false);
    // Reset timer back to OFF
    await page.click('#btn-timer');
    await page.click('#btn-timer');

    // 13. Open Settings / Info Sheet and verify diagnostics + OS permission guide
    await page.click('#btn-info');
    await page.waitForSelector('#info-modal:not([hidden])');
    const diagText = await page.textContent('#diagnostics-list');
    assert.ok(diagText.includes('WebGL') || diagText.includes('worker') || diagText.includes('canvas'));
    assert.ok(diagText.includes('カメラ権限状態'));
    const guideText = await page.textContent('#permission-guide');
    assert.ok(guideText.includes('iOS Safari') && guideText.includes('Android'));
    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_info_sheet.png') });
    }
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

    // 16. Verify persisted settings (16:9, grid ON, hq mode, user facing) survive page reload cleanly
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForFunction(() => {
      const v = document.getElementById('camera-video');
      return v && v.videoWidth > 0 && v.videoHeight > 0;
    }, { timeout: 6000 });
    assert.equal(await page.textContent('#aspect-label'), '16:9');
    assert.equal(await page.getAttribute('#btn-grid', 'aria-pressed'), 'true');
    assert.equal(await page.getAttribute('#mode-hq', 'aria-selected'), 'true');
    assert.equal(await page.evaluate(() => window.__QCAM__.camera.facingMode), 'user');
    assert.equal(await page.locator('#perm-hint-banner').isVisible(), false);

    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_viewfinder_169.png') });
    }

    // 17. Responsive layout checks across smartphone viewports (360x640 compact Android, 375x667 SE, 844x390 landscape)
    console.log('[e2e] checking multi-smartphone viewports (360x640, 375x667, 844x390)');
    await page.setViewportSize({ width: 360, height: 640 });
    await page.waitForTimeout(140);
    const compactStats = await page.evaluate(() => {
      const topBar = document.querySelector('.top-bar');
      const silentLabel = document.querySelector('.silent-label');
      const btnInfoRect = document.getElementById('btn-info').getBoundingClientRect();
      const shutterRect = document.getElementById('btn-shutter').getBoundingClientRect();
      const vfRect = document.getElementById('viewfinder-frame').getBoundingClientRect();
      return {
        topBarScrollW: topBar.scrollWidth,
        topBarClientW: topBar.clientWidth,
        silentLabelDisplay: getComputedStyle(silentLabel).display,
        btnInfoRight: btnInfoRect.right,
        shutterBottom: shutterRect.bottom,
        shutterTop: shutterRect.top,
        vfWidth: vfRect.width,
        vfHeight: vfRect.height,
      };
    });
    assert.ok(compactStats.topBarScrollW <= compactStats.topBarClientW + 1, `Top bar overflowed on 360px: ${JSON.stringify(compactStats)}`);
    assert.equal(compactStats.silentLabelDisplay, 'none', 'Silent label should collapse on <=375px width');
    assert.ok(compactStats.btnInfoRight <= 360, `btn-info clipped on 360px: ${compactStats.btnInfoRight}`);
    assert.ok(compactStats.shutterBottom <= 640 && compactStats.shutterTop > 0, `Shutter out of bounds: ${JSON.stringify(compactStats)}`);
    assert.ok(compactStats.vfWidth >= 358, `16:9 portrait on 360x640 should use full 360px width, got ${compactStats.vfWidth}`);
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
      const zoomBar = document.querySelector('.zoom-bar').getBoundingClientRect();
      const topHud = document.getElementById('top-hud').getBoundingClientRect();
      const shutter = document.getElementById('btn-shutter').getBoundingClientRect();
      const modeSwitcher = document.querySelector('.mode-switcher').getBoundingClientRect();
      const vf = document.getElementById('viewfinder-frame').getBoundingClientRect();
      return {
        dock,
        zoomBar,
        topHud,
        shutter,
        modeSwitcher,
        vf,
        dockScrollH: document.querySelector('.bottom-dock').scrollHeight,
      };
    });
    assert.ok(landStats.dock.height <= 391 && landStats.dockScrollH <= 391, `Landscape dock overflowed vertically: ${JSON.stringify(landStats)}`);
    assert.ok(landStats.zoomBar.right <= landStats.dock.left + 1, `Zoom bar overlaps landscape right dock: ${JSON.stringify(landStats)}`);
    assert.ok(landStats.topHud.right <= landStats.dock.left + 1, `Top HUD overlaps landscape right dock: ${JSON.stringify(landStats)}`);
    assert.ok(landStats.shutter.bottom <= 390 && landStats.modeSwitcher.top >= 0);
    assert.ok(landStats.vf.left + landStats.vf.width <= landStats.dock.left + 2, `Landscape viewfinder hidden under dock: ${JSON.stringify(landStats.vf)}`);

    // Tap near right edge of landscape viewfinder and verify EV slider flips left cleanly
    await page.mouse.click(landStats.vf.left + landStats.vf.width - 14, landStats.vf.top + landStats.vf.height * 0.5);
    await page.waitForTimeout(50);
    assert.equal(await page.evaluate(() => document.getElementById('focus-reticle').classList.contains('is-ev-left')), true);
    if (screenshotDir) {
      await page.screenshot({ path: path.join(screenshotDir, 'e2e_landscape_844x390.png') });
    }

    // 18. Permission prompt reload hint & denied recovery flow in isolated contexts
    console.log('[e2e] checking permission reload hint banner and denied fallback UX');
    const promptContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ['camera'],
    });
    const promptPage = await promptContext.newPage();
    await promptPage.addInitScript(() => {
      localStorage.setItem('qcam_perm_granted_once', '1');
      if (navigator.permissions) {
        const origQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (desc) => {
          if (desc && desc.name === 'camera') {
            return Promise.resolve({ state: 'prompt' });
          }
          return origQuery(desc);
        };
      }
    });
    await promptPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await promptPage.waitForSelector('#perm-hint-banner:not([hidden])', { timeout: 6000 });
    await promptPage.click('#btn-perm-hint-dismiss');
    assert.equal(await promptPage.locator('#perm-hint-banner').isVisible(), false);
    assert.equal(await promptPage.evaluate(() => localStorage.getItem('qcam_perm_hint_dismissed')), '1');
    await promptContext.close();

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

    assert.deepEqual(consoleErrors, [], `Console errors encountered: ${consoleErrors.join('; ')}`);
    assert.deepEqual(pageErrors, [], `Page errors encountered: ${pageErrors.join('; ')}`);

    console.log('E2E PASS:', JSON.stringify({
      startupTimeMs: startupMetrics.startupTimeMs,
      stdPhoto,
      hqPhoto,
      orientationEngine: orientationCheck.engine,
      compactStats,
      pwa: pwaStatus,
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
