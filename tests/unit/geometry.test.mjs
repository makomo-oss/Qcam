import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAspectCrop,
  computeViewfinderLayout,
  splitZoom,
  mapTapToNormalizedPoint,
} from '../../src/utils/geometry.js';

test('computeAspectCrop crops 16:9 landscape source to 4:3 cleanly', () => {
  const crop = computeAspectCrop(3840, 2160, '4:3', 1.0);
  assert.equal(crop.sw, 2880);
  assert.equal(crop.sh, 2160);
  assert.equal(crop.sx, 480);
  assert.equal(crop.sy, 0);
  assert.equal(crop.outWidth, 2880);
  assert.equal(crop.outHeight, 2160);
});

test('computeAspectCrop handles portrait orientation for 4:3 (3:4) and 16:9 (9:16)', () => {
  const crop43 = computeAspectCrop(2160, 3840, '4:3', 1.0);
  assert.equal(crop43.sw, 2160);
  assert.equal(crop43.sh, 2880);
  assert.equal(crop43.sx, 0);
  assert.equal(crop43.sy, 480);

  const crop169 = computeAspectCrop(2160, 3840, '16:9', 1.0);
  assert.equal(crop169.sw, 2160);
  assert.equal(crop169.sh, 3840);
  assert.equal(crop169.sx, 0);
  assert.equal(crop169.sy, 0);
});

test('computeAspectCrop applies software digital zoom centered and keeps output dimensions', () => {
  const crop = computeAspectCrop(3840, 2160, '16:9', 2.0);
  assert.equal(crop.sw, 1920);
  assert.equal(crop.sh, 1080);
  assert.equal(crop.sx, 960);
  assert.equal(crop.sy, 540);
  assert.equal(crop.outWidth, 3840);
  assert.equal(crop.outHeight, 2160);
});

test('computeAspectCrop clamps output size to maxDimension', () => {
  const crop = computeAspectCrop(8000, 6000, '4:3', 1.0, 4096);
  assert.equal(crop.outWidth, 4096);
  assert.equal(crop.outHeight, 3072);
});

test('splitZoom avoids double-zooming when hardware zoom is available', () => {
  const res1 = splitZoom(2.5, { min: 1, max: 4, step: 0.1 }, 5);
  assert.equal(res1.hardwareSupported, true);
  assert.equal(res1.hardwareZoom, 2.5);
  assert.equal(res1.softwareZoom, 1);

  const res2 = splitZoom(5.0, { min: 1, max: 4, step: 0.1 }, 5);
  assert.equal(res2.hardwareSupported, true);
  assert.equal(res2.hardwareZoom, 4);
  assert.equal(res2.softwareZoom, 1.25);

  const res3 = splitZoom(3.0, null, 5);
  assert.equal(res3.hardwareSupported, false);
  assert.equal(res3.hardwareZoom, 1);
  assert.equal(res3.softwareZoom, 3);
});

test('splitZoom handles < 1.0 ultra-wide hardware zoom and dedicated 0.5x lens scale without shrinking < 1', () => {
  // Hardware zoom supporting 0.5x -> 6x
  const hwUw = splitZoom(0.5, { min: 0.5, max: 6, step: 0.1 }, 6);
  assert.equal(hwUw.hardwareSupported, true);
  assert.equal(hwUw.hardwareZoom, 0.5);
  assert.equal(hwUw.softwareZoom, 1);
  assert.equal(hwUw.totalZoom, 0.5);

  // Hardware zoom with 0.6x minimum
  const hw06 = splitZoom(0.5, { min: 0.6, max: 8, step: 0.1 }, 8);
  assert.equal(hw06.hardwareSupported, true);
  assert.equal(hw06.hardwareZoom, 0.6);
  assert.equal(hw06.softwareZoom, 1);
  assert.equal(hw06.totalZoom, 0.6);

  // Physical ultra-wide lens (baseLensScale: 0.5) at native 0.5x
  const physBase = splitZoom(0.5, null, 5, { baseLensScale: 0.5 });
  assert.equal(physBase.hardwareSupported, false);
  assert.equal(physBase.hardwareZoom, 1);
  assert.equal(physBase.softwareZoom, 1);
  assert.equal(physBase.totalZoom, 0.5);

  // Physical ultra-wide lens slightly zoomed to 0.8x (1.6x digital crop on 0.5x sensor)
  const physZoomed = splitZoom(0.8, null, 5, { baseLensScale: 0.5 });
  assert.equal(physZoomed.softwareZoom, 1.6);
  assert.equal(physZoomed.totalZoom, 0.8);

  // Requesting 0.5x on a 1x-only camera clamps cleanly to 1.0x (never shrinking preview < 1.0)
  const clamped = splitZoom(0.5, { min: 1, max: 5, step: 0.1 }, 5);
  assert.equal(clamped.hardwareZoom, 1);
  assert.equal(clamped.softwareZoom, 1);
  assert.equal(clamped.totalZoom, 1);

  const clampedNoHw = splitZoom(0.5, null, 5);
  assert.equal(clampedNoHw.softwareZoom, 1);
  assert.equal(clampedNoHw.totalZoom, 1);
});

