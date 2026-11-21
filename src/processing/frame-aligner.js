/**
 * Multi-frame digital image stabilization (EIS) and Coarse-to-Fine burst alignment engine.
 * Works purely on grayscale luminance arrays in Web Worker, main thread, or Node unit tests.
 */

export const STABILIZATION_MODES = Object.freeze({
  HIGH: 'high',
  STANDARD: 'standard',
  OFF: 'off',
});

export const COLOR_PROFILES = Object.freeze({
  NATURAL: 'natural',
  VIVID: 'vivid',
  FILM: 'film',
});

export function normalizeStabilizationMode(value) {
  if (value === STABILIZATION_MODES.STANDARD) return STABILIZATION_MODES.STANDARD;
  if (value === STABILIZATION_MODES.OFF) return STABILIZATION_MODES.OFF;
  return STABILIZATION_MODES.HIGH;
}

export function normalizeColorProfile(value) {
  if (value === COLOR_PROFILES.VIVID) return COLOR_PROFILES.VIVID;
  if (value === COLOR_PROFILES.FILM) return COLOR_PROFILES.FILM;
  return COLOR_PROFILES.NATURAL;
}

const SRGB_TO_LINEAR_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR_LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function srgbChannelToLinear(c) {
  const safe = Math.max(0, Math.min(1, c));
  return safe <= 0.04045 ? safe / 12.92 : Math.pow((safe + 0.055) / 1.055, 2.4);
}

/**
 * Analyze an RGBA8 frame (typically downsampled <= 240px long edge) for:
 * - flat-region sensor noise sigma (Immerkaer Laplacian gated by coarse 2x2 structure gradients)
 * - linear & sRGB luminance distribution / percentiles / dynamic range in EV
 * - confidence-gated near-neutral Auto White Balance gains [r, g, b]
 */
export function analyzeRgbaScene(rgbaData, width, height) {
  if (!rgbaData || width < 8 || height < 8) {
    return {
      noiseSigma: 0.012,
      midtoneLuma: 0.42,
      sceneMidLogL: -2.4,
      p02: 0.05,
      p10: 0.12,
      p50: 0.42,
      p90: 0.78,
      p99: 0.92,
      dynamicRangeEv: 4.5,
      shadowFraction: 0.15,
      highlightFraction: 0.05,
      clippedFraction: 0.005,
      wbConfidence: 0,
      wbGains: [1, 1, 1],
    };
  }

  const totalCount = width * height;
  const lumaByte = new Uint8Array(totalCount);
  const hist = new Uint32Array(256);

  let shadowCount = 0;
  let highlightCount = 0;
  let clippedCount = 0;
  let midLumaSum = 0;
  let midLumaCount = 0;

  let neutralLinR = 0;
  let neutralLinG = 0;
  let neutralLinB = 0;
  let neutralCount = 0;
  let wbEligibleCount = 0;

  for (let i = 0, p = 0; i < totalCount; i++, p += 4) {
    const r = rgbaData[p];
    const g = rgbaData[p + 1];
    const b = rgbaData[p + 2];
    const yByte = (54 * r + 183 * g + 19 * b) >> 8;
    lumaByte[i] = yByte;
    hist[yByte] += 1;

    // Integer thresholds equivalent to yByte/255 < 0.16 (<=40), > 0.86 (>=220), > 0.97 (>=248), [0.08..0.90] ([21..229])
    if (yByte <= 40) shadowCount += 1;
    if (yByte >= 220) highlightCount += 1;
    if (yByte >= 248) clippedCount += 1;
    if (yByte >= 21 && yByte <= 229) {
      midLumaSum += yByte;
      midLumaCount += 1;
    }

    // Subsample every 2nd pixel for linear-light gray-zone WB stats
    if ((i & 1) === 0 && r < 248 && g < 248 && b < 248 && (r > 22 || g > 22 || b > 22)) {
      wbEligibleCount += 1;
      const lr = SRGB_TO_LINEAR_LUT[r];
      const lg = SRGB_TO_LINEAR_LUT[g];
      const lb = SRGB_TO_LINEAR_LUT[b];
      const maxC = lr > lg ? (lr > lb ? lr : lb) : lg > lb ? lg : lb;
      const minC = lr < lg ? (lr < lb ? lr : lb) : lg < lb ? lg : lb;
      if (maxC > 0.015 && maxC - minC <= maxC * 0.24) {
        neutralLinR += lr;
        neutralLinG += lg;
        neutralLinB += lb;
        neutralCount += 1;
      }
    }
  }

  const percentileNorm = (q) => {
    const target = Math.max(1, Math.min(totalCount, Math.round(totalCount * q)));
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v / 255;
    }
    return 1;
  };

  const p02 = percentileNorm(0.02);
  const p10 = percentileNorm(0.10);
  const p50 = percentileNorm(0.50);
  const p90 = percentileNorm(0.90);
  const p99 = percentileNorm(0.99);

  const lin02 = Math.max(0.0025, srgbChannelToLinear(p02));
  const lin50 = Math.max(0.004, srgbChannelToLinear(p50));
  const lin99 = Math.max(lin02 + 0.004, srgbChannelToLinear(p99));
  const dynamicRangeEv = Math.max(1.5, Math.min(11.0, Math.log2(lin99 / lin02)));
  const sceneMidLogL = Math.max(-7.5, Math.min(0.2, Math.log2(lin50)));

  // Immerkaer 3x3 high-pass noise estimate restricted to structurally smooth blocks.
  // rawStructGrad = |boxR - boxL| + |boxB - boxT| is an exact integer in [0..2040],
  // enabling an exact O(N) stable bucket selection with zero object allocations.
  const gridStep = Math.max(1, Math.floor(Math.min(width, height) / 140));
  const rowsCount = Math.max(0, Math.ceil((height - 4) / gridStep));
  const colsCount = Math.max(0, Math.ceil((width - 4) / gridStep));
  const maxSamples = rowsCount * colsCount;
  const sampleLap = new Uint16Array(maxSamples);
  const sampleGrad = new Uint16Array(maxSamples);
  const gradHist = new Uint32Array(2041);
  let sampleCount = 0;

  for (let y = 2; y < height - 2; y += gridStep) {
    const row = y * width;
    const rowUp = (y - 1) * width;
    const rowDn = (y + 1) * width;
    const rowUp2 = (y - 2) * width;
    const rowDn2 = (y + 2) * width;
    for (let x = 2; x < width - 2; x += gridStep) {
      const lap =
        4 * lumaByte[row + x] -
        2 * (lumaByte[row + x - 1] + lumaByte[row + x + 1] + lumaByte[rowUp + x] + lumaByte[rowDn + x]) +
        (lumaByte[rowUp + x - 1] + lumaByte[rowUp + x + 1] + lumaByte[rowDn + x - 1] + lumaByte[rowDn + x + 1]);
      const boxL =
        lumaByte[rowUp + x - 2] + lumaByte[rowUp + x - 1] + lumaByte[row + x - 2] + lumaByte[row + x - 1];
      const boxR =
        lumaByte[rowUp + x + 1] + lumaByte[rowUp + x + 2] + lumaByte[row + x + 1] + lumaByte[row + x + 2];
      const boxT =
        lumaByte[rowUp2 + x] + lumaByte[rowUp2 + x + 1] + lumaByte[rowUp + x] + lumaByte[rowUp + x + 1];
      const boxB =
        lumaByte[rowDn + x] + lumaByte[rowDn + x + 1] + lumaByte[rowDn2 + x] + lumaByte[rowDn2 + x + 1];
      const dH = boxR - boxL;
      const dV = boxB - boxT;
      const rawGrad = (dH < 0 ? -dH : dH) + (dV < 0 ? -dV : dV);
      sampleLap[sampleCount] = lap < 0 ? -lap : lap;
      sampleGrad[sampleCount] = rawGrad;
      gradHist[rawGrad] += 1;
      sampleCount += 1;
    }
  }

  let noiseSigma = 0.008;
  if (sampleCount >= 16) {
    const flatCount = Math.max(8, Math.floor(sampleCount * 0.45));
    let cutoffGrad = 2040;
    let prefixCount = 0;
    for (let g = 0; g <= 2040; g++) {
      if (prefixCount + gradHist[g] >= flatCount) {
        cutoffGrad = g;
        break;
      }
      prefixCount += gradHist[g];
    }
    let needAtCutoff = flatCount - prefixCount;
    let lapSum = 0;
    for (let k = 0; k < sampleCount; k++) {
      const g = sampleGrad[k];
      if (g < cutoffGrad) {
        lapSum += sampleLap[k];
      } else if (g === cutoffGrad && needAtCutoff > 0) {
        lapSum += sampleLap[k];
        needAtCutoff -= 1;
      }
    }
    const meanAbsLap = lapSum / flatCount;
    // Scale by sqrt(pi/2) / 6 to convert |K*I| mean to std dev in [0..1]
    noiseSigma = Math.max(0, Math.min(0.18, (meanAbsLap * 0.2089) / 255));
  }

  // Confidence-gated conservative Auto White Balance over neutral gray-zone reflectance
  let wbGains = [1, 1, 1];
  let wbConfidence = 0;
  const neutralFraction = wbEligibleCount > 24 ? neutralCount / wbEligibleCount : 0;
  if (neutralFraction >= 0.12 && neutralLinR > 1e-4 && neutralLinG > 1e-4 && neutralLinB > 1e-4) {
    const rMean = neutralLinR / neutralCount;
    const gMean = neutralLinG / neutralCount;
    const bMean = neutralLinB / neutralCount;
    const avgMean = (rMean + gMean + bMean) / 3;
    const rawR = avgMean / rMean;
    const rawG = avgMean / gMean;
    const rawB = avgMean / bMean;
    // Normalize relative to green and blend gently by neutral coverage confidence
    const normR = rawR / rawG;
    const normB = rawB / rawG;
    wbConfidence = Math.max(0, Math.min(1, (neutralFraction - 0.12) / 0.30));
    const strength = 0.58 * wbConfidence;
    const gR = Math.max(0.88, Math.min(1.14, 1 + (normR - 1) * strength));
    const gB = Math.max(0.88, Math.min(1.14, 1 + (normB - 1) * strength));
    wbGains = [Number(gR.toFixed(4)), 1.0, Number(gB.toFixed(4))];
  }

  return {
    noiseSigma: Number(noiseSigma.toFixed(5)),
    midtoneLuma: midLumaCount > 0 ? midLumaSum / (midLumaCount * 255) : p50,
    sceneMidLogL: Number(sceneMidLogL.toFixed(4)),
    p02,
    p10,
    p50,
    p90,
    p99,
    dynamicRangeEv: Number(dynamicRangeEv.toFixed(2)),
    shadowFraction: totalCount > 0 ? shadowCount / totalCount : 0,
    highlightFraction: totalCount > 0 ? highlightCount / totalCount : 0,
    clippedFraction: totalCount > 0 ? clippedCount / totalCount : 0,
    wbConfidence: Number(wbConfidence.toFixed(3)),
    wbGains,
  };
}

