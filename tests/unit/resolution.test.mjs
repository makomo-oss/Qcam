import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AVIF_WASM_MAX_DIMENSION,
  buildInitialConstraintAttempts,
  computeMaxDimensionForMegapixels,
  computeTargetForCapabilities,
  getAvailableMegapixelOptions,
  getAvailableResolutionOptions,
  getEncoderMaxDimension,
  selectHqCapturePlan,
  shouldApplyResolutionUpgrade,
} from '../../src/utils/resolution.js';

test('buildInitialConstraintAttempts tailors ideal resolution to aspect ratio without mixing facingMode into exact lens', () => {
  const attempts43 = buildInitialConstraintAttempts({
    resolutionPreset: 'max',
    aspectRatio: '4:3',
    baseVideo: { facingMode: { ideal: 'environment' } },
  });
  assert.equal(attempts43[0].audio, false);
  assert.equal(attempts43[0].video.width.ideal, 7680);
  assert.equal(attempts43[0].video.height.ideal, 5760);
  assert.equal(attempts43[1].video.width.ideal, 4032);
  assert.equal(attempts43[1].video.height.ideal, 3024);
  assert.equal(attempts43[2].video.width.ideal, 3840);
  assert.equal(attempts43[2].video.height.ideal, 2880);

  const attempts169 = buildInitialConstraintAttempts({
    resolutionPreset: 'max',
    aspectRatio: '16:9',
    baseVideo: { facingMode: { ideal: 'environment' } },
  });
  assert.equal(attempts169[0].video.width.ideal, 7680);
  assert.equal(attempts169[0].video.height.ideal, 4320);
  assert.equal(attempts169[1].video.width.ideal, 4032);
  assert.equal(attempts169[1].video.height.ideal, 2268);

  const exactLensAttempts = buildInitialConstraintAttempts({
    resolutionPreset: 'uhd',
    aspectRatio: '4:3',
    baseVideo: { deviceId: { exact: 'ios-back-uw' } },
  });
  assert.equal(exactLensAttempts[0].video.width.ideal, 3840);
  for (const a of exactLensAttempts) {
    assert.equal(a.video?.facingMode, undefined);
  }
});

test('computeTargetForCapabilities normalizes landscape, portrait, and square driver bounds cleanly', () => {
  // 12MP landscape capabilities preserve full sensor size on max
  const iphone12 = computeTargetForCapabilities(
    { width: { min: 320, max: 4032 }, height: { min: 240, max: 3024 } },
    { resolutionPreset: 'max', aspectRatio: '4:3' }
  );
  assert.deepEqual(iphone12, { width: 4032, height: 3024 });

  // Portrait-oriented driver bounds stay portrait-axis ordered
  const portraitAxes = computeTargetForCapabilities(
    { width: { min: 240, max: 3024 }, height: { min: 320, max: 4032 } },
    { resolutionPreset: 'fhd', aspectRatio: '4:3' }
  );
  assert.deepEqual(portraitAxes, { width: 1440, height: 1920 });

  // Square max bounds (e.g. 3840x3840) pair desired aspect height
  const squareCap = computeTargetForCapabilities(
    { width: { min: 320, max: 3840 }, height: { min: 240, max: 3840 } },
    { resolutionPreset: 'max', aspectRatio: '16:9' }
  );
  assert.deepEqual(squareCap, { width: 3840, height: 2160 });
});

test('shouldApplyResolutionUpgrade detects lower initial streams and manual preset shifts', () => {
  const caps = { width: { min: 320, max: 4032 }, height: { min: 240, max: 3024 } };
  const upgrade = shouldApplyResolutionUpgrade(
    { width: 1280, height: 720 },
    caps,
    { resolutionPreset: 'max', aspectRatio: '4:3' }
  );
  assert.equal(upgrade.shouldApply, true);
  assert.deepEqual(upgrade.target, { width: 4032, height: 3024 });

  const alreadyMax = shouldApplyResolutionUpgrade(
    { width: 4032, height: 3024 },
    caps,
    { resolutionPreset: 'max', aspectRatio: '4:3' }
  );
  assert.equal(alreadyMax.shouldApply, false);

  const downgradeToHd = shouldApplyResolutionUpgrade(
    { width: 3840, height: 2880 },
    caps,
    { resolutionPreset: 'hd', aspectRatio: '4:3' }
  );
  assert.equal(downgradeToHd.shouldApply, true);
  assert.deepEqual(downgradeToHd.target, { width: 1280, height: 960 });
});

test('getAvailableResolutionOptions tailors presets per smartphone capability', () => {
  const highEnd = getAvailableResolutionOptions({
    trackCapabilities: { width: { min: 320, max: 4032 }, height: { min: 240, max: 3024 } },
    streamWidth: 4032,
    streamHeight: 3024,
    aspectRatio: '4:3',
    currentPreset: 'uhd',
  });
  assert.deepEqual(
    highEnd.options.map((o) => o.id),
    ['max', 'uhd', 'qhd', 'fhd', 'hd']
  );
  assert.equal(highEnd.effectiveSelected, 'uhd');

  const hdCam = getAvailableResolutionOptions({
    trackCapabilities: { width: { min: 320, max: 1280 }, height: { min: 240, max: 720 } },
    streamWidth: 1280,
    streamHeight: 720,
    aspectRatio: '16:9',
    currentPreset: 'uhd',
  });
  assert.deepEqual(
    hdCam.options.map((o) => o.id),
    ['max', 'hd']
  );
  assert.equal(hdCam.effectiveSelected, 'max');
});

