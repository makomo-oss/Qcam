import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_PROFILES,
  STABILIZATION_MODES,
  analyzeFrameMetrics,
  analyzeRgbaScene,
  buildBurstAlignmentPlan,
  computeProDevelopProfile,
  computeStabilizedSafeCrop,
  estimateSimilarityAlignment,
  normalizeColorProfile,
  normalizeStabilizationMode,
  refineAlignmentWithNativePatches,
  similarityToUvMatrix,
} from '../../src/processing/frame-aligner.js';

function synthesizeTexturedScene(width, height, { tx = 0, ty = 0, angleDeg = 0, blurRadius = 0 } = {}) {
  const out = new Uint8Array(width * height);
  const cx = width * 0.5;
  const cy = height * 0.5;
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);

  const sampleScene = (x, y) => {
    // Rich multi-frequency architectural + grid + circular landmark scene
    let v = 38;
    const gx = Math.floor(x / 40);
    const gy = Math.floor(y / 40);
    if (((gx + gy) & 1) === 0) {
      v += 45;
    }
    // Crisp high-contrast checker blocks across quadrants
    if (Math.abs(x - cx) < width * 0.34 && Math.abs(y - cy) < height * 0.34) {
      v += 35 * Math.sin(x * 0.14) * Math.cos(y * 0.14);
    }
    // High-contrast rings and bars
    const r = Math.hypot(x - cx * 0.72, y - cy * 0.65);
    if (r > 18 && r < 44) v += 95;
    const r2 = Math.hypot(x - cx * 1.32, y - cy * 1.28);
    if (r2 < 26) v += 110;
    // Sharp horizontal/vertical edge bar
    if (Math.abs(x - cx * 1.1) < 12 && Math.abs(y - cy * 0.75) < 55) v = 235;
    if (Math.abs(y - cy * 1.35) < 10 && Math.abs(x - cx * 0.6) < 60) v = 225;
    return Math.max(0, Math.min(255, v));
  };

  // Evaluate scene transformed such that mov(px, py) matches ref warped forward by (tx, ty, angleDeg):
  // i.e., a feature at ref(x, y) shifts to mov(x', y') where (x', y') = c + R(theta)*( (x,y)-c ) + (tx, ty).
  // Inverse mapping to sample scene at mov(mx, my): refCoord = c + R(-theta)*( (mx,my) - c - (tx,ty) )
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx - tx;
      const dy = y - cy - ty;
      const rx = cx + cosA * dx + sinA * dy;
      const ry = cy - sinA * dx + cosA * dy;
      out[y * width + x] = Math.round(sampleScene(rx, ry));
    }
  }

  if (blurRadius > 0) {
    const blurred = new Uint8Array(out.length);
    const k = blurRadius;
    const count = (2 * k + 1) * (2 * k + 1);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let oy = -k; oy <= k; oy++) {
          const yy = Math.max(0, Math.min(height - 1, y + oy));
          for (let ox = -k; ox <= k; ox++) {
            const xx = Math.max(0, Math.min(width - 1, x + ox));
            sum += out[yy * width + xx];
          }
        }
        blurred[y * width + x] = Math.round(sum / count);
      }
    }
    return blurred;
  }

  return out;
}

test('normalizeStabilizationMode defaults to high and accepts valid modes', () => {
  assert.equal(normalizeStabilizationMode(undefined), STABILIZATION_MODES.HIGH);
  assert.equal(normalizeStabilizationMode('unknown'), STABILIZATION_MODES.HIGH);
  assert.equal(normalizeStabilizationMode('high'), STABILIZATION_MODES.HIGH);
  assert.equal(normalizeStabilizationMode('standard'), STABILIZATION_MODES.STANDARD);
  assert.equal(normalizeStabilizationMode('off'), STABILIZATION_MODES.OFF);
});