/**
 * Compute adaptive Pro ISP development parameters from scene statistics,
 * multi-frame merge count, stabilization mode, and user look profile.
 */
export function computeProDevelopProfile(
  sceneStats = null,
  {
    frameCount = 1,
    mergedCount = frameCount,
    stabilizationMode = STABILIZATION_MODES.HIGH,
    colorProfile = COLOR_PROFILES.NATURAL,
  } = {}
) {
  const stats = sceneStats || analyzeRgbaScene(null, 0, 0);
  const mode = normalizeStabilizationMode(stabilizationMode);
  const profile = normalizeColorProfile(colorProfile);
  const effectiveMerged = Math.max(1, Math.min(4, Number(mergedCount) || Number(frameCount) || 1));
  const noise = Math.max(0, Math.min(0.18, Number(stats.noiseSigma) || 0));

  // Highlight-safe auto exposure lift for genuinely dark frames without blowing bright areas
  const underexposed = Math.max(0, 0.34 - (stats.midtoneLuma ?? 0.42));
  const safeHiRoom = Math.max(0, 1 - (stats.clippedFraction ?? 0) * 16 - (stats.highlightFraction ?? 0) * 2.5);
  const autoExposureEv = Number(
    Math.max(0, Math.min(0.45, underexposed * 2.2 * safeHiRoom)).toFixed(3)
  );

  // Backlit / high dynamic range detection drives bilateral Local HDR dodge & burn
  const highDrFactor = Math.max(0, Math.min(1, ((stats.dynamicRangeEv ?? 4.5) - 3.0) / 5.0));
  const backlitMix =
    stats.shadowFraction > 0.14 && stats.highlightFraction > 0.06 ? 0.18 : 0;
  const localHdrStrength = Number(
    Math.max(0.24, Math.min(0.84, 0.28 + 0.42 * highDrFactor + backlitMix)).toFixed(3)
  );

  // Shadow toe lift balances shadow rescue against keeping clean darks anchored
  const shadowNeed = Math.max(
    0,
    Math.min(1, (stats.shadowFraction ?? 0.15) * 1.4 + Math.max(0, 0.38 - (stats.p50 ?? 0.42)) * 1.2)
  );
  const shadowLift = Number(Math.max(0.22, Math.min(0.76, 0.26 + 0.48 * shadowNeed)).toFixed(3));

  // Highlight roll-off responds to bright clouds / clipped regions
  const hiNeed = Math.max(
    0,
    Math.min(1, (stats.highlightFraction ?? 0.05) * 2.4 + (stats.clippedFraction ?? 0.005) * 10)
  );
  const highlightRoll = Number(Math.max(0.42, Math.min(0.9, 0.48 + 0.40 * hiNeed)).toFixed(3));

  // Clarity boosts micro-contrast softly, pulled back slightly on noisy high-ISO night shots
  const baseClarity = profile === COLOR_PROFILES.VIVID ? 0.16 : profile === COLOR_PROFILES.FILM ? 0.14 : 0.12;
  const clarity = Number(
    Math.max(0.04, Math.min(0.22, baseClarity + 0.04 * (1 - Math.min(1, noise * 22)))).toFixed(3)
  );

  // CAS sharpening boosted gently on multi-frame clean bursts, tempered gracefully when noise is high
  const baseSharpen = mode === STABILIZATION_MODES.HIGH ? 0.62 : 0.54;
  const mergeBonus = effectiveMerged >= 3 ? 0.06 : effectiveMerged >= 2 ? 0.03 : 0;
  const noisePenalty = Math.min(0.22, noise * 4.5);
  const sharpen = Number(Math.max(0.32, Math.min(0.74, baseSharpen + mergeBonus - noisePenalty)).toFixed(3));

  // Denoise strength adapts continuously to detected ISO noise
  const denoiseStrength = Number(
    Math.max(0.18, Math.min(1.0, 0.20 + Math.min(0.80, noise * 24))).toFixed(3)
  );

  // Patch tolerance adapts in perceptual YCoCg space to frame noise + stabilization strictness
  const basePatchTol2 = mode === STABILIZATION_MODES.OFF ? 0.0075 : 0.0016;
  const patchTol2 = Number((basePatchTol2 + Math.min(0.0016, noise * noise * 0.45)).toFixed(6));

  let vibrance = 0.14;
  let saturation = 1.02;
  let contrast = 1.04;
  let filmFade = 0.0;
  let warmth = 0.0;

  if (profile === COLOR_PROFILES.VIVID) {
    vibrance = 0.30;
    saturation = 1.12;
    contrast = 1.09;
  } else if (profile === COLOR_PROFILES.FILM) {
    vibrance = 0.06;
    saturation = 0.94;
    contrast = 1.06;
    filmFade = 0.014;
    warmth = 0.045;
  }

  return {
    colorProfile: profile,
    wbGains: Array.isArray(stats.wbGains) ? stats.wbGains : [1, 1, 1],
    noiseSigma: noise,
    sceneMidLogL: stats.sceneMidLogL ?? -2.4,
    autoExposureEv,
    localHdrStrength,
    shadowLift,
    highlightRoll,
    clarity,
    sharpen,
    denoiseStrength,
    patchTol2,
    vibrance,
    saturation,
    contrast,
    filmFade,
    warmth,
  };
}

/**
 * Convert tightly packed RGBA8 pixels to Rec.709 integer luminance [0..255].
 */
export function rgbaToLuma(rgbaData, width, height) {
  const len = width * height;
  const out = new Uint8Array(len);
  for (let i = 0, p = 0; i < len; i++, p += 4) {
    out[i] = (54 * rgbaData[p] + 183 * rgbaData[p + 1] + 19 * rgbaData[p + 2]) >> 8;
  }
  return out;
}

/**
 * Downsample luminance buffer with bilinear / box averaging for coarse pyramid levels.
 */
export function downsampleLuma(src, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const sy0 = Math.min(srcH - 1, Math.floor(y * scaleY));
    const sy1 = Math.min(srcH - 1, Math.max(sy0 + 1, Math.floor((y + 1) * scaleY)));
    for (let x = 0; x < dstW; x++) {
      const sx0 = Math.min(srcW - 1, Math.floor(x * scaleX));
      const sx1 = Math.min(srcW - 1, Math.max(sx0 + 1, Math.floor((x + 1) * scaleX)));
      let sum = 0;
      let count = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        const rowOffset = yy * srcW;
        for (let xx = sx0; xx < sx1; xx++) {
          sum += src[rowOffset + xx];
          count++;
        }
      }
      out[y * dstW + x] = count > 0 ? Math.round(sum / count) : src[sy0 * srcW + sx0];
    }
  }
  return out;
}

/**
 * Compute mean luminance, trimmed midtone luminance, and central Tenengrad + Laplacian sharpness score
 * to automatically select the sharpest reference frame and reject motion-blurred frames.
 */
export function analyzeFrameMetrics(luma, width, height) {
  if (!luma || width < 16 || height < 16) {
    return { sharpness: 0, meanLuma: 128, trimmedMeanLuma: 128 };
  }
  const marginX = Math.max(2, Math.floor(width * 0.12));
  const marginY = Math.max(2, Math.floor(height * 0.12));
  const xEnd = width - marginX;
  const yEnd = height - marginY;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 160));

  let edgeEnergySum = 0;
  let lumaSum = 0;
  let midLumaSum = 0;
  let midSamples = 0;
  let samples = 0;

  for (let y = marginY; y < yEnd; y += step) {
    const row = y * width;
    const rowUp = (y - 1) * width;
    const rowDn = (y + 1) * width;
    for (let x = marginX; x < xEnd; x += step) {
      const c = luma[row + x];
      const gx = luma[row + x + 1] - luma[row + x - 1];
      const gy = luma[rowDn + x] - luma[rowUp + x];
      const lap =
        4 * c - luma[row + x - 1] - luma[row + x + 1] - luma[rowUp + x] - luma[rowDn + x];
      edgeEnergySum += gx * gx + gy * gy + lap * lap * 0.5;
      lumaSum += c;
      if (c >= 18 && c <= 236) {
        midLumaSum += c;
        midSamples++;
      }
      samples++;
    }
  }

  const meanLuma = samples > 0 ? lumaSum / samples : 128;
  return {
    sharpness: samples > 0 ? Math.sqrt(edgeEnergySum / samples) : 0,
    meanLuma,
    trimmedMeanLuma: midSamples > 12 ? midLumaSum / midSamples : meanLuma,
  };
}

/**
 * Compute 2D corner-weighted local gradient energy around (cx, cy) so anchor patches
 * sit on true corners/endpoints rather than sliding along 1D periodic stripes.
 */
function computePatchGradient(luma, width, height, cx, cy, radius) {
  const x0 = Math.max(1, cx - radius);
  const y0 = Math.max(1, cy - radius);
  const x1 = Math.min(width - 2, cx + radius);
  const y1 = Math.min(height - 2, cy + radius);
  let gxSum = 0;
  let gySum = 0;
  let cnt = 0;
  for (let y = y0; y <= y1; y += 2) {
    const row = y * width;
    for (let x = x0; x <= x1; x += 2) {
      gxSum += Math.abs(luma[row + x + 1] - luma[row + x - 1]);
      gySum += Math.abs(luma[row + width + x] - luma[row - width + x]);
      cnt++;
    }
  }
  if (cnt <= 0) return 0;
  const minG = Math.min(gxSum, gySum);
  const maxG = Math.max(gxSum, gySum);
  return (minG * 2.2 + maxG * 0.25) / cnt;
}

/**
 * Measure resistance to periodic / 1D-stripe self-similarity ambiguity by checking
 * minimum ZSAD against small spatial shifts around (cx, cy).
 */
function computePatchUniqueness(luma, width, height, cx, cy, half = 8) {
  const margin = half + 12;
  if (cx < margin || cy < margin || cx + margin >= width || cy + margin >= height) {
    return 0.5;
  }
  const shifts = [
    [-9, 0],
    [9, 0],
    [-7, 0],
    [7, 0],
    [-5, 0],
    [5, 0],
    [0, -9],
    [0, 9],
    [0, -6],
    [0, 6],
  ];
  let minSelfDiff = Infinity;
  for (let s = 0; s < shifts.length; s++) {
    const sx = shifts[s][0];
    const sy = shifts[s][1];
    let sad = 0;
    let count = 0;
    for (let y = -half; y <= half; y += 3) {
      const rRow = (cy + y) * width + cx;
      const mRow = (cy + y + sy) * width + cx + sx;
      for (let x = -half; x <= half; x += 3) {
        const d = luma[mRow + x] - luma[rRow + x];
        sad += d < 0 ? -d : d;
        count++;
      }
    }
    const mean = count > 0 ? sad / count : 0;
    if (mean < minSelfDiff) minSelfDiff = mean;
  }
  return Math.max(0.15, Math.min(1.0, minSelfDiff / 16));
}