test('mapTapToNormalizedPoint handles center tap, mirroring, and software zoom', () => {
  const rect = { left: 0, top: 0, width: 300, height: 400 };
  // 16:9 landscape frame inside 3:4 portrait container -> width is cropped by object-fit: cover
  const center = mapTapToNormalizedPoint(150, 200, rect, 1920, 1080, {
    mirrored: false,
    softwareZoom: 1,
  });
  assert.equal(center.x, 0.5);
  assert.equal(center.y, 0.5);

  // Tap near right edge when mirrored should map to left side (< 0.5)
  const rightMirrored = mapTapToNormalizedPoint(270, 200, rect, 1200, 1600, {
    mirrored: true,
    softwareZoom: 1,
  });
  assert.ok(rightMirrored.x < 0.2);
  assert.equal(rightMirrored.y, 0.5);

  // Software zoom 2x compresses mapped range around center
  const zoomedEdge = mapTapToNormalizedPoint(300, 200, rect, 1200, 1600, {
    mirrored: false,
    softwareZoom: 2,
  });
  assert.equal(zoomedEdge.x, 0.75);
});

test('computeViewfinderLayout maximizes width cleanly across smartphone profiles', () => {
  // Modern iPhone portrait (390x844): 4:3 clears top & bottom HUDs completely; 16:9 fills edge-to-edge width
  const iphone43 = computeViewfinderLayout({
    stageWidth: 390,
    stageHeight: 844,
    topBarBottom: 54,
    dockTop: 654,
    dockWidth: 390,
    dockHeight: 190,
    aspectRatio: '4:3',
  });
  assert.equal(iphone43.width, 390);
  assert.equal(iphone43.height, 520);
  assert.equal(iphone43.topInset, 0);
  assert.equal(iphone43.bottomInset, 0);

  const iphone169 = computeViewfinderLayout({
    stageWidth: 390,
    stageHeight: 844,
    topBarBottom: 54,
    dockTop: 654,
    dockWidth: 390,
    dockHeight: 190,
    aspectRatio: '16:9',
  });
  assert.equal(iphone169.width, 390);
  assert.equal(iphone169.height, 693);
  assert.equal(iphone169.edgeToEdge, true);
  assert.ok(iphone169.bottomInset > 0);

  // Short mobile browser viewport (360x520 with URL bar open): expands past cramped clear band while keeping shutter safe
  const shortAndroid43 = computeViewfinderLayout({
    stageWidth: 360,
    stageHeight: 520,
    topBarBottom: 46,
    dockTop: 372,
    dockWidth: 360,
    dockHeight: 148,
    aspectRatio: '4:3',
  });
  assert.ok(shortAndroid43.width >= 305, `Expected expanded width >= 305, got ${shortAndroid43.width}`);
  assert.ok(Math.abs(shortAndroid43.width / shortAndroid43.height - 3 / 4) < 0.02);

  // Compact smartphone landscape (844x390 with side right dock)
  const phoneLandscape = computeViewfinderLayout({
    stageWidth: 844,
    stageHeight: 390,
    topBarBottom: 48,
    dockTop: 0,
    dockLeft: 742,
    dockWidth: 102,
    dockHeight: 390,
    aspectRatio: '16:9',
  });
  assert.equal(phoneLandscape.isSideDock, true);
  assert.equal(phoneLandscape.height, 390);
  assert.ok(phoneLandscape.left + phoneLandscape.width <= 742);
});