test('estimateSimilarityAlignment recovers hand-shake translation and roll rotation to subpixel precision', () => {
  const w = 480;
  const h = 360;
  const ref = synthesizeTexturedScene(w, h, { tx: 0, ty: 0, angleDeg: 0 });
  const mov = synthesizeTexturedScene(w, h, { tx: 16.4, ty: -11.3, angleDeg: 1.8 });

  const align = estimateSimilarityAlignment(ref, mov, w, h);
  assert.equal(align.valid, true);

  const recoveredAngleDeg = (Math.atan2(align.b, align.a) * 180) / Math.PI;
  assert.ok(Math.abs(align.tx - 16.4) < 0.75, `Expected tx≈16.4, got ${align.tx}`);
  assert.ok(Math.abs(align.ty - -11.3) < 0.75, `Expected ty≈-11.3, got ${align.ty}`);
  assert.ok(Math.abs(recoveredAngleDeg - 1.8) < 0.25, `Expected angle≈1.8°, got ${recoveredAngleDeg}`);
  assert.ok(align.residual < 8, `Expected low alignment residual, got ${align.residual}`);
});

test('buildBurstAlignmentPlan picks sharpest frame as reference and rejects motion-blurred frame', () => {
  const w = 400;
  const h = 300;
  // Simulate frame 0 suffering tap shake blur (large blur), frame 1 & 3 slightly soft, frame 2 crisp reference
  const f0Blurred = synthesizeTexturedScene(w, h, { tx: 4, ty: -2, blurRadius: 3 });
  const f1 = synthesizeTexturedScene(w, h, { tx: -7.5, ty: 5.2, angleDeg: -0.6, blurRadius: 1 });
  const f2SharpRef = synthesizeTexturedScene(w, h, { tx: 0, ty: 0, angleDeg: 0, blurRadius: 0 });
  const f3 = synthesizeTexturedScene(w, h, { tx: 11.2, ty: -6.4, angleDeg: 0.9, blurRadius: 1 });

  const mBlur = analyzeFrameMetrics(f0Blurred, w, h);
  const mF1 = analyzeFrameMetrics(f1, w, h);
  const mRef = analyzeFrameMetrics(f2SharpRef, w, h);
  assert.ok(mRef.sharpness > mF1.sharpness && mF1.sharpness > mBlur.sharpness);

  // Verify sharp reference wins even with realistic frame variance; and heavily blurred frame 0 is rejected
  const plan = buildBurstAlignmentPlan({
    lumaFrames: [f0Blurred, f1, f2SharpRef, f3],
    medW: w,
    medH: h,
    srcW: w * 4,
    srcH: h * 4,
    stabilizationMode: STABILIZATION_MODES.HIGH,
  });

  assert.equal(plan.refIndex, 2);
  assert.ok(!plan.selectedIndices.includes(0), `Blurred frame 0 should be rejected: ${plan.selectedIndices}`);
  assert.ok(plan.safeCrop.insetX >= 0 && plan.safeCrop.insetX <= 0.042);

  // Also test sharp multi-frame translation recovery on crisp burst
  const crisp1 = synthesizeTexturedScene(w, h, { tx: -7.5, ty: 5.2, angleDeg: -0.6 });
  const crisp2 = synthesizeTexturedScene(w, h, { tx: 0, ty: 0, angleDeg: 0 });
  const crisp3 = synthesizeTexturedScene(w, h, { tx: 11.2, ty: -6.4, angleDeg: 0.9 });
  const crispPlan = buildBurstAlignmentPlan({
    lumaFrames: [f0Blurred, crisp1, crisp2, crisp3],
    medW: w,
    medH: h,
    srcW: w * 4,
    srcH: h * 4,
    stabilizationMode: STABILIZATION_MODES.HIGH,
  });
  assert.notEqual(crispPlan.refIndex, 0);
  assert.ok(!crispPlan.selectedIndices.includes(0));
  assert.equal(crispPlan.selectedIndices.length, 3);
});

