import { ASPECT_RATIOS, computeAspectCrop } from './geometry.js';

/**
 * Resolution & Megapixel capability inspection, constraint generation,
 * and safe encoder ceilings for per-device maximum image quality.
 * Pure functions enable deterministic unit testing across virtual iOS/Android sensors.
 */

export const AVIF_WASM_MAX_PIXELS = 16_000_000;
export const AVIF_WASM_MAX_DIMENSION = 5120;
export const ABSOLUTE_MAX_DIMENSION = 16384;

export const RESOLUTION_PRESETS = Object.freeze([
  { id: 'max', label: '最高', longEdge: null },
  { id: 'uhd', label: '4K', longEdge: 3840 },
  { id: 'qhd', label: 'WQHD', longEdge: 2560 },
  { id: 'fhd', label: 'FHD', longEdge: 1920 },
  { id: 'hd', label: 'HD', longEdge: 1280 },
  { id: 'vga', label: 'SD', longEdge: 640 },
]);

export const MEGAPIXEL_TIERS = Object.freeze([50, 48, 24, 16, 12, 8, 5, 2, 1, 0.5]);

function toEven(n) {
  const rounded = Math.max(2, Math.round(n));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

export function normalizeResolutionPreset(value) {
  if (typeof value === 'string' && RESOLUTION_PRESETS.some((p) => p.id === value)) {
    return value;
  }
  return 'max';
}

export function normalizeMegapixelsSetting(value) {
  if (value === 'max' || value === undefined || value === null || value === '') {
    return 'max';
  }
  const num = Number(value);
  if (Number.isFinite(num) && num >= 0.3 && num <= 200) {
    return num;
  }
  return 'max';
}

export function formatMegapixelsLabel(mp) {
  if (!Number.isFinite(mp) || mp <= 0) return '-- MP';
  if (mp >= 10) return `${mp.toFixed(1).replace(/\.0$/, '')} MP`;
  return `${mp.toFixed(1)} MP`;
}

export function getPresetTargetDimensions(presetId, aspectRatio = '4:3') {
  const ratio = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['4:3'];
  const preset = RESOLUTION_PRESETS.find((p) => p.id === presetId);
  if (!preset || !preset.longEdge) {
    // Request sensor maximum tailored to aspect ratio so 4:3 readout is not cropped to 16:9
    const longMax = 7680;
    const shortMax = toEven(longMax / ratio);
    return { longEdge: longMax, shortEdge: shortMax };
  }
  const longEdge = preset.longEdge;
  const shortEdge = toEven(longEdge / ratio);
  return { longEdge, shortEdge };
}

/**
 * Build ordered MediaStreamConstraints for getUserMedia honoring the chosen
 * resolution preset and aspect ratio without failing on constrained hardware.
 */
export function buildInitialConstraintAttempts({
  resolutionPreset = 'max',
  aspectRatio = '4:3',
  baseVideo = {},
} = {}) {
  const safePreset = normalizeResolutionPreset(resolutionPreset);
  const { longEdge, shortEdge } = getPresetTargetDimensions(safePreset, aspectRatio);

  const attempts = [
    {
      audio: false,
      video: {
        ...baseVideo,
        width: { ideal: longEdge },
        height: { ideal: shortEdge },
      },
    },
  ];

  // Fallback ladder tailored to aspect ratio
  if (longEdge > 3840) {
    attempts.push({
      audio: false,
      video: {
        ...baseVideo,
        width: { ideal: 3840 },
        height: { ideal: aspectRatio === '4:3' ? 2880 : 2160 },
      },
    });
  }

  if (longEdge > 1920) {
    attempts.push({
      audio: false,
      video: {
        ...baseVideo,
        width: { ideal: 1920 },
        height: { ideal: aspectRatio === '4:3' ? 1440 : 1080 },
      },
    });
  }

  // Fallback without resolution constraints (preserving deviceId if exact, otherwise facingMode)
  if (Object.keys(baseVideo).length > 0) {
    attempts.push({
      audio: false,
      video: { ...baseVideo },
    });
  }

  if (!baseVideo.deviceId?.exact && baseVideo.facingMode) {
    attempts.push({
      audio: false,
      video: { facingMode: baseVideo.facingMode },
    });
  }

  if (!baseVideo.deviceId?.exact) {
    attempts.push({
      audio: false,
      video: true,
    });
  }

  return attempts;
}

/**
 * Compute ideal (width, height) aligned to a live track's capability bounds and axis orientation.
 */
export function computeTargetForCapabilities(
  capabilities = {},
  {
    resolutionPreset = 'max',
    aspectRatio = '4:3',
    fallbackWidth = 0,
    fallbackHeight = 0,
  } = {}
) {
  const rawMaxW =
    capabilities?.width && typeof capabilities.width.max === 'number'
      ? capabilities.width.max
      : fallbackWidth;
  const rawMaxH =
    capabilities?.height && typeof capabilities.height.max === 'number'
      ? capabilities.height.max
      : fallbackHeight;
  const rawMinW =
    capabilities?.width && typeof capabilities.width.min === 'number'
      ? capabilities.width.min
      : 320;
  const rawMinH =
    capabilities?.height && typeof capabilities.height.min === 'number'
      ? capabilities.height.min
      : 240;

  if (!rawMaxW || !rawMaxH) {
    const dims = getPresetTargetDimensions(resolutionPreset, aspectRatio);
    return { width: dims.longEdge, height: dims.shortEdge };
  }

  const isPortraitAxes = rawMaxH > rawMaxW;
  const capLong = Math.max(rawMaxW, rawMaxH);
  const capShort = Math.min(rawMaxW, rawMaxH);
  const capMinLong = Math.min(capLong, Math.max(rawMinW, rawMinH));
  const capMinShort = Math.min(capShort, Math.min(rawMinW, rawMinH));

  const safePreset = normalizeResolutionPreset(resolutionPreset);
  const ratio = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['4:3'];

  let desiredLong;
  let desiredShort;

  if (safePreset === 'max') {
    desiredLong = capLong;
    // Handle drivers reporting square max bounds (e.g. 3840x3840) by pairing desired aspect height
    if (capShort >= capLong * 0.95) {
      desiredShort = Math.min(capShort, toEven(desiredLong / ratio));
    } else {
      // Preserve full sensor cap (avoid requesting e.g. 2880x2160 on 3840x2160 sensor, which can downgrade stream)
      desiredShort = capShort;
    }
  } else {
    const presetDims = getPresetTargetDimensions(safePreset, aspectRatio);
    desiredLong = Math.min(capLong, Math.max(capMinLong, presetDims.longEdge));
    desiredShort = Math.min(capShort, Math.max(capMinShort, toEven(desiredLong / ratio)));
  }

  desiredLong = Math.round(desiredLong);
  desiredShort = Math.round(desiredShort);

  return isPortraitAxes
    ? { width: desiredShort, height: desiredLong }
    : { width: desiredLong, height: desiredShort };
}

/**
 * Determine if active track settings should be updated via applyConstraints
 * to reach max capabilities or match a user-selected preset.
 */
export function shouldApplyResolutionUpgrade(
  currentSettings = {},
  trackCapabilities = {},
  { resolutionPreset = 'max', aspectRatio = '4:3' } = {}
) {
  const target = computeTargetForCapabilities(trackCapabilities, {
    resolutionPreset,
    aspectRatio,
    fallbackWidth: currentSettings.width || 0,
    fallbackHeight: currentSettings.height || 0,
  });

  const curW = Number(currentSettings.width || 0);
  const curH = Number(currentSettings.height || 0);
  if (!curW || !curH || !target.width || !target.height) {
    return { shouldApply: false, target };
  }

  const safePreset = normalizeResolutionPreset(resolutionPreset);
  const curLong = Math.max(curW, curH);
  const curShort = Math.min(curW, curH);
  const targetLong = Math.max(target.width, target.height);
  const targetShort = Math.min(target.width, target.height);

  if (safePreset === 'max') {
    const curPixels = curLong * curShort;
    const targetPixels = targetLong * targetShort;
    // Upgrade when capabilities strictly offer >= 10% more total pixels or wider aspect readout
    return {
      shouldApply: targetPixels > curPixels * 1.1 || (targetLong > curLong * 1.05 && targetShort >= curShort),
      target,
    };
  }

  const differs =
    Math.abs(curLong - targetLong) > targetLong * 0.08 ||
    Math.abs(curShort - targetShort) > targetShort * 0.08;
  return { shouldApply: differs, target };
}

/**
 * Build selectable stream resolution presets tailored cleanly to the current phone's capabilities.
 */
export function getAvailableResolutionOptions({
  trackCapabilities = {},
  streamWidth = 0,
  streamHeight = 0,
  aspectRatio = '4:3',
  currentPreset = 'max',
} = {}) {
  const safeSelected = normalizeResolutionPreset(currentPreset);
  const rawMaxW = trackCapabilities?.width?.max || streamWidth || 1920;
  const rawMaxH = trackCapabilities?.height?.max || streamHeight || 1080;
  const rawMinW = trackCapabilities?.width?.min || 320;

  const capLong = Math.max(rawMaxW, rawMaxH);
  const capShort = Math.min(rawMaxW, rawMaxH);
  const capMinLong = Math.min(capLong, Math.max(rawMinW, trackCapabilities?.height?.min || 240));
  const ratio = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['4:3'];

  const maxTarget = computeTargetForCapabilities(trackCapabilities, {
    resolutionPreset: 'max',
    aspectRatio,
    fallbackWidth: streamWidth,
    fallbackHeight: streamHeight,
  });
  const maxLong = Math.max(maxTarget.width, maxTarget.height);
  const maxShort = Math.min(maxTarget.width, maxTarget.height);

  const options = [
    {
      id: 'max',
      label: `最高 (${maxLong}×${maxShort})`,
      shortLabel: '最高',
      width: maxTarget.width,
      height: maxTarget.height,
      supported: true,
    },
  ];

  for (const preset of RESOLUTION_PRESETS) {
    if (preset.id === 'max') continue;
    // Only include SD (640) if device maximum is below HD (< 1280)
    if (preset.id === 'vga' && capLong >= 1280) continue;
    // Include discrete tiers supported by sensor cap (with small 4% tolerance for e.g. 3840 vs 4000)
    if (preset.longEdge <= capLong * 1.02 && preset.longEdge >= Math.min(capMinLong, 640)) {
      const h = Math.min(capShort, toEven(preset.longEdge / ratio));
      options.push({
        id: preset.id,
        label: `${preset.label} (${preset.longEdge}×${h})`,
        shortLabel: preset.label,
        width: preset.longEdge,
        height: h,
        supported: true,
      });
    }
  }

  // Ensure at least one selectable preset matches persisted selection or fallback cleanly
  const hasSelected = options.some((o) => o.id === safeSelected);
  const effectiveSelected = hasSelected ? safeSelected : 'max';

  return {
    options,
    effectiveSelected,
    capWidth: capLong,
    capHeight: capShort,
  };
}

/**
 * Compute encoder maximum dimension cap given output format, native AVIF availability,
 * WebGL MAX_TEXTURE_SIZE, and target crop aspect ratio.
 */
export function getEncoderMaxDimension({
  outputFormat = 'avif',
  maxTextureSize = 4096,
  supportsNativeAvif = false,
  aspectRatio = '4:3',
} = {}) {
  const texMax = Math.max(512, Math.min(ABSOLUTE_MAX_DIMENSION, Number(maxTextureSize) || 4096));
  if (outputFormat === 'jpeg' || supportsNativeAvif) {
    return texMax;
  }

  // Single-threaded WASM @jsquash/avif allocates uncompressed frame buffers proportional to width*height;
  // constrain safely to ~16 MP so 12-16 MP sensors stay lossless while 48-50 MP Android stills never OOM.
  const ratio = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['4:3'];
  const longFor16Mp = toEven(Math.sqrt(AVIF_WASM_MAX_PIXELS * ratio));
  return Math.min(texMax, AVIF_WASM_MAX_DIMENSION, longFor16Mp);
}

/**
 * Convert a megapixel setting ('max' or MP number) into an exact maxDimension
 * for computeAspectCrop(), clamped safely by GPU and encoder ceilings.
 */
export function computeMaxDimensionForMegapixels({
  outputMegapixels = 'max',
  aspectRatio = '4:3',
  outputFormat = 'avif',
  maxTextureSize = 4096,
  supportsNativeAvif = false,
} = {}) {
  const encoderMax = getEncoderMaxDimension({
    outputFormat,
    maxTextureSize,
    supportsNativeAvif,
    aspectRatio,
  });

  const normalized = normalizeMegapixelsSetting(outputMegapixels);
  if (normalized === 'max') {
    return encoderMax;
  }

  const ratio = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['4:3'];
  const targetPixels = normalized * 1_000_000;
  const targetLongEdge = toEven(Math.sqrt(targetPixels * ratio));
  return Math.max(320, Math.min(encoderMax, targetLongEdge));
}

/**
 * Compute hardware sensor maximum achievable output dimensions & selectable Megapixel options
 * for the active device/lens.
 */
export function getAvailableMegapixelOptions({
  trackCapabilities = {},
  photoMaxWidth = null,
  photoMaxHeight = null,
  streamWidth = 0,
  streamHeight = 0,
  preferTakePhoto = false,
  aspectRatio = '4:3',
  outputFormat = 'avif',
  maxTextureSize = 4096,
  supportsNativeAvif = false,
  currentSelection = 'max',
} = {}) {
  const activeStreamW = streamWidth || trackCapabilities?.width?.max || 1920;
  const activeStreamH = streamHeight || trackCapabilities?.height?.max || 1080;
  const activeStreamPixels = activeStreamW * activeStreamH;
  const stillPixels =
    preferTakePhoto && photoMaxWidth && photoMaxHeight ? photoMaxWidth * photoMaxHeight : 0;

  const rawSourceW = stillPixels > activeStreamPixels ? photoMaxWidth : activeStreamW;
  const rawSourceH = stillPixels > activeStreamPixels ? photoMaxHeight : activeStreamH;

  const encoderMax = getEncoderMaxDimension({
    outputFormat,
    maxTextureSize,
    supportsNativeAvif,
    aspectRatio,
  });

  const sensorCropped = computeAspectCrop(rawSourceW, rawSourceH, aspectRatio, 1, ABSOLUTE_MAX_DIMENSION);
  const encodedMaxCrop = computeAspectCrop(rawSourceW, rawSourceH, aspectRatio, 1, encoderMax);

  const sensorMaxMp = (sensorCropped.outWidth * sensorCropped.outHeight) / 1_000_000;
  const effectiveMaxMp = (encodedMaxCrop.outWidth * encodedMaxCrop.outHeight) / 1_000_000;

  const isWasmCapped =
    outputFormat === 'avif' && !supportsNativeAvif && sensorMaxMp > effectiveMaxMp + 0.6;

  const maxSummaryLabel = formatMegapixelsLabel(effectiveMaxMp);
  const options = [
    {
      value: 'max',
      label: isWasmCapped ? `最高 (${maxSummaryLabel} · AVIF上限)` : `最高 (${maxSummaryLabel})`,
      megapixels: effectiveMaxMp,
      outWidth: encodedMaxCrop.outWidth,
      outHeight: encodedMaxCrop.outHeight,
      supported: true,
    },
  ];

  // Offer selectable MP tiers strictly below effective peak (avoid cluttering near-duplicate top value)
  for (const tier of MEGAPIXEL_TIERS) {
    if (tier <= effectiveMaxMp * 0.88) {
      if (effectiveMaxMp >= 8 && tier < 2) continue;
      if (effectiveMaxMp >= 2.4 && tier < 1) continue;
      const tierDim = computeMaxDimensionForMegapixels({
        outputMegapixels: tier,
        aspectRatio,
        outputFormat,
        maxTextureSize,
        supportsNativeAvif,
      });
      const tierCrop = computeAspectCrop(rawSourceW, rawSourceH, aspectRatio, 1, tierDim);
      options.push({
        value: tier,
        label: `${tier} MP (${tierCrop.outWidth}×${tierCrop.outHeight})`,
        megapixels: tier,
        outWidth: tierCrop.outWidth,
        outHeight: tierCrop.outHeight,
        supported: true,
      });
    }
  }

  const normalizedSel = normalizeMegapixelsSetting(currentSelection);
  const selectedCropDim = computeMaxDimensionForMegapixels({
    outputMegapixels: normalizedSel,
    aspectRatio,
    outputFormat,
    maxTextureSize,
    supportsNativeAvif,
  });
  const selectedOutCrop = computeAspectCrop(rawSourceW, rawSourceH, aspectRatio, 1, selectedCropDim);
  const selectedOutMp = (selectedOutCrop.outWidth * selectedOutCrop.outHeight) / 1_000_000;

  // Map stale high numeric selection (e.g. switched to front camera or AVIF ceiling) cleanly onto 'max'
  const effectiveSelected =
    normalizedSel === 'max' || normalizedSel <= effectiveMaxMp * 1.05 ? normalizedSel : 'max';

  return {
    options,
    effectiveSelected,
    sensorSourceWidth: rawSourceW,
    sensorSourceHeight: rawSourceH,
    sensorMaxMp,
    effectiveMaxMp,
    maxOutWidth: encodedMaxCrop.outWidth,
    maxOutHeight: encodedMaxCrop.outHeight,
    plannedOutWidth: selectedOutCrop.outWidth,
    plannedOutHeight: selectedOutCrop.outHeight,
    plannedOutMp: selectedOutMp,
    isWasmCapped,
    encoderMaxDimension: encoderMax,
  };
}

/**
 * Choose whether HQ capture uses full still-sensor ImageCapture.takePhoto() + single-frame HQ HDR
 * or multi-frame 4-burst video averaging + HQ HDR.
 */
export function selectHqCapturePlan({
  preferTakePhoto = false,
  hasImageCapture = false,
  streamWidth = 0,
  streamHeight = 0,
  photoMaxWidth = null,
  photoMaxHeight = null,
  aspectRatio = '4:3',
  softwareZoom = 1,
  outputMegapixels = 'max',
  outputFormat = 'avif',
  maxTextureSize = 4096,
  supportsNativeAvif = false,
} = {}) {
  const maxDimension = computeMaxDimensionForMegapixels({
    outputMegapixels,
    aspectRatio,
    outputFormat,
    maxTextureSize,
    supportsNativeAvif,
  });

  const streamCrop = computeAspectCrop(
    Math.max(1, streamWidth || 1280),
    Math.max(1, streamHeight || 720),
    aspectRatio,
    softwareZoom,
    maxDimension
  );
  const streamOutPixels = streamCrop.outWidth * streamCrop.outHeight;

  const canTryTakePhoto = Boolean(preferTakePhoto && hasImageCapture);
  if (!canTryTakePhoto) {
    return {
      captureMethod: 'burst',
      maxDimension,
      expectedWidth: streamCrop.outWidth,
      expectedHeight: streamCrop.outHeight,
    };
  }

  if (photoMaxWidth && photoMaxHeight) {
    const stillCrop = computeAspectCrop(
      photoMaxWidth,
      photoMaxHeight,
      aspectRatio,
      softwareZoom,
      maxDimension
    );
    const stillOutPixels = stillCrop.outWidth * stillCrop.outHeight;

    // Use ImageCapture.takePhoto() whenever still sensor achieves meaningfully more pixels than video stream
    if (stillOutPixels > streamOutPixels * 1.1) {
      return {
        captureMethod: 'takePhoto',
        maxDimension,
        expectedWidth: stillCrop.outWidth,
        expectedHeight: stillCrop.outHeight,
      };
    }

    return {
      captureMethod: 'burst',
      maxDimension,
      expectedWidth: streamCrop.outWidth,
      expectedHeight: streamCrop.outHeight,
    };
  }

  // Before photoCapabilities resolves on Android, prefer takePhoto for 'max' / > stream target
  // so Android still sensor resolution isn't missed; fallback to burst happens seamlessly in CameraController.
  const normMp = normalizeMegapixelsSetting(outputMegapixels);
  if (normMp === 'max' || normMp * 1_000_000 > streamOutPixels * 1.1) {
    return {
      captureMethod: 'takePhoto',
      maxDimension,
      expectedWidth: streamCrop.outWidth,
      expectedHeight: streamCrop.outHeight,
    };
  }

  return {
    captureMethod: 'burst',
    maxDimension,
    expectedWidth: streamCrop.outWidth,
    expectedHeight: streamCrop.outHeight,
  };
}