/**
 * Pick up to 9 well-distributed textured anchor points inside the safe inner region,
 * prioritizing distinct non-repeating 2D corners.
 */
export function selectAnchorPoints(luma, width, height) {
  const marginX = Math.max(18, Math.floor(width * 0.1));
  const marginY = Math.max(18, Math.floor(height * 0.1));
  const innerW = width - marginX * 2;
  const innerH = height - marginY * 2;
  if (innerW < 48 || innerH < 48) {
    return [{ cx: Math.floor(width / 2), cy: Math.floor(height / 2), grad: 10, uniqueness: 1 }];
  }

  const sectorW = Math.floor(innerW / 3);
  const sectorH = Math.floor(innerH / 3);
  const anchors = [];

  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const baseX = marginX + sx * sectorW;
      const baseY = marginY + sy * sectorH;
      let bestX = baseX + Math.floor(sectorW / 2);
      let bestY = baseY + Math.floor(sectorH / 2);
      let bestScore = -1;
      let bestGrad = 0;
      let bestUniq = 1;

      const stepX = Math.max(5, Math.floor(sectorW / 5));
      const stepY = Math.max(5, Math.floor(sectorH / 5));
      for (let py = baseY + Math.floor(stepY / 2); py < baseY + sectorH - 5; py += stepY) {
        for (let px = baseX + Math.floor(stepX / 2); px < baseX + sectorW - 5; px += stepX) {
          const g = computePatchGradient(luma, width, height, px, py, 10);
          if (g <= 0.5) continue;
          const uniq = g >= 2.0 ? computePatchUniqueness(luma, width, height, px, py) : 0.5;
          const score = g * uniq;
          if (score > bestScore) {
            bestScore = score;
            bestGrad = g;
            bestUniq = uniq;
            bestX = px;
            bestY = py;
          }
        }
      }
      anchors.push({
        cx: bestX,
        cy: bestY,
        grad: Math.max(0, bestGrad),
        uniqueness: bestUniq,
      });
    }
  }

  return anchors;
}

/**
 * Build a (width+1) x (height+1) Int32 summed-area table (integral image) for O(1) exact patch sums.
 */
function buildIntegralImage(luma, width, height) {
  const stride = width + 1;
  const sat = new Int32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    const srcRow = y * width;
    const prevRow = y * stride;
    const curRow = (y + 1) * stride;
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += luma[srcRow + x];
      sat[curRow + x + 1] = sat[prevRow + x + 1] + rowSum;
    }
  }
  return sat;
}

function rectSumIntegral(sat, width, x0, y0, x1, y1) {
  const stride = width + 1;
  const r0 = y0 * stride;
  const r1 = (y1 + 1) * stride;
  return sat[r1 + x1 + 1] - sat[r0 + x1 + 1] - sat[r1 + x0] + sat[r0 + x0];
}

function sumPatchSamples(plane, width, cx, cy, halfSize, stride) {
  let sum = 0;
  let count = 0;
  for (let dy = -halfSize; dy <= halfSize; dy += stride) {
    const row = (cy + dy) * width + cx;
    for (let dx = -halfSize; dx <= halfSize; dx += stride) {
      sum += plane[row + dx];
      count++;
    }
  }
  return { sum, count };
}

/**
 * Mean-removed Sum of Absolute Differences (ZSAD) for two patches within bounds.
 * Resistant to slight auto-exposure flicker across burst frames.
 * Optional precomputed refSum, movIntegral (stride===1), and sadLimit enable exact early exit.
 */
function computePatchZSAD(
  ref,
  refW,
  refH,
  refCx,
  refCy,
  mov,
  movW,
  movH,
  movCx,
  movCy,
  halfSize,
  stride = 1,
  refSumPre = -1,
  movIntegral = null,
  sadLimit = Infinity
) {
  const rx0 = refCx - halfSize;
  const ry0 = refCy - halfSize;
  const rx1 = refCx + halfSize;
  const ry1 = refCy + halfSize;
  const mx0 = movCx - halfSize;
  const my0 = movCy - halfSize;
  const mx1 = movCx + halfSize;
  const my1 = movCy + halfSize;

  if (
    rx0 < 0 ||
    ry0 < 0 ||
    rx1 >= refW ||
    ry1 >= refH ||
    mx0 < 0 ||
    my0 < 0 ||
    mx1 >= movW ||
    my1 >= movH
  ) {
    return Infinity;
  }

  let refSum = 0;
  let movSum = 0;
  let count = 0;

  if (stride === 1 && movIntegral && refSumPre >= 0) {
    const side = halfSize * 2 + 1;
    count = side * side;
    refSum = refSumPre;
    movSum = rectSumIntegral(movIntegral, movW, mx0, my0, mx1, my1);
  } else if (refSumPre >= 0) {
    refSum = refSumPre;
    for (let dy = -halfSize; dy <= halfSize; dy += stride) {
      const mRow = (movCy + dy) * movW + movCx;
      for (let dx = -halfSize; dx <= halfSize; dx += stride) {
        movSum += mov[mRow + dx];
        count++;
      }
    }
  } else {
    for (let dy = -halfSize; dy <= halfSize; dy += stride) {
      const rRow = (refCy + dy) * refW + refCx;
      const mRow = (movCy + dy) * movW + movCx;
      for (let dx = -halfSize; dx <= halfSize; dx += stride) {
        refSum += ref[rRow + dx];
        movSum += mov[mRow + dx];
        count++;
      }
    }
  }
  if (count === 0) return Infinity;
  const bias = Math.round((movSum - refSum) / count);

  let sad = 0;
  if (stride === 1) {
    const side = halfSize * 2 + 1;
    for (let dy = 0; dy < side; dy++) {
      const rRow = (ry0 + dy) * refW + rx0;
      const mRow = (my0 + dy) * movW + mx0;
      for (let dx = 0; dx < side; dx++) {
        const diff = mov[mRow + dx] - bias - ref[rRow + dx];
        sad += diff < 0 ? -diff : diff;
      }
      if (sad > sadLimit) return Infinity;
    }
  } else {
    for (let dy = -halfSize; dy <= halfSize; dy += stride) {
      const rRow = (refCy + dy) * refW + refCx;
      const mRow = (movCy + dy) * movW + movCx;
      for (let dx = -halfSize; dx <= halfSize; dx += stride) {
        const diff = mov[mRow + dx] - bias - ref[rRow + dx];
        sad += diff < 0 ? -diff : diff;
      }
      if (sad > sadLimit) return Infinity;
    }
  }
  return sad / count;
}

function fitParabolicSubpixel(eMinus, eZero, ePlus) {
  if (!Number.isFinite(eMinus) || !Number.isFinite(eZero) || !Number.isFinite(ePlus)) {
    return 0;
  }
  const denom = eMinus - 2 * eZero + ePlus;
  if (denom <= 1e-4) return 0;
  const offset = (0.5 * (eMinus - ePlus)) / denom;
  return Math.max(-0.5, Math.min(0.5, offset));
}

/**
 * Coarse-to-fine block match of a single patch around (initDx, initDy).
 */