test('similarityToUvMatrix maps centered non-square pixel similarity transforms accurately', () => {
  const w = 4032;
  const h = 2268; // 16:9 non-square aspect ratio
  const rad = (2.0 * Math.PI) / 180;
  const align = {
    a: Math.cos(rad),
    b: Math.sin(rad),
    tx: 24,
    ty: -18,
  };
  const { mat, shift } = similarityToUvMatrix(align, w, h);

  // Test arbitrary point (u, v) = (0.25, 0.75) in normalized space
  const u = 0.25;
  const v = 0.75;
  const mu = mat[0] * u + mat[1] * v + shift[0];
  const mv = mat[2] * u + mat[3] * v + shift[1];

  // Expected exact pixel calculation
  const cx = w * 0.5;
  const cy = h * 0.5;
  const rx = u * w - cx;
  const ry = v * h - cy;
  const expectedX = cx + align.a * rx - align.b * ry + align.tx;
  const expectedY = cy + align.b * rx + align.a * ry + align.ty;

  assert.ok(Math.abs(mu * w - expectedX) < 1e-4);
  assert.ok(Math.abs(mv * h - expectedY) < 1e-4);
});

test('refineAlignmentWithNativePatches locks onto full sensor scale subpixel offset', () => {
  const srcW = 1200;
  const srcH = 900;
  const medW = 300;
  const medH = 225;
  const trueTx = 14.35;
  const trueTy = -9.65;

  // Optical bandlimited (soft 1px) source images as in real Canvas2D / camera sensors
  const refSrc = synthesizeTexturedScene(srcW, srcH, { tx: 0, ty: 0, blurRadius: 1 });
  const movSrc = synthesizeTexturedScene(srcW, srcH, { tx: trueTx, ty: trueTy, blurRadius: 1 });

  // Deliberately slightly coarse initial guess (off by ~2.5px at native res)
  const medAlign = {
    valid: true,
    a: 1,
    b: 0,
    tx: (trueTx - 2.3) / 4,
    ty: (trueTy + 1.9) / 4,
    residual: 5,
  };
  const sampleBilinear = (plane, px, py) => {
    const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(px)));
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(py)));
    const x1 = Math.min(srcW - 1, x0 + 1);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, px - x0));
    const fy = Math.max(0, Math.min(1, py - y0));
    const v00 = plane[y0 * srcW + x0];
    const v10 = plane[y0 * srcW + x1];
    const v01 = plane[y1 * srcW + x0];
    const v11 = plane[y1 * srcW + x1];
    return Math.round(
      v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy
    );
  };
  const extractPatchFn = (idx, centerX, centerY, patchSize) => {
    const plane = idx === 0 ? refSrc : movSrc;
    const out = new Uint8Array(patchSize * patchSize);
    const half = Math.floor(patchSize / 2);
    for (let y = 0; y < patchSize; y++) {
      const sy = centerY - half + y;
      for (let x = 0; x < patchSize; x++) {
        const sx = centerX - half + x;
        out[y * patchSize + x] = sampleBilinear(plane, sx, sy);
      }
    }
    return out;
  };

  const refined = refineAlignmentWithNativePatches({
    refIndex: 0,
    movIndex: 1,
    srcW,
    srcH,
    medW,
    medH,
    medAlign,
    anchors: [
      { cx: 100, cy: 75, grad: 20 },
      { cx: 200, cy: 75, grad: 20 },
      { cx: 150, cy: 112, grad: 25 },
      { cx: 100, cy: 155, grad: 20 },
      { cx: 200, cy: 155, grad: 20 },
    ],
    extractPatchFn,
  });

  assert.equal(refined.valid, true);
  assert.ok(Math.abs(refined.tx - trueTx) < 0.35, `Expected refined tx≈${trueTx}, got ${refined.tx}`);
  assert.ok(Math.abs(refined.ty - trueTy) < 0.35, `Expected refined ty≈${trueTy}, got ${refined.ty}`);
});