test('getAvailableMegapixelOptions balances full sensor access against safe WASM AVIF ceiling', () => {
  // 12.2 MP iPhone stream in 4:3 -> zero downscale loss, not cropped
  const iphoneAvif43 = getAvailableMegapixelOptions({
    streamWidth: 4032,
    streamHeight: 3024,
    preferTakePhoto: false,
    aspectRatio: '4:3',
    outputFormat: 'avif',
    maxTextureSize: 8192,
    supportsNativeAvif: false,
  });
  assert.equal(iphoneAvif43.isWasmCapped, false);
  assert.equal(iphoneAvif43.isAspectCropped, false);
  assert.equal(iphoneAvif43.maxOutWidth, 4032);
  assert.equal(iphoneAvif43.maxOutHeight, 3024);

  // Same 4032x3024 (portrait or landscape) iPhone stream cropped to 16:9 -> 4032x2268 (9.1 MP), flags uncropped 12.2 MP in 4:3
  const iphoneAvif169 = getAvailableMegapixelOptions({
    streamWidth: 3024,
    streamHeight: 4032,
    preferTakePhoto: false,
    aspectRatio: '16:9',
    outputFormat: 'avif',
    maxTextureSize: 8192,
    supportsNativeAvif: false,
  });
  assert.equal(iphoneAvif169.isAspectCropped, true);
  assert.equal(iphoneAvif169.maxOutWidth, 2268);
  assert.equal(iphoneAvif169.maxOutHeight, 4032);
  assert.ok(iphoneAvif169.effectiveMaxMp > 9.1 && iphoneAvif169.effectiveMaxMp < 9.2);
  assert.ok(iphoneAvif169.uncropped43Mp > 12.1 && iphoneAvif169.uncropped43Mp < 12.3);

  // Native 16:9 stream (e.g. 1920x1080) stays unflagged for aspect cropping
  const native169 = getAvailableMegapixelOptions({
    streamWidth: 1920,
    streamHeight: 1080,
    preferTakePhoto: false,
    aspectRatio: '16:9',
    outputFormat: 'avif',
    maxTextureSize: 8192,
  });
  assert.equal(native169.isAspectCropped, false);

  // 48MP Android sensor with takePhoto still capabilities
  const android48Avif = getAvailableMegapixelOptions({
    streamWidth: 1920,
    streamHeight: 1440,
    photoMaxWidth: 8000,
    photoMaxHeight: 6000,
    preferTakePhoto: true,
    aspectRatio: '4:3',
    outputFormat: 'avif',
    maxTextureSize: 8192,
    supportsNativeAvif: false,
  });
  assert.equal(android48Avif.isWasmCapped, true);
  assert.ok(android48Avif.sensorMaxMp > 47);
  assert.ok(android48Avif.effectiveMaxMp >= 15.5 && android48Avif.effectiveMaxMp <= 16.5);

  const android48Jpeg = getAvailableMegapixelOptions({
    streamWidth: 1920,
    streamHeight: 1440,
    photoMaxWidth: 8000,
    photoMaxHeight: 6000,
    preferTakePhoto: true,
    aspectRatio: '4:3',
    outputFormat: 'jpeg',
    maxTextureSize: 8192,
    supportsNativeAvif: false,
  });
  assert.equal(android48Jpeg.isWasmCapped, false);
  assert.equal(android48Jpeg.maxOutWidth, 8000);
  assert.equal(android48Jpeg.maxOutHeight, 6000);

  // Stale high selection resets cleanly on lower-res front camera
  const frontCam = getAvailableMegapixelOptions({
    streamWidth: 1280,
    streamHeight: 720,
    preferTakePhoto: false,
    aspectRatio: '4:3',
    outputFormat: 'avif',
    currentSelection: 12,
  });
  assert.equal(frontCam.effectiveSelected, 'max');
  assert.equal(frontCam.options[0].value, 'max');
  assert.ok(getEncoderMaxDimension({ outputFormat: 'avif', maxTextureSize: 8192, supportsNativeAvif: false }) <= AVIF_WASM_MAX_DIMENSION);
  assert.ok(computeMaxDimensionForMegapixels({ outputMegapixels: 2, aspectRatio: '4:3' }) >= 1630);
});

test('selectHqCapturePlan chooses Android takePhoto for high-res still needs and 4-burst otherwise', () => {
  const androidMax = selectHqCapturePlan({
    preferTakePhoto: true,
    hasImageCapture: true,
    streamWidth: 1920,
    streamHeight: 1440,
    photoMaxWidth: 8000,
    photoMaxHeight: 6000,
    aspectRatio: '4:3',
    outputMegapixels: 'max',
    outputFormat: 'jpeg',
    maxTextureSize: 8192,
  });
  assert.equal(androidMax.captureMethod, 'takePhoto');
  assert.equal(androidMax.expectedWidth, 8000);
  assert.equal(androidMax.expectedHeight, 6000);

  // When user chooses 2MP (smaller than active 1920x1440 video stream), use 4-burst HDR noise reduction
  const android2Mp = selectHqCapturePlan({
    preferTakePhoto: true,
    hasImageCapture: true,
    streamWidth: 1920,
    streamHeight: 1440,
    photoMaxWidth: 8000,
    photoMaxHeight: 6000,
    aspectRatio: '4:3',
    outputMegapixels: 2,
    outputFormat: 'avif',
    maxTextureSize: 8192,
  });
  assert.equal(android2Mp.captureMethod, 'burst');

  const iphonePlan = selectHqCapturePlan({
    preferTakePhoto: false,
    hasImageCapture: false,
    streamWidth: 4032,
    streamHeight: 3024,
    aspectRatio: '4:3',
    outputMegapixels: 'max',
    outputFormat: 'avif',
    maxTextureSize: 8192,
  });
  assert.equal(iphonePlan.captureMethod, 'burst');
  assert.equal(iphonePlan.expectedWidth, 4032);
  assert.equal(iphonePlan.expectedHeight, 3024);
});