function matchPatch(
  ref,
  refW,
  refH,
  refCx,
  refCy,
  mov,
  movW,
  movH,
  initDx,
  initDy,
  searchRadius,
  halfSize,
  priorWeight = 0,
  refIntegral = null,
  movIntegral = null
) {
  const rx0 = refCx - halfSize;
  const ry0 = refCy - halfSize;
  const rx1 = refCx + halfSize;
  const ry1 = refCy + halfSize;
  if (rx0 < 0 || ry0 < 0 || rx1 >= refW || ry1 >= refH) {
    return { valid: false, dx: Math.round(initDx), dy: Math.round(initDy), err: Infinity };
  }

  const baseDx = Math.round(initDx);
  const baseDy = Math.round(initDy);
  const step = searchRadius > 8 ? 2 : 1;
  const coarsePixelStride = searchRadius > 8 ? 2 : 1;

  const side = halfSize * 2 + 1;
  const fineCount = side * side;
  const refSumFine = refIntegral
    ? rectSumIntegral(refIntegral, refW, rx0, ry0, rx1, ry1)
    : sumPatchSamples(ref, refW, refCx, refCy, halfSize, 1).sum;

  let refSumCoarse = refSumFine;
  let coarseCount = fineCount;
  if (coarsePixelStride !== 1) {
    const cs = sumPatchSamples(ref, refW, refCx, refCy, halfSize, coarsePixelStride);
    refSumCoarse = cs.sum;
    coarseCount = cs.count;
  }

  let bestDx = baseDx;
  let bestDy = baseDy;
  let bestErr = computePatchZSAD(
    ref,
    refW,
    refH,
    refCx,
    refCy,
    mov,
    movW,
    movH,
    refCx + baseDx,
    refCy + baseDy,
    halfSize,
    coarsePixelStride,
    refSumCoarse,
    coarsePixelStride === 1 ? movIntegral : null,
    Infinity
  );
  let bestScore = bestErr;

  for (let dy = baseDy - searchRadius; dy <= baseDy + searchRadius; dy += step) {
    for (let dx = baseDx - searchRadius; dx <= baseDx + searchRadius; dx += step) {
      if (dx === baseDx && dy === baseDy) continue;
      const priorPenalty =
        priorWeight > 0 ? priorWeight * Math.hypot(dx - baseDx, dy - baseDy) : 0;
      const maxErrAllowed = bestScore - priorPenalty;
      if (maxErrAllowed <= 0) continue;
      const sadLimit = Number.isFinite(maxErrAllowed)
        ? maxErrAllowed * coarseCount + 2
        : Infinity;

      const err = computePatchZSAD(
        ref,
        refW,
        refH,
        refCx,
        refCy,
        mov,
        movW,
        movH,
        refCx + dx,
        refCy + dy,
        halfSize,
        coarsePixelStride,
        refSumCoarse,
        coarsePixelStride === 1 ? movIntegral : null,
        sadLimit
      );
      const score = err + priorPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestErr = err;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  if (!Number.isFinite(bestErr)) {
    return { valid: false, dx: baseDx, dy: baseDy, err: Infinity };
  }

  // Integer refinement +-1 around coarse match, caching the 3x3 error grid for subpixel interpolation
  let fineDx = bestDx;
  let fineDy = bestDy;
  let fineErr = Infinity;
  let fineScore = Infinity;
  const fineGrid = new Float64Array(9);

  for (let oy = -1; oy <= 1; oy++) {
    const dy = bestDy + oy;
    for (let ox = -1; ox <= 1; ox++) {
      const dx = bestDx + ox;
      const err = computePatchZSAD(
        ref,
        refW,
        refH,
        refCx,
        refCy,
        mov,
        movW,
        movH,
        refCx + dx,
        refCy + dy,
        halfSize,
        1,
        refSumFine,
        movIntegral,
        Infinity
      );
      fineGrid[(oy + 1) * 3 + (ox + 1)] = err;
      const score =
        priorWeight > 0 ? err + priorWeight * Math.hypot(dx - baseDx, dy - baseDy) : err;
      if (score < fineScore) {
        fineScore = score;
        fineErr = err;
        fineDx = dx;
        fineDy = dy;
      }
    }
  }

  if (!Number.isFinite(fineErr)) {
    return { valid: false, dx: baseDx, dy: baseDy, err: Infinity };
  }

  const evalFineAt = (dx, dy) => {
    const ox = dx - bestDx;
    const oy = dy - bestDy;
    if (ox >= -1 && ox <= 1 && oy >= -1 && oy <= 1) {
      return fineGrid[(oy + 1) * 3 + (ox + 1)];
    }
    return computePatchZSAD(
      ref,
      refW,
      refH,
      refCx,
      refCy,
      mov,
      movW,
      movH,
      refCx + dx,
      refCy + dy,
      halfSize,
      1,
      refSumFine,
      movIntegral,
      Infinity
    );
  };

  // Subpixel parabolic interpolation along X and Y independently
  const errLeft = evalFineAt(fineDx - 1, fineDy);
  const errRight = evalFineAt(fineDx + 1, fineDy);
  const errUp = evalFineAt(fineDx, fineDy - 1);
  const errDown = evalFineAt(fineDx, fineDy + 1);

  const subX = fitParabolicSubpixel(errLeft, fineErr, errRight);
  const subY = fitParabolicSubpixel(errUp, fineErr, errDown);

  return {
    valid: true,
    dx: fineDx + subX,
    dy: fineDy + subY,
    err: fineErr,
  };
}

/**
 * Solve 4x4 linear system Ax = b with partial pivoting.
 */
function solve4x4(mat, vec) {
  const a = [
    [mat[0][0], mat[0][1], mat[0][2], mat[0][3], vec[0]],
    [mat[1][0], mat[1][1], mat[1][2], mat[1][3], vec[1]],
    [mat[2][0], mat[2][1], mat[2][2], mat[2][3], vec[2]],
    [mat[3][0], mat[3][1], mat[3][2], mat[3][3], vec[3]],
  ];

  for (let col = 0; col < 4; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(a[col][col]);
    for (let r = col + 1; r < 4; r++) {
      const val = Math.abs(a[r][col]);
      if (val > pivotVal) {
        pivotVal = val;
        pivotRow = r;
      }
    }
    if (pivotVal < 1e-8) return null;
    if (pivotRow !== col) {
      const tmp = a[col];
      a[col] = a[pivotRow];
      a[pivotRow] = tmp;
    }

    const inv = 1 / a[col][col];
    for (let c = col; c < 5; c++) {
      a[col][c] *= inv;
    }
    for (let r = 0; r < 4; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      for (let c = col; c < 5; c++) {
        a[r][c] -= factor * a[col][c];
      }
    }
  }

  return [a[0][4], a[1][4], a[2][4], a[3][4]];
}

/**
 * Fit centered 4-DOF similarity transform:
 *   x' = a * x - b * y + tx
 *   y' = b * x + a * y + ty
 * where (x, y) are centered relative to (width/2, height/2).
 * Uses iterative reweighted least squares to discard moving foreground outliers.
 */
export function fitRobustSimilarity(
  pointPairs,
  width,
  height,
  { fallbackA = 1, fallbackB = 0 } = {}
) {
  if (!pointPairs || pointPairs.length === 0) {
    return { valid: false, a: fallbackA, b: fallbackB, tx: 0, ty: 0, residual: Infinity };
  }

  const cx = width * 0.5;
  const cy = height * 0.5;
  const scaleNorm = Math.max(width, height, 1);

  const computeWeightedShiftFallback = (aBase, bBase) => {
    let sumW = 0;
    let sumTx = 0;
    let sumTy = 0;
    const txVals = [];
    const tyVals = [];
    for (const p of pointPairs) {
      const w = p.weight ?? 1;
      const rx = p.refX - cx;
      const ry = p.refY - cy;
      const shiftX = p.movX - (cx + aBase * rx - bBase * ry);
      const shiftY = p.movY - (cy + bBase * rx + aBase * ry);
      txVals.push(shiftX);
      tyVals.push(shiftY);
      if (w > 1e-4) {
        sumW += w;
        sumTx += w * shiftX;
        sumTy += w * shiftY;
      }
    }
    if (sumW > 1e-4) {
      return { tx: sumTx / sumW, ty: sumTy / sumW };
    }
    txVals.sort((u, v) => u - v);
    tyVals.sort((u, v) => u - v);
    return {
      tx: txVals[Math.floor(txVals.length / 2)],
      ty: tyVals[Math.floor(tyVals.length / 2)],
    };
  };

  if (pointPairs.length === 1) {
    const p = pointPairs[0];
    const rx = p.refX - cx;
    const ry = p.refY - cy;
    return {
      valid: true,
      a: fallbackA,
      b: fallbackB,
      tx: p.movX - (cx + fallbackA * rx - fallbackB * ry),
      ty: p.movY - (cy + fallbackB * rx + fallbackA * ry),
      residual: p.err ?? 0,
    };
  }

  const weights = pointPairs.map((p) => p.weight ?? 1);
  let a = fallbackA;
  let b = fallbackB;
  let txN = 0;
  let tyN = 0;

  // Only attempt full 4-DOF fit with >= 3 non-collinear weighted points
  for (let iter = 0; iter < 3; iter++) {
    const m = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    const rhs = [0, 0, 0, 0];
    let activeCount = 0;
    let activeWeightSum = 0;

    for (let i = 0; i < pointPairs.length; i++) {
      const w = weights[i];
      if (w <= 1e-4) continue;
      activeCount++;
      activeWeightSum += w;
      const p = pointPairs[i];
      const x = (p.refX - cx) / scaleNorm;
      const y = (p.refY - cy) / scaleNorm;
      const xp = (p.movX - cx) / scaleNorm;
      const yp = (p.movY - cy) / scaleNorm;

      // Row 1: a * x - b * y + txN = xp  => [x, -y, 1, 0]
      // Row 2: b * x + a * y + tyN = yp  => [y,  x, 0, 1]
      const r1 = [x, -y, 1, 0];
      const r2 = [y, x, 0, 1];

      for (let r = 0; r < 4; r++) {
        rhs[r] += w * (r1[r] * xp + r2[r] * yp);
        for (let c = 0; c < 4; c++) {
          m[r][c] += w * (r1[r] * r1[c] + r2[r] * r2[c]);
        }
      }
    }

    // Weight-proportional Tikhonov regularization toward (fallbackA, fallbackB) to avoid scale/rotation drift on narrow clusters
    const reg = Math.max(1e-5, activeWeightSum * 0.0004);
    m[0][0] += reg;
    rhs[0] += reg * fallbackA;
    m[1][1] += reg;
    rhs[1] += reg * fallbackB;

    if (activeCount < 3) {
      const shift = computeWeightedShiftFallback(fallbackA, fallbackB);
      return {
        valid: true,
        a: fallbackA,
        b: fallbackB,
        tx: shift.tx,
        ty: shift.ty,
        residual: 0,
      };
    }

    const sol = solve4x4(m, rhs);
    if (!sol) {
      const shift = computeWeightedShiftFallback(fallbackA, fallbackB);
      return {
        valid: true,
        a: fallbackA,
        b: fallbackB,
        tx: shift.tx,
        ty: shift.ty,
        residual: 0,
      };
    }

    [a, b, txN, tyN] = sol;

    // Graduated Huber / Tukey IRLS reweighting so initial uncompensated roll doesn't prune valid anchors
    let residualSum = 0;
    let wSum = 0;
    const baseThreshPx = Math.max(1.8, scaleNorm * 0.0035);
    const threshPx =
      baseThreshPx * (iter === 0 ? 3.5 : iter === 1 ? 1.8 : 1.15);
    for (let i = 0; i < pointPairs.length; i++) {
      const p = pointPairs[i];
      const x = (p.refX - cx) / scaleNorm;
      const y = (p.refY - cy) / scaleNorm;
      const predX = cx + (a * x - b * y + txN) * scaleNorm;
      const predY = cy + (b * x + a * y + tyN) * scaleNorm;
      const errPx = Math.hypot(predX - p.movX, predY - p.movY);
      residualSum += errPx;
      wSum++;
      const baseW = p.weight ?? 1;
      weights[i] =
        errPx > threshPx * 2.5 ? 0 : baseW / (1 + (errPx / threshPx) * (errPx / threshPx));
    }

    if (iter === 2) {
      const tx = txN * scaleNorm;
      const ty = tyN * scaleNorm;
      const scale = Math.hypot(a, b);
      const angleDeg = (Math.atan2(b, a) * 180) / Math.PI;
      // Sanity check against unstable blowups
      if (scale < 0.92 || scale > 1.08 || Math.abs(angleDeg) > 6.5) {
        const shift = computeWeightedShiftFallback(fallbackA, fallbackB);
        return {
          valid: true,
          a: fallbackA,
          b: fallbackB,
          tx: shift.tx,
          ty: shift.ty,
          residual: wSum > 0 ? residualSum / wSum : 0,
        };
      }
      return {
        valid: true,
        a,
        b,
        tx,
        ty,
        residual: wSum > 0 ? residualSum / wSum : 0,
      };
    }
  }

  const shift = computeWeightedShiftFallback(fallbackA, fallbackB);
  return { valid: true, a: fallbackA, b: fallbackB, tx: shift.tx, ty: shift.ty, residual: 0 };
}

/**
 * Coarse-to-fine alignment on medium resolution luminance frames.
 * Coordinates returned in the `width x height` space of `refLuma` / `movLuma`.
 */
export function estimateSimilarityAlignment(
  refLuma,
  movLuma,
  width,
  height,
  { maxShiftRatio = 0.12, precomputedRef = null } = {}
) {
  // Level C: ~100px anti-aliased macro frame (suppresses repeating fine textures & avoids stride aliasing)
  const coarseScale =
    precomputedRef?.coarseScale ?? Math.max(1, Math.round(Math.max(width, height) / 100));
  const cW = precomputedRef?.cW ?? Math.max(24, Math.floor(width / coarseScale));
  const cH = precomputedRef?.cH ?? Math.max(24, Math.floor(height / coarseScale));
  const refC = precomputedRef?.refC ?? downsampleLuma(refLuma, width, height, cW, cH);
  const movC = downsampleLuma(movLuma, width, height, cW, cH);
  const movCIntegral = buildIntegralImage(movC, cW, cH);

  const coarseMaxShift = Math.max(
    4,
    Math.min(Math.floor(Math.min(cW, cH) * 0.24), Math.ceil(Math.max(cW, cH) * maxShiftRatio))
  );
  // Match wide inner region covering foreground, mid, and background features without skipping pixels
  const coarseHalfW = Math.max(6, Math.floor(cW * 0.28));
  const coarseHalfH = Math.max(6, Math.floor(cH * 0.28));
  const cCx = Math.floor(cW * 0.5);
  const cCy = Math.floor(cH * 0.5);

  const rx0C = cCx - coarseHalfW;
  const ry0C = cCy - coarseHalfH;
  const winW = coarseHalfW * 2 + 1;
  const winH = coarseHalfH * 2 + 1;
  const coarseCount = winW * winH;

  let refCSum = 0;
  for (let yy = 0; yy < winH; yy++) {
    const rRow = (ry0C + yy) * cW + rx0C;
    for (let xx = 0; xx < winW; xx++) {
      refCSum += refC[rRow + xx];
    }
  }

  const evalCoarseRect = (dx, dy, sadLimit = Infinity) => {
    const mx0 = rx0C + dx;
    const my0 = ry0C + dy;
    if (mx0 < 0 || my0 < 0 || mx0 + winW > cW || my0 + winH > cH) return Infinity;
    const movSum = rectSumIntegral(movCIntegral, cW, mx0, my0, mx0 + winW - 1, my0 + winH - 1);
    const bias = Math.round((movSum - refCSum) / coarseCount);
    let sad = 0;
    for (let yy = 0; yy < winH; yy++) {
      const rRow = (ry0C + yy) * cW + rx0C;
      const mRow = (my0 + yy) * cW + mx0;
      for (let xx = 0; xx < winW; xx++) {
        const d = movC[mRow + xx] - bias - refC[rRow + xx];
        sad += d < 0 ? -d : d;
      }
      if (sad > sadLimit) return Infinity;
    }
    return sad / coarseCount;
  };

  const coarseStep = coarseMaxShift > 18 ? 2 : 1;
  let bestCoarseDx = 0;
  let bestCoarseDy = 0;
  let bestCoarseErr = evalCoarseRect(0, 0, Infinity);
  for (let dy = -coarseMaxShift; dy <= coarseMaxShift; dy += coarseStep) {
    for (let dx = -coarseMaxShift; dx <= coarseMaxShift; dx += coarseStep) {
      if (dx === 0 && dy === 0) continue;
      const limit = Number.isFinite(bestCoarseErr) ? bestCoarseErr * coarseCount + 2 : Infinity;
      const e = evalCoarseRect(dx, dy, limit);
      if (e < bestCoarseErr) {
        bestCoarseErr = e;
        bestCoarseDx = dx;
        bestCoarseDy = dy;
      }
    }
  }
  let fineCoarseDx = bestCoarseDx;
  let fineCoarseDy = bestCoarseDy;
  let fineCoarseErr = bestCoarseErr;
  if (coarseStep > 1 && Number.isFinite(bestCoarseErr)) {
    for (let dy = bestCoarseDy - 1; dy <= bestCoarseDy + 1; dy++) {
      for (let dx = bestCoarseDx - 1; dx <= bestCoarseDx + 1; dx++) {
        const limit = Number.isFinite(fineCoarseErr) ? fineCoarseErr * coarseCount + 2 : Infinity;
        const e = evalCoarseRect(dx, dy, limit);
        if (e < fineCoarseErr) {
          fineCoarseErr = e;
          fineCoarseDx = dx;
          fineCoarseDy = dy;
        }
      }
    }
  }
  const coarseCenterMatch = {
    valid: Number.isFinite(fineCoarseErr),
    dx:
      fineCoarseDx +
      fitParabolicSubpixel(
        evalCoarseRect(fineCoarseDx - 1, fineCoarseDy),
        fineCoarseErr,
        evalCoarseRect(fineCoarseDx + 1, fineCoarseDy)
      ),
    dy:
      fineCoarseDy +
      fitParabolicSubpixel(
        evalCoarseRect(fineCoarseDx, fineCoarseDy - 1),
        fineCoarseErr,
        evalCoarseRect(fineCoarseDx, fineCoarseDy + 1)
      ),
    err: fineCoarseErr,
  };

  const initDx = coarseCenterMatch.valid ? coarseCenterMatch.dx * (width / cW) : 0;
  const initDy = coarseCenterMatch.valid ? coarseCenterMatch.dy * (height / cH) : 0;

  // Stage 2: multi-anchor fine matching on medium luminance frame
  let effectiveAnchors = precomputedRef?.effectiveAnchors || null;
  if (!effectiveAnchors) {
    const allAnchors = selectAnchorPoints(refLuma, width, height);
    const filtered = allAnchors.filter((a) => a.grad >= 2.0);
    effectiveAnchors = filtered.length ? filtered : allAnchors;
  }

  const refIntegral = precomputedRef?.refIntegral ?? buildIntegralImage(refLuma, width, height);
  const movIntegral = buildIntegralImage(movLuma, width, height);

  const halfPatch = Math.max(10, Math.min(18, Math.floor(Math.min(width, height) * 0.045)));
  const pass1Search = Math.max(6, Math.min(10, Math.ceil(coarseScale) + 3));

  const matchedPairs1 = [];
  for (const anchor of effectiveAnchors) {
    const uniq = anchor.uniqueness ?? 1;
    const pw1 = uniq < 0.7 ? 0.28 : 0.08;
    const m = matchPatch(
      refLuma,
      width,
      height,
      anchor.cx,
      anchor.cy,
      movLuma,
      width,
      height,
      initDx,
      initDy,
      pass1Search,
      halfPatch,
      pw1,
      refIntegral,
      movIntegral
    );
    if (m.valid && m.err < 42) {
      matchedPairs1.push({
        refX: anchor.cx,
        refY: anchor.cy,
        movX: anchor.cx + m.dx,
        movY: anchor.cy + m.dy,
        err: m.err,
        grad: anchor.grad,
        weight:
          (Math.max(0.1, Math.min(3.0, anchor.grad / 12)) * uniq * uniq) /
          (1 + m.err * 0.08),
      });
    }
  }

  if (!matchedPairs1.length) {
    // Low-texture scene (e.g., blank dark room): use coarse translation with soft confidence
    const coarseResidual = coarseCenterMatch.valid ? coarseCenterMatch.err : 50;
    return {
      valid: coarseResidual < 28,
      a: 1,
      b: 0,
      tx: initDx,
      ty: initDy,
      residual: coarseResidual,
      anchorsUsed: 0,
      anchors: effectiveAnchors,
    };
  }

  const fit1 = fitRobustSimilarity(matchedPairs1, width, height);

  // Pass 2: re-center each anchor search window around fit1's rotated similarity prediction
  const cx = width * 0.5;
  const cy = height * 0.5;
  const pass2Search = Math.max(5, Math.min(7, Math.ceil(coarseScale)));
  const matchedPairs2 = [];
  for (const anchor of effectiveAnchors) {
    const uniq = anchor.uniqueness ?? 1;
    const pw2 = uniq < 0.7 ? 0.22 : 0.08;
    const rx = anchor.cx - cx;
    const ry = anchor.cy - cy;
    const predDx = cx + fit1.a * rx - fit1.b * ry + fit1.tx - anchor.cx;
    const predDy = cy + fit1.b * rx + fit1.a * ry + fit1.ty - anchor.cy;
    const m = matchPatch(
      refLuma,
      width,
      height,
      anchor.cx,
      anchor.cy,
      movLuma,
      width,
      height,
      predDx,
      predDy,
      pass2Search,
      halfPatch,
      pw2,
      refIntegral,
      movIntegral
    );
    if (m.valid && m.err < 38) {
      matchedPairs2.push({
        refX: anchor.cx,
        refY: anchor.cy,
        movX: anchor.cx + m.dx,
        movY: anchor.cy + m.dy,
        err: m.err,
        grad: anchor.grad,
        weight:
          (Math.max(0.1, Math.min(3.0, anchor.grad / 12)) * uniq * uniq) /
          (1 + m.err * 0.08),
      });
    }
  }

  const activePairs = matchedPairs2.length >= 2 ? matchedPairs2 : matchedPairs1;
  const fit = matchedPairs2.length >= 2 ? fitRobustSimilarity(activePairs, width, height) : fit1;

  // Compute trimmed inlier ZSAD residual across matched pairs using fitted similarity transform
  const zsadValues = [];
  for (const pair of activePairs) {
    const px = pair.refX - cx;
    const py = pair.refY - cy;
    const mx = Math.round(cx + fit.a * px - fit.b * py + fit.tx);
    const my = Math.round(cy + fit.b * px + fit.a * py + fit.ty);
    const rx0 = pair.refX - halfPatch;
    const ry0 = pair.refY - halfPatch;
    const refSumPre =
      rx0 >= 0 && ry0 >= 0 && pair.refX + halfPatch < width && pair.refY + halfPatch < height
        ? rectSumIntegral(refIntegral, width, rx0, ry0, pair.refX + halfPatch, pair.refY + halfPatch)
        : -1;
    const e = computePatchZSAD(
      refLuma,
      width,
      height,
      pair.refX,
      pair.refY,
      movLuma,
      width,
      height,
      mx,
      my,
      halfPatch,
      1,
      refSumPre,
      movIntegral,
      Infinity
    );
    zsadValues.push(Number.isFinite(e) ? e : pair.err);
  }
  zsadValues.sort((u, v) => u - v);
  const inlierCount = Math.max(1, Math.min(zsadValues.length, Math.ceil(zsadValues.length * 0.78)));
  let zsadSum = 0;
  for (let i = 0; i < inlierCount; i++) {
    zsadSum += zsadValues[i];
  }
  const meanZsad = zsadSum / inlierCount;

  return {
    valid: meanZsad < 26,
    a: fit.a,
    b: fit.b,
    tx: fit.tx,
    ty: fit.ty,
    residual: meanZsad,
    anchorsUsed: activePairs.length,
    anchors: effectiveAnchors,
  };
}

/**
 * Refine medium-resolution similarity alignment onto full sensor resolution (srcW x srcH)
 * using small extracted patches around top textured anchors.
 *
 * extractPatchFn(frameIndex, centerX, centerY, patchSize, angleRad, invScale) -> Uint8Array luminance
 */
export function refineAlignmentWithNativePatches({
  refIndex,
  movIndex,
  srcW,
  srcH,
  medW,
  medH,
  medAlign,
  anchors = [],
  extractPatchFn,
  extractPatchesBatchFn = null,
  patchSize = 84,
  refPatchCache = null,
}) {
  const rx = srcW / medW;
  const ry = srcH / medH;
  const fullAlign = {
    valid: medAlign.valid,
    a: medAlign.a,
    b: medAlign.b,
    tx: medAlign.tx * rx,
    ty: medAlign.ty * ry,
    residual: medAlign.residual,
  };

  if (
    !fullAlign.valid ||
    (typeof extractPatchFn !== 'function' && typeof extractPatchesBatchFn !== 'function') ||
    Math.max(rx, ry) <= 1.15 ||
    !anchors.length
  ) {
    return fullAlign;
  }

  const cx = srcW * 0.5;
  const cy = srcH * 0.5;
  const theta = Math.atan2(fullAlign.b, fullAlign.a);
  const scale = Math.hypot(fullAlign.a, fullAlign.b) || 1;
  const halfSearch = 7;
  const innerHalf = Math.floor((patchSize - halfSearch * 2 - 4) / 2);
  if (innerHalf < 12) return fullAlign;

  // Pick up to 5 highest-scoring non-periodic 2D anchors within safe margins
  const margin = Math.ceil(patchSize * 0.65);
  const candidateAnchors = anchors
    .slice()
    .sort((u, v) => {
      const su = (u.grad || 0) * ((u.uniqueness ?? 1) * (u.uniqueness ?? 1));
      const sv = (v.grad || 0) * ((v.uniqueness ?? 1) * (v.uniqueness ?? 1));
      return sv - su;
    })
    .map((anc) => ({
      refX: Math.round(anc.cx * rx),
      refY: Math.round(anc.cy * ry),
      grad: anc.grad || 0,
    }))
    .filter(
      (p) =>
        p.refX >= margin &&
        p.refX <= srcW - margin &&
        p.refY >= margin &&
        p.refY <= srcH - margin
    )
    .slice(0, 5);

  const validItems = [];
  for (const anc of candidateAnchors) {
    const relX = anc.refX - cx;
    const relY = anc.refY - cy;
    const predX = cx + fullAlign.a * relX - fullAlign.b * relY + fullAlign.tx;
    const predY = cy + fullAlign.b * relX + fullAlign.a * relY + fullAlign.ty;

    if (
      predX < margin ||
      predX > srcW - margin ||
      predY < margin ||
      predY > srcH - margin
    ) {
      continue;
    }
    validItems.push({ anc, predX, predY, cacheKey: `${anc.refX},${anc.refY},${patchSize}` });
  }

  // Batch all uncached reference patches + moving patches into one GPU readPixels when available
  const batchedMovPatches = new Array(validItems.length).fill(null);
  if (typeof extractPatchesBatchFn === 'function' && validItems.length > 0) {
    const batchReqs = [];
    const reqMeta = [];
    for (let idx = 0; idx < validItems.length; idx++) {
      const item = validItems[idx];
      if (!refPatchCache?.get(item.cacheKey)) {
        batchReqs.push({
          frameIdx: refIndex,
          centerX: item.anc.refX,
          centerY: item.anc.refY,
          angleRad: 0,
          srcScale: 1,
        });
        reqMeta.push({ kind: 'ref', idx, cacheKey: item.cacheKey });
      }
      batchReqs.push({
        frameIdx: movIndex,
        centerX: item.predX,
        centerY: item.predY,
        angleRad: theta,
        srcScale: scale,
      });
      reqMeta.push({ kind: 'mov', idx });
    }
    const batchLumas = extractPatchesBatchFn(batchReqs, patchSize);
    if (Array.isArray(batchLumas) && batchLumas.length === batchReqs.length) {
      for (let k = 0; k < reqMeta.length; k++) {
        const luma = batchLumas[k];
        if (!luma) continue;
        const meta = reqMeta[k];
        if (meta.kind === 'ref') {
          const entry = {
            patch: luma,
            integral: buildIntegralImage(luma, patchSize, patchSize),
          };
          if (refPatchCache) {
            refPatchCache.set(meta.cacheKey, entry);
          } else {
            validItems[meta.idx].localRefEntry = entry;
          }
        } else {
          batchedMovPatches[meta.idx] = luma;
        }
      }
    }
  }

  const pairs = [];
  const pMid = Math.floor(patchSize / 2);

  for (let idx = 0; idx < validItems.length; idx++) {
    const { anc, predX, predY, cacheKey, localRefEntry } = validItems[idx];
    let refEntry = refPatchCache?.get(cacheKey) || localRefEntry || null;
    if (!refEntry && typeof extractPatchFn === 'function') {
      const refPatch = extractPatchFn(refIndex, anc.refX, anc.refY, patchSize, 0, 1);
      if (!refPatch) continue;
      refEntry = {
        patch: refPatch,
        integral: buildIntegralImage(refPatch, patchSize, patchSize),
      };
      if (refPatchCache) {
        refPatchCache.set(cacheKey, refEntry);
      }
    }
    if (!refEntry) continue;

    // Extract mov patch pre-derotated around predicted position so residual search is pure translation
    const movPatch =
      batchedMovPatches[idx] ||
      (typeof extractPatchFn === 'function'
        ? extractPatchFn(movIndex, predX, predY, patchSize, theta, scale)
        : null);
    if (!movPatch) continue;
    const movIntegral = buildIntegralImage(movPatch, patchSize, patchSize);

    const delta = matchPatch(
      refEntry.patch,
      patchSize,
      patchSize,
      pMid,
      pMid,
      movPatch,
      patchSize,
      patchSize,
      0,
      0,
      halfSearch,
      innerHalf,
      0,
      refEntry.integral,
      movIntegral
    );

    if (delta.valid && delta.err < 36) {
      // Rotate local residual delta back from derotated patch space into native mov frame space
      const worldDx = fullAlign.a * delta.dx - fullAlign.b * delta.dy;
      const worldDy = fullAlign.b * delta.dx + fullAlign.a * delta.dy;
      pairs.push({
        refX: anc.refX,
        refY: anc.refY,
        movX: predX + worldDx,
        movY: predY + worldDy,
        err: delta.err,
        weight: Math.max(0.15, Math.min(3.0, anc.grad / 10)) / (1 + delta.err * 0.08),
      });
    }
  }

  if (pairs.length >= 1) {
    const refined = fitRobustSimilarity(pairs, srcW, srcH, {
      fallbackA: fullAlign.a,
      fallbackB: fullAlign.b,
    });
    const zsadMean = pairs.reduce((s, p) => s + p.err, 0) / pairs.length;
    return {
      valid: zsadMean < 28,
      a: refined.a,
      b: refined.b,
      tx: refined.tx,
      ty: refined.ty,
      residual: zsadMean,
    };
  }

  return fullAlign;
}

/**
 * Convert a pixel-space centered similarity transform (ref -> mov)
 * into normalized UV-space 2x2 matrix + shift for WebGL shader lookup:
 *   movUv.x = m00 * refUv.x + m01 * refUv.y + sx
 *   movUv.y = m10 * refUv.x + m11 * refUv.y + sy
 */
export function similarityToUvMatrix(align, width, height) {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const a = align?.a ?? 1;
  const b = align?.b ?? 0;
  const tx = align?.tx ?? 0;
  const ty = align?.ty ?? 0;

  const aspectHW = safeH / safeW;
  const aspectWH = safeW / safeH;

  const m00 = a;
  const m01 = -b * aspectHW;
  const m10 = b * aspectWH;
  const m11 = a;

  const sx = tx / safeW + 0.5 * (1 - a) + 0.5 * b * aspectHW;
  const sy = ty / safeH - 0.5 * b * aspectWH + 0.5 * (1 - a);

  return {
    mat: [m00, m01, m10, m11],
    shift: [sx, sy],
  };
}

/**
 * Compute conservative inward normalized crop insets so the output stays
 * cleanly inside the common overlap of all stabilized burst frames.
 */
export function computeStabilizedSafeCrop(
  alignments,
  width,
  height,
  { maxInsetRatio = 0.045 } = {}
) {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const maxInset = Math.max(0, Math.min(0.1, Number(maxInsetRatio) || 0));
  if (maxInset <= 0 || !Array.isArray(alignments) || alignments.length <= 1) {
    return { left: 0, right: 0, top: 0, bottom: 0, insetX: 0, insetY: 0 };
  }

  let insetLeft = 0;
  let insetRight = 0;
  let insetTop = 0;
  let insetBottom = 0;

  for (const al of alignments) {
    if (!al || !al.valid || (al.weight ?? 0) <= 0) continue;
    const { mat, shift } = similarityToUvMatrix(al, safeW, safeH);
    const det = mat[0] * mat[3] - mat[1] * mat[2];
    if (Math.abs(det) < 1e-6) continue;

    // Conservative inner safe margin from ref-corner overshoot in mov UV space
    const cornersRef = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    for (const [ru, rv] of cornersRef) {
      const mu = mat[0] * ru + mat[1] * rv + shift[0];
      const mv = mat[2] * ru + mat[3] * rv + shift[1];
      if (ru < 0.5 && mu < 0) insetLeft = Math.max(insetLeft, -mu);
      if (ru > 0.5 && mu > 1) insetRight = Math.max(insetRight, mu - 1);
      if (rv < 0.5 && mv < 0) insetTop = Math.max(insetTop, -mv);
      if (rv > 0.5 && mv > 1) insetBottom = Math.max(insetBottom, mv - 1);
    }
  }

  const insetX = Math.min(maxInset, Math.max(insetLeft, insetRight) + 0.002);
  const insetY = Math.min(maxInset, Math.max(insetTop, insetBottom) + 0.002);

  return {
    left: Math.min(maxInset, insetLeft),
    right: Math.min(maxInset, insetRight),
    top: Math.min(maxInset, insetTop),
    bottom: Math.min(maxInset, insetBottom),
    insetX: insetLeft > 0 || insetRight > 0 ? insetX : 0,
    insetY: insetTop > 0 || insetBottom > 0 ? insetY : 0,
  };
}

/**
 * Full burst orchestration helper:
 * 1) Scores sharpness of each captured frame and picks the sharpest reference frame
 * 2) Aligns other frames to the reference (coarse-to-fine similarity + optional native patch refine)
 * 3) Rejects blurry or misaligned frames to guarantee ghost-free output
 * 4) Computes UV matrices, exposure gain equalization, and optional EIS border crop
 */
export function buildBurstAlignmentPlan({
  lumaFrames,
  medW,
  medH,
  srcW,
  srcH,
  stabilizationMode = STABILIZATION_MODES.HIGH,
  extractPatchFn = null,
  extractPatchesBatchFn = null,
  maxFrames = 4,
  noiseSigma = 0.012,
  precomputedMetrics = null,
}) {
  const mode = normalizeStabilizationMode(stabilizationMode);
  const total = lumaFrames.length;
  if (total === 0) {
    return { refIndex: 0, selectedIndices: [], entries: [], safeCrop: { insetX: 0, insetY: 0 } };
  }

  const metrics =
    Array.isArray(precomputedMetrics) && precomputedMetrics.length === total
      ? precomputedMetrics
      : lumaFrames.map((luma) => analyzeFrameMetrics(luma, medW, medH));

  // Pick sharpest non-trivial frame as reference
  let refIndex = 0;
  let bestSharpness = metrics[0].sharpness;
  for (let i = 1; i < total; i++) {
    if (metrics[i].sharpness > bestSharpness) {
      bestSharpness = metrics[i].sharpness;
      refIndex = i;
    }
  }

  // If stabilization is explicitly OFF (e.g., locked tripod test), keep original order and identity alignments
  if (mode === STABILIZATION_MODES.OFF || total === 1) {
    const selectedIndices = lumaFrames.slice(0, maxFrames).map((_, idx) => idx);
    return {
      refIndex: 0,
      selectedIndices,
      entries: selectedIndices.map((idx) => ({
        frameIndex: idx,
        valid: true,
        a: 1,
        b: 0,
        tx: 0,
        ty: 0,
        residual: 0,
        weight: 1,
        lumaGain: 1,
        angleDeg: 0,
        uvMatrix: similarityToUvMatrix({ a: 1, b: 0, tx: 0, ty: 0 }, srcW, srcH),
      })),
      safeCrop: { insetX: 0, insetY: 0, left: 0, right: 0, top: 0, bottom: 0 },
      metrics,
    };
  }

  // When capturing extra burst frames (e.g., 5 frames for HIGH stabilization), shed the weakest
  // tap-shaken or exposure-drifted non-reference frame(s) before running expensive alignment.
  const preExcluded = new Set();
  if (total > maxFrames) {
    const sortedLumas = metrics
      .map((m) => m.trimmedMeanLuma ?? m.meanLuma ?? 128)
      .sort((a, b) => a - b);
    const medianLuma = sortedLumas[Math.floor(sortedLumas.length / 2)] || 128;

    const scoredNonRef = [];
    for (let i = 0; i < total; i++) {
      if (i === refIndex) continue;
      const m = metrics[i];
      const lumaDiff = Math.abs((m.trimmedMeanLuma ?? m.meanLuma ?? medianLuma) - medianLuma);
      const exposureConsistency = Math.max(0.76, 1 - Math.max(0, lumaDiff - 8) / 90);
      const tapWeight = i === 0 ? 0.985 : 1.0;
      scoredNonRef.push({
        index: i,
        weightedScore: m.sharpness * exposureConsistency * tapWeight,
      });
    }
    scoredNonRef.sort((u, v) => u.weightedScore - v.weightedScore);
    const dropCount = total - maxFrames;
    for (let d = 0; d < dropCount && d < scoredNonRef.length; d++) {
      preExcluded.add(scoredNonRef[d].index);
    }
  }

  const refLuma = lumaFrames[refIndex];
  const refMetric = metrics[refIndex];
  const refMidLuma = refMetric.trimmedMeanLuma ?? refMetric.meanLuma;
  const minSharpRatio = mode === STABILIZATION_MODES.HIGH ? 0.72 : 0.65;
  const noisePad = Math.min(8, Math.round((Number(noiseSigma) || 0) * 255 * 0.45));
  const maxResidualReject = (mode === STABILIZATION_MODES.HIGH ? 20 : 25) + noisePad;

  // Precompute reference coarse pyramid, anchors, integral image, and native patch cache once across all burst frames
  const coarseScale = Math.max(1, Math.round(Math.max(medW, medH) / 100));
  const cW = Math.max(24, Math.floor(medW / coarseScale));
  const cH = Math.max(24, Math.floor(medH / coarseScale));
  const allAnchors = selectAnchorPoints(refLuma, medW, medH);
  const filteredAnchors = allAnchors.filter((a) => a.grad >= 2.0);
  const precomputedRef = {
    coarseScale,
    cW,
    cH,
    refC: downsampleLuma(refLuma, medW, medH, cW, cH),
    effectiveAnchors: filteredAnchors.length ? filteredAnchors : allAnchors,
    refIntegral: buildIntegralImage(refLuma, medW, medH),
  };
  const refPatchCache = new Map();

  const candidates = [];
  for (let i = 0; i < total; i++) {
    if (i === refIndex) continue;

    const sharpRatio =
      bestSharpness > 1e-4 ? metrics[i].sharpness / bestSharpness : 1.0;

    if (preExcluded.has(i) || sharpRatio < minSharpRatio) {
      candidates.push({
        frameIndex: i,
        valid: false,
        rejectedReason: preExcluded.has(i) ? 'pre-filter' : 'motion-blur',
        sharpRatio,
        a: 1,
        b: 0,
        tx: 0,
        ty: 0,
        residual: Infinity,
        weight: 0,
        lumaGain: 1,
        angleDeg: 0,
      });
      continue;
    }

    const medAlign = estimateSimilarityAlignment(refLuma, lumaFrames[i], medW, medH, {
      maxShiftRatio: mode === STABILIZATION_MODES.HIGH ? 0.14 : 0.1,
      precomputedRef,
    });

    const nativeAlign = refineAlignmentWithNativePatches({
      refIndex,
      movIndex: i,
      srcW,
      srcH,
      medW,
      medH,
      medAlign,
      anchors: medAlign.anchors,
      extractPatchFn,
      extractPatchesBatchFn,
      refPatchCache,
    });

    const residual = nativeAlign.residual ?? 99;
    const shiftPx = Math.hypot(nativeAlign.tx, nativeAlign.ty);
    const maxShiftAllowed = Math.max(srcW, srcH) * (mode === STABILIZATION_MODES.HIGH ? 0.14 : 0.1);
    const isValid =
      Boolean(nativeAlign.valid) &&
      residual <= maxResidualReject &&
      shiftPx <= maxShiftAllowed;

    const conf = isValid
      ? Math.max(
          0,
          Math.min(
            1,
            sharpRatio * Math.exp(-Math.max(0, residual - (2.5 + noisePad * 0.25)) / 14)
          )
        )
      : 0;

    const movMidLuma = metrics[i].trimmedMeanLuma ?? metrics[i].meanLuma;
    const lumaGain =
      movMidLuma > 6 && refMidLuma > 6
        ? Math.max(0.82, Math.min(1.22, refMidLuma / movMidLuma))
        : 1.0;

    candidates.push({
      frameIndex: i,
      valid: isValid && conf >= 0.25,
      rejectedReason: !isValid ? 'misaligned' : conf < 0.25 ? 'low-confidence' : null,
      sharpRatio,
      a: nativeAlign.a,
      b: nativeAlign.b,
      tx: nativeAlign.tx,
      ty: nativeAlign.ty,
      residual,
      weight: isValid && conf >= 0.25 ? conf : 0,
      lumaGain,
      angleDeg: Number(((Math.atan2(nativeAlign.b, nativeAlign.a) * 180) / Math.PI).toFixed(2)),
    });
  }

  // Sort candidates by highest confidence / lowest alignment residual
  const adopted = candidates
    .filter((c) => c.valid)
    .sort((u, v) => v.weight - u.weight || u.residual - v.residual)
    .slice(0, Math.max(0, maxFrames - 1));

  const refEntry = {
    frameIndex: refIndex,
    valid: true,
    a: 1,
    b: 0,
    tx: 0,
    ty: 0,
    residual: 0,
    weight: 1,
    lumaGain: 1,
    angleDeg: 0,
    uvMatrix: similarityToUvMatrix({ a: 1, b: 0, tx: 0, ty: 0 }, srcW, srcH),
  };

  const alignedEntries = [
    refEntry,
    ...adopted.map((entry) => ({
      ...entry,
      uvMatrix: similarityToUvMatrix(entry, srcW, srcH),
    })),
  ];

  const safeCrop =
    mode === STABILIZATION_MODES.HIGH && alignedEntries.length > 1
      ? computeStabilizedSafeCrop(alignedEntries, srcW, srcH, { maxInsetRatio: 0.042 })
      : { insetX: 0, insetY: 0, left: 0, right: 0, top: 0, bottom: 0 };

  return {
    refIndex,
    selectedIndices: alignedEntries.map((e) => e.frameIndex),
    entries: alignedEntries,
    safeCrop,
    metrics,
    rejectedCount: total - alignedEntries.length,
  };
}

/**
 * Symmetrically shrink source crop window by stabilization inset while preserving
 * exact output dimensions and aspect ratio.
 */
export function applyStabilizedInsetToCrop(crop, safeCrop) {
  const inset = Math.max(0, Math.min(0.08, Math.max(safeCrop?.insetX || 0, safeCrop?.insetY || 0)));
  if (inset <= 0) return crop;
  const factor = 1 - 2 * inset;
  const nextSw = Math.max(2, Math.round(crop.sw * factor));
  const nextSh = Math.max(2, Math.round(crop.sh * factor));
  const nextSx = crop.sx + Math.round((crop.sw - nextSw) / 2);
  const nextSy = crop.sy + Math.round((crop.sh - nextSh) / 2);
  return {
    ...crop,
    sx: nextSx,
    sy: nextSy,
    sw: nextSw,
    sh: nextSh,
  };
}

/**
 * Draw an aligned burst frame onto a destination canvas cropped to `crop` in reference coordinates.
 */
export function drawAlignedFrameToCanvas(ctx, bitmap, crop, mirrorX, alignEntry, outW, outH) {
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const a = alignEntry?.a ?? 1;
  const b = alignEntry?.b ?? 0;
  const tx = alignEntry?.tx ?? 0;
  const ty = alignEntry?.ty ?? 0;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) {
    ctx.imageSmoothingQuality = 'high';
  }

  const scaleX = outW / crop.sw;
  const scaleY = outH / crop.sh;
  if (mirrorX) {
    ctx.translate(outW, 0);
    ctx.scale(-1, 1);
  }
  ctx.scale(scaleX, scaleY);
  ctx.translate(-crop.sx, -crop.sy);

  // Align mov bitmap into reference pixel coordinates via inverse similarity transform
  if (Math.abs(a - 1) > 1e-5 || Math.abs(b) > 1e-5 || Math.abs(tx) > 0.05 || Math.abs(ty) > 0.05) {
    const cx = srcW * 0.5;
    const cy = srcH * 0.5;
    const s = Math.hypot(a, b) || 1;
    const theta = Math.atan2(b, a);
    ctx.translate(cx, cy);
    ctx.scale(1 / s, 1 / s);
    ctx.rotate(-theta);
    ctx.translate(-cx - tx, -cy - ty);
  }

  ctx.drawImage(bitmap, 0, 0, srcW, srcH);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * Analyze a single ImageBitmap on a lightweight probe canvas to collect noise, WB, and DR telemetry.
 */
export function analyzeBitmapScene(bitmap, createCanvas, { gpuSession = null, frameIndex = 0 } = {}) {
  if (!bitmap || !bitmap.width || !bitmap.height) {
    return analyzeRgbaScene(null, 0, 0);
  }
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const probeLong = Math.min(240, Math.max(srcW, srcH));
  const scale = probeLong / Math.max(srcW, srcH);
  const probeW = Math.max(24, Math.round(srcW * scale));
  const probeH = Math.max(24, Math.round(srcH * scale));
  if (gpuSession && typeof gpuSession.downsampleRgba === 'function') {
    const rgba = gpuSession.downsampleRgba(frameIndex, probeW, probeH);
    if (rgba) {
      return analyzeRgbaScene(rgba, probeW, probeH);
    }
  }
  if (typeof createCanvas !== 'function') {
    return analyzeRgbaScene(null, 0, 0);
  }
  const canvas = createCanvas(probeW, probeH);
  // Keep GPU-accelerated 2D context so high-res ImageBitmap downscales on GPU before reading tiny probe pixels
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, srcW, srcH, 0, 0, probeW, probeH);
  const imgData = ctx.getImageData(0, 0, probeW, probeH);
  canvas.width = 1;
  canvas.height = 1;
  return analyzeRgbaScene(imgData.data, probeW, probeH);
}

/**
 * Align captured ImageBitmaps / frames using medium luminance pyramids plus native-scale patch refinement,
 * and analyze the sharpest reference frame for Pro ISP tone/noise/WB parameters.
 */
export function alignBitmapBurst({
  frames,
  stabilizationMode = STABILIZATION_MODES.HIGH,
  colorProfile = COLOR_PROFILES.NATURAL,
  createCanvas,
  maxFrames = 4,
  gpuSession = null,
}) {
  const mode = normalizeStabilizationMode(stabilizationMode);
  const safeProfile = normalizeColorProfile(colorProfile);
  const srcW = frames[0]?.width || 1;
  const srcH = frames[0]?.height || 1;
  const hasGpuSampler = Boolean(
    gpuSession &&
      typeof gpuSession.downsampleRgba === 'function' &&
      typeof gpuSession.extractPatchRgba === 'function'
  );

  if (
    frames.length <= 1 ||
    mode === STABILIZATION_MODES.OFF ||
    (!hasGpuSampler && typeof createCanvas !== 'function')
  ) {
    const sceneStats = analyzeBitmapScene(frames[0], createCanvas, {
      gpuSession: hasGpuSampler ? gpuSession : null,
      frameIndex: 0,
    });
    const basePlan = buildBurstAlignmentPlan({
      lumaFrames: frames.map(() => new Uint8Array(0)),
      medW: 16,
      medH: 16,
      srcW,
      srcH,
      stabilizationMode: mode,
      maxFrames,
      noiseSigma: sceneStats.noiseSigma,
    });
    const mergedCount = basePlan.selectedIndices.length || 1;
    return {
      ...basePlan,
      sceneStats,
      developProfile: computeProDevelopProfile(sceneStats, {
        frameCount: frames.length,
        mergedCount,
        stabilizationMode: mode,
        colorProfile: safeProfile,
      }),
    };
  }

  const medLong = Math.min(560, Math.max(srcW, srcH));
  const scale = medLong / Math.max(srcW, srcH);
  const medW = Math.max(64, Math.round(srcW * scale));
  const medH = Math.max(64, Math.round(srcH * scale));

  let medCanvas = null;
  let medCtx = null;
  if (!hasGpuSampler) {
    medCanvas = createCanvas(medW, medH);
    // Avoid willReadFrequently:true when drawing full-res GPU ImageBitmaps so downscaling runs on GPU
    medCtx = medCanvas.getContext('2d');
  }
  const lumaFrames = [];
  const metrics = [];
  let bestSharpness = -1;
  let refRgba = null;

  const batchedRgbas =
    hasGpuSampler && typeof gpuSession.downsampleAllRgba === 'function'
      ? gpuSession.downsampleAllRgba(medW, medH)
      : null;

  for (let i = 0; i < frames.length; i++) {
    let rgba = batchedRgbas?.[i] || null;
    if (!rgba && hasGpuSampler) {
      rgba = gpuSession.downsampleRgba(i, medW, medH);
    }
    if (!rgba) {
      if (!medCanvas) {
        medCanvas = createCanvas(medW, medH);
        medCtx = medCanvas.getContext('2d');
      }
      medCtx.setTransform(1, 0, 0, 1, 0, 0);
      medCtx.clearRect(0, 0, medW, medH);
      medCtx.drawImage(frames[i], 0, 0, srcW, srcH, 0, 0, medW, medH);
      rgba = medCtx.getImageData(0, 0, medW, medH).data;
    }
    const luma = rgbaToLuma(rgba, medW, medH);
    const frameMetrics = analyzeFrameMetrics(luma, medW, medH);
    lumaFrames.push(luma);
    metrics.push(frameMetrics);
    if (frameMetrics.sharpness > bestSharpness) {
      bestSharpness = frameMetrics.sharpness;
      refRgba = rgba;
    }
  }
  if (medCanvas) {
    medCanvas.width = 1;
    medCanvas.height = 1;
  }

  // Analyze only the sharpest reference frame once (reused for both noise padding and Pro ISP developProfile)
  const sceneStats = analyzeRgbaScene(refRgba, medW, medH);
  refRgba = null;

  let patchCanvas = null;
  let patchCtx = null;
  const extractPatchesBatchFn =
    hasGpuSampler && typeof gpuSession.extractPatchesBatch === 'function'
      ? (requests, patchSize) => {
          const rgbaPatches = gpuSession.extractPatchesBatch(requests, patchSize);
          if (!Array.isArray(rgbaPatches)) return null;
          return rgbaPatches.map((rgba) => (rgba ? rgbaToLuma(rgba, patchSize, patchSize) : null));
        }
      : null;
  const extractPatchFn = (frameIdx, centerX, centerY, patchSize, angleRad = 0, srcScale = 1) => {
    const bmp = frames[frameIdx];
    if (!bmp) return null;
    if (hasGpuSampler) {
      const gpuPatch = gpuSession.extractPatchRgba(
        frameIdx,
        centerX,
        centerY,
        patchSize,
        angleRad,
        srcScale
      );
      if (gpuPatch) {
        return rgbaToLuma(gpuPatch, patchSize, patchSize);
      }
    }
    if (typeof createCanvas !== 'function') return null;
    if (!patchCanvas || patchCanvas.width !== patchSize) {
      patchCanvas = createCanvas(patchSize, patchSize);
      // Avoid willReadFrequently:true so extracting an 84x84 crop from a 12MP GPU bitmap never downloads the full 48MB frame
      patchCtx = patchCanvas.getContext('2d');
    }
    const half = patchSize * 0.5;
    const r = Math.ceil(patchSize * 0.9 * (srcScale || 1));
    const sx = Math.max(0, Math.floor(centerX - r));
    const sy = Math.max(0, Math.floor(centerY - r));
    const sx1 = Math.min(srcW, Math.ceil(centerX + r));
    const sy1 = Math.min(srcH, Math.ceil(centerY + r));
    const sw = Math.max(1, sx1 - sx);
    const sh = Math.max(1, sy1 - sy);

    patchCtx.setTransform(1, 0, 0, 1, 0, 0);
    patchCtx.clearRect(0, 0, patchSize, patchSize);
    patchCtx.translate(half, half);
    if (srcScale && Math.abs(srcScale - 1) > 1e-4) {
      patchCtx.scale(1 / srcScale, 1 / srcScale);
    }
    if (angleRad && Math.abs(angleRad) > 1e-4) {
      patchCtx.rotate(-angleRad);
    }
    patchCtx.translate(-centerX, -centerY);
    patchCtx.drawImage(bmp, sx, sy, sw, sh, sx, sy, sw, sh);
    patchCtx.setTransform(1, 0, 0, 1, 0, 0);

    const pData = patchCtx.getImageData(0, 0, patchSize, patchSize);
    return rgbaToLuma(pData.data, patchSize, patchSize);
  };

  const plan = buildBurstAlignmentPlan({
    lumaFrames,
    medW,
    medH,
    srcW,
    srcH,
    stabilizationMode: mode,
    extractPatchFn,
    extractPatchesBatchFn,
    maxFrames,
    noiseSigma: sceneStats.noiseSigma,
    precomputedMetrics: metrics,
  });

  if (patchCanvas) {
    patchCanvas.width = 1;
    patchCanvas.height = 1;
  }

  const developProfile = computeProDevelopProfile(sceneStats, {
    frameCount: frames.length,
    mergedCount: plan.selectedIndices?.length || 1,
    stabilizationMode: mode,
    colorProfile: safeProfile,
  });

  return {
    ...plan,
    sceneStats,
    developProfile,
  };
}

export function summarizeAlignmentPlan(plan, totalCaptured, stabilizationMode) {
  const mode = normalizeStabilizationMode(stabilizationMode);
  if (!plan || !Array.isArray(plan.entries) || totalCaptured <= 1 || mode === STABILIZATION_MODES.OFF) {
    return {
      mode,
      totalFrames: totalCaptured,
      adoptedFrames: Math.min(totalCaptured, plan?.selectedIndices?.length || totalCaptured),
      refIndex: plan?.refIndex ?? 0,
      maxShiftPx: 0,
      maxAngleDeg: 0,
    };
  }

  let maxShiftPx = 0;
  let maxAngleDeg = 0;
  for (const e of plan.entries) {
    const s = Math.hypot(e.tx || 0, e.ty || 0);
    if (s > maxShiftPx) maxShiftPx = s;
    const a = Math.abs(e.angleDeg || 0);
    if (a > maxAngleDeg) maxAngleDeg = a;
  }

  return {
    mode,
    totalFrames: totalCaptured,
    adoptedFrames: plan.selectedIndices.length,
    refIndex: plan.refIndex,
    maxShiftPx: Number(maxShiftPx.toFixed(1)),
    maxAngleDeg: Number(maxAngleDeg.toFixed(2)),
  };
}