test('computeStabilizedSafeCrop bounds inset ratio safely', () => {
  const safe = computeStabilizedSafeCrop(
    [
      { valid: true, weight: 1, a: 1, b: 0, tx: 0, ty: 0 },
      { valid: true, weight: 1, a: 1, b: 0, tx: -320, ty: 240 },
    ],
    4000,
    3000,
    { maxInsetRatio: 0.042 }
  );
  assert.equal(safe.insetX, 0.042);
  assert.equal(safe.insetY, 0.042);
});

function makeSolidOrPatternRgba(width, height, pixelFn) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const [r, g, b] = pixelFn(x, y);
      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
      out[idx + 3] = 255;
    }
  }
  return out;
}

test('normalizeColorProfile defaults unknown values to natural and preserves valid profiles', () => {
  assert.equal(normalizeColorProfile(undefined), COLOR_PROFILES.NATURAL);
  assert.equal(normalizeColorProfile('unknown'), COLOR_PROFILES.NATURAL);
  assert.equal(normalizeColorProfile('natural'), COLOR_PROFILES.NATURAL);
  assert.equal(normalizeColorProfile('vivid'), COLOR_PROFILES.VIVID);
  assert.equal(normalizeColorProfile('film'), COLOR_PROFILES.FILM);
});

test('analyzeRgbaScene separates crisp structural edges from real sensor noise', () => {
  const w = 128;
  const h = 128;
  // Clean sharp black & white checker blocks (zero noise)
  const cleanRgba = makeSolidOrPatternRgba(w, h, (x, y) => {
    const checker = ((Math.floor(x / 24) + Math.floor(y / 24)) & 1) === 0;
    return checker ? [225, 225, 225] : [30, 30, 30];
  });
  const cleanStats = analyzeRgbaScene(cleanRgba, w, h);
  assert.ok(
    cleanStats.noiseSigma <= 0.005,
    `Clean structural edges should not inflate noiseSigma, got ${cleanStats.noiseSigma}`
  );

  // Low-light flat patch with deterministic zero-mean ISO noise ±24
  let seed = 0x13579bdf;
  const nextRand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const noisyRgba = makeSolidOrPatternRgba(w, h, () => {
    const n1 = Math.round((nextRand() + nextRand() - 1) * 26);
    const n2 = Math.round((nextRand() + nextRand() - 1) * 26);
    const n3 = Math.round((nextRand() + nextRand() - 1) * 26);
    return [
      Math.max(0, Math.min(255, 42 + n1)),
      Math.max(0, Math.min(255, 44 + n2)),
      Math.max(0, Math.min(255, 48 + n3)),
    ];
  });
  const noisyStats = analyzeRgbaScene(noisyRgba, w, h);
  assert.ok(
    noisyStats.noiseSigma >= 0.025,
    `Noisy low-light patch should detect noiseSigma >= 0.025, got ${noisyStats.noiseSigma}`
  );
  assert.ok(noisyStats.noiseSigma > cleanStats.noiseSigma * 5);
});

test('analyzeRgbaScene confidence-gates Auto White Balance without corrupting saturated scenes', () => {
  const w = 96;
  const h = 96;
  // Warm-cast neutral gray wall: R slightly > G > B inside neutral reflectance tolerance
  const warmGray = makeSolidOrPatternRgba(w, h, () => [150, 142, 134]);
  const warmStats = analyzeRgbaScene(warmGray, w, h);
  assert.ok(warmStats.wbConfidence > 0.5, `Expected high WB confidence, got ${warmStats.wbConfidence}`);
  assert.ok(
    warmStats.wbGains[2] > warmStats.wbGains[0] && warmStats.wbGains[0] < 1.0,
    `Warm gray should cool blue > green > red, got ${warmStats.wbGains}`
  );

  // 4-quadrant pure saturated chart: zero neutral pixels -> WB stays [1, 1, 1]
  const satChart = makeSolidOrPatternRgba(w, h, (x, y) => {
    if (x < w / 2 && y < h / 2) return [255, 0, 0];
    if (x >= w / 2 && y < h / 2) return [0, 255, 0];
    if (x < w / 2 && y >= h / 2) return [0, 0, 255];
    return [255, 255, 0];
  });
  const satStats = analyzeRgbaScene(satChart, w, h);
  assert.equal(satStats.wbConfidence, 0);
  assert.deepEqual(satStats.wbGains, [1, 1, 1]);

  // High dynamic range backlit scene (25% deep shadow 18, 25% bright sky 248, 50% mid 128)
  const hdrChart = makeSolidOrPatternRgba(w, h, (_x, y) => {
    if (y < h * 0.25) return [248, 246, 236];
    if (y >= h * 0.75) return [18, 20, 24];
    return [126, 128, 132];
  });
  const hdrStats = analyzeRgbaScene(hdrChart, w, h);
  assert.ok(hdrStats.dynamicRangeEv > 5.0, `Expected high dynamic range EV > 5, got ${hdrStats.dynamicRangeEv}`);
  assert.ok(hdrStats.shadowFraction >= 0.2);
});

test('computeProDevelopProfile adapts look presets, noise denoising, and burst sharpening', () => {
  const cleanScene = {
    noiseSigma: 0.004,
    midtoneLuma: 0.45,
    sceneMidLogL: -2.1,
    p50: 0.45,
    dynamicRangeEv: 4.2,
    shadowFraction: 0.12,
    highlightFraction: 0.04,
    clippedFraction: 0,
    wbGains: [1, 1, 1],
  };
  const noisyScene = {
    ...cleanScene,
    noiseSigma: 0.045,
    midtoneLuma: 0.18,
    p50: 0.18,
    shadowFraction: 0.45,
  };

  const nat = computeProDevelopProfile(cleanScene, {
    frameCount: 4,
    mergedCount: 4,
    colorProfile: COLOR_PROFILES.NATURAL,
  });
  const viv = computeProDevelopProfile(cleanScene, {
    frameCount: 4,
    mergedCount: 4,
    colorProfile: COLOR_PROFILES.VIVID,
  });
  const film = computeProDevelopProfile(cleanScene, {
    frameCount: 4,
    mergedCount: 4,
    colorProfile: COLOR_PROFILES.FILM,
  });
  const night = computeProDevelopProfile(noisyScene, {
    frameCount: 1,
    mergedCount: 1,
    colorProfile: COLOR_PROFILES.NATURAL,
  });

  assert.equal(nat.colorProfile, COLOR_PROFILES.NATURAL);
  assert.ok(viv.saturation > nat.saturation && nat.saturation > film.saturation);
  assert.ok(viv.vibrance > nat.vibrance);
  assert.ok(film.filmFade > 0 && film.warmth > 0);
  assert.ok(night.denoiseStrength > nat.denoiseStrength * 2);
  assert.ok(night.sharpen < nat.sharpen, 'Noisy single frame should pull back CAS sharpening');
  assert.ok(night.autoExposureEv > nat.autoExposureEv, 'Underexposed frame should lift autoExposureEv');
});

test('analyzeFrameMetrics trimmedMeanLuma resists clipped highlights and pure black corners', () => {
  const w = 64;
  const h = 64;
  const luma = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      luma[y * w + x] = y < 12 ? 255 : 120;
    }
  }
  const metrics = analyzeFrameMetrics(luma, w, h);
  assert.ok(Math.abs(metrics.trimmedMeanLuma - 120) < 1, `Expected trimmedMeanLuma ~120, got ${metrics.trimmedMeanLuma}`);
  assert.ok(metrics.meanLuma > metrics.trimmedMeanLuma + 5);
});

