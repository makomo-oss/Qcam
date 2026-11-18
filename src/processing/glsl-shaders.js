/**
 * Pro-level 5-pass linear-light Computational Photography ISP shaders (GLSL ES 1.00).
 * Compatible with both WebGL2 (native RGBA16F float FBOs) and WebGL1 / packed RGBA8 fallback
 * (`#define USE_PACKED_HDR 1`) across Mobile GPUs, Desktop, and OffscreenCanvas Workers.
 *
 * Pipeline stages:
 *   Pass 1  (MERGE_FRAGMENT_SHADER): 5-tap Catmull-Rom Bicubic + linear-light conversion +
 *           Poisson-noise & sqrt-YCoCg 5-tap patch ghost rejection + temporal coverage map
 *   Pass 2a (LUM_DOWNSAMPLE_FRAGMENT_SHADER): 5-tap stratified log2 luminance map (<=160px)
 *   Pass 2b (LUM_BILATERAL_FRAGMENT_SHADER): Separable 13-tap edge-preserving bilateral filter
 *   Pass 3  (DENOISE_FRAGMENT_SHADER): Temporal-coverage-adaptive Joint Bilateral filter in sqrt-YCoCg
 *   Pass 4  (TONEMAP_FRAGMENT_SHADER): Linear WB + highlight-safe auto exposure + halo-free
 *           bilateral Local HDR & Clarity + AgX-style highlight path-to-white + Look profiles
 *   Pass 5  (OUTPUT_CAS_FRAGMENT_SHADER): 8-neighbor AMD FidelityFX-style Contrast-Adaptive
 *           Sharpening + Triangular-PDF Interleaved Gradient Noise dithering
 */

export function buildShaderSource(body, { packedHdr = false } = {}) {
  const prefix = packedHdr ? '#define USE_PACKED_HDR 1\n' : '';
  return `${prefix}${body}`;
}

const COMMON_HDR_GLSL = `
  vec3 srgbToLinear(vec3 c) {
    vec3 safe = max(c, vec3(0.0));
    vec3 low = safe / 12.92;
    vec3 high = pow((safe + 0.055) / 1.055, vec3(2.4));
    return mix(low, high, step(vec3(0.04045), safe));
  }

  vec3 linearToSrgb(vec3 c) {
    vec3 safe = clamp(c, 0.0, 1.0);
    vec3 low = safe * 12.92;
    vec3 high = 1.055 * pow(max(safe, vec3(1e-6)), vec3(1.0 / 2.4)) - 0.055;
    return clamp(mix(low, high, step(vec3(0.0031308), safe)), 0.0, 1.0);
  }

  float getLinearLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  // Variance-stabilized sqrt-YCoCg transform (Poisson shot noise -> ~uniform variance)
  vec3 linToSqrtYCoCg(vec3 lin) {
    vec3 p = sqrt(max(lin, vec3(0.0)));
    float Y  = 0.25 * (p.r + 2.0 * p.g + p.b);
    float Co = 0.5  * (p.r - p.b);
    float Cg = 0.25 * (-p.r + 2.0 * p.g - p.b);
    return vec3(Y, Co, Cg);
  }

  vec3 sqrtYCoCgToLin(vec3 ycc) {
    float tmp = ycc.x - ycc.z;
    vec3 p = max(vec3(tmp + ycc.y, ycc.x + ycc.z, tmp - ycc.y), vec3(0.0));
    return p * p;
  }

  vec4 encodeHdr(vec4 linCov) {
    #ifdef USE_PACKED_HDR
      return vec4(sqrt(clamp(linCov.rgb / 1.25, 0.0, 1.0)), clamp(linCov.a, 0.0, 1.0));
    #else
      return vec4(max(linCov.rgb, vec3(0.0)), clamp(linCov.a, 0.0, 1.0));
    #endif
  }

  vec4 decodeHdr(vec4 texel) {
    #ifdef USE_PACKED_HDR
      vec3 s = clamp(texel.rgb, 0.0, 1.0);
      return vec4(s * s * 1.25, clamp(texel.a, 0.0, 1.0));
    #else
      return vec4(max(texel.rgb, vec3(0.0)), clamp(texel.a, 0.0, 1.0));
    #endif
  }

  float encodeLogLum(float logLum) {
    #ifdef USE_PACKED_HDR
      return clamp((logLum + 10.0) / 12.0, 0.0, 1.0);
    #else
      return logLum;
    #endif
  }

  float decodeLogLum(float encoded) {
    #ifdef USE_PACKED_HDR
      return encoded * 12.0 - 10.0;
    #else
      return encoded;
    #endif
  }
`;

export const VERTEX_SHADER_SOURCE = `
  attribute vec2 aPosition;
  attribute vec2 aTexCoord;

  uniform vec4 uCropRect;   // (sx/W, sy/H, sw/W, sh/H) in normalized [0..1]
  uniform float uMirrorX;   // 1.0 to mirror horizontally, 0.0 normal

  varying vec2 vTexCoord;

  void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    float u = uMirrorX > 0.5 ? (1.0 - aTexCoord.x) : aTexCoord.x;
    vTexCoord = vec2(
      uCropRect.x + u * uCropRect.z,
      uCropRect.y + aTexCoord.y * uCropRect.w
    );
  }
`;

export const PASSTHROUGH_VERTEX_SHADER = `
  attribute vec2 aPosition;

  varying vec2 vTexCoord;

  void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    vTexCoord = aPosition * 0.5 + 0.5;
  }
`;

/**
 * Pass 1: Subpixel burst merge in linear light with 5-tap Catmull-Rom resampling,
 * Poisson+read-noise calibrated sqrt-YCoCg 5-tap structural ghost rejection,
 * and temporal coverage tracking.
 */
export const MERGE_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uFrame0;
  uniform sampler2D uFrame1;
  uniform sampler2D uFrame2;
  uniform sampler2D uFrame3;

  uniform float uFrameCount;        // 1.0 .. 4.0
  uniform vec2 uTexelSize;          // (1.0 / srcW, 1.0 / srcH)
  uniform float uUseBicubic0;       // 1.0 when zoomed/scaled, 0.0 on 1:1 native grid

  uniform vec4 uAlignMat1;
  uniform vec2 uAlignShift1;
  uniform vec4 uAlignMat2;
  uniform vec2 uAlignShift2;
  uniform vec4 uAlignMat3;
  uniform vec2 uAlignShift3;

  uniform vec3 uFrameWeights;       // Confidence weights for frames 1, 2, 3
  uniform vec3 uFrameGains;         // sRGB exposure ratio multipliers (converted to linear inside)
  uniform float uPatchTol2;         // Perceptual sqrt-YCoCg patch MSE tolerance
  uniform float uNoiseSigma;        // Estimated flat-region noise sigma [0..0.18]
  uniform float uPreMergedCoverage; // >= 0.0 when CPU pre-merged frames, else -1.0

  varying vec2 vTexCoord;

  ${COMMON_HDR_GLSL}

  vec2 mapAlignUv(vec2 uv, vec4 m, vec2 s) {
    return vec2(
      m.x * uv.x + m.y * uv.y + s.x,
      m.z * uv.x + m.w * uv.y + s.y
    );
  }

  bool inSafeBounds(vec2 uv, vec2 margin) {
    return uv.x >= margin.x && uv.x <= (1.0 - margin.x) &&
           uv.y >= margin.y && uv.y <= (1.0 - margin.y);
  }

  vec3 sampleBicubic5(sampler2D tex, vec2 uv, vec2 texelSize) {
    vec2 texSize = 1.0 / max(texelSize, vec2(1e-6));
    vec2 samplePos = uv * texSize;
    vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
    vec2 f = samplePos - texPos1;

    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);

    vec2 w12 = w1 + w2;
    vec2 offset12 = w2 / max(w12, vec2(1e-5));
    vec2 halfPx = 0.5 * texelSize;
    vec2 texPos0 = clamp((texPos1 - 1.0) * texelSize, halfPx, 1.0 - halfPx);
    vec2 texPos3 = clamp((texPos1 + 2.0) * texelSize, halfPx, 1.0 - halfPx);
    vec2 texPos12 = clamp((texPos1 + offset12) * texelSize, halfPx, 1.0 - halfPx);

    vec3 res = vec3(0.0);
    res += texture2D(tex, vec2(texPos12.x, texPos0.y)).rgb * (w12.x * w0.y);
    res += texture2D(tex, vec2(texPos0.x, texPos12.y)).rgb * (w0.x * w12.y);
    res += texture2D(tex, vec2(texPos12.x, texPos12.y)).rgb * (w12.x * w12.y);
    res += texture2D(tex, vec2(texPos3.x, texPos12.y)).rgb * (w3.x * w12.y);
    res += texture2D(tex, vec2(texPos12.x, texPos3.y)).rgb * (w12.x * w3.y);
    float wSum = w12.x * w0.y + (w0.x + w12.x + w3.x) * w12.y + w12.x * w3.y;
    return clamp(res / max(wSum, 1e-5), 0.0, 1.0);
  }

  vec3 pToYCoCg(vec3 p) {
    float Y  = 0.25 * (p.r + 2.0 * p.g + p.b);
    float Co = 0.5  * (p.r - p.b);
    float Cg = 0.25 * (-p.r + 2.0 * p.g - p.b);
    return vec3(Y, Co, Cg);
  }

  // Fast pow-free variance-stabilized approximation to sqrt(srgbToLinear(s) * gainLin)
  vec3 fastSrgbToSqrtYCoCg(vec3 srgb, float sqrtGain) {
    vec3 p = srgb * (0.81 + 0.19 * srgb) * sqrtGain;
    return pToYCoCg(min(p, vec3(1.12)));
  }

  float ycErr2(vec3 a, vec3 b) {
    vec3 d = a - b;
    return d.x * d.x + 0.38 * (d.y * d.y + d.z * d.z);
  }

  vec4 evaluateAlignedSample(
    sampler2D frameTex,
    vec2 uvk,
    vec2 dx,
    vec2 dy,
    float frameConf,
    float gainSrgb,
    vec3 yc0,
    vec3 yc0N,
    vec3 yc0S,
    vec3 yc0W,
    vec3 yc0E,
    float tol2
  ) {
    vec2 margin = uTexelSize * 1.5;
    if (frameConf <= 0.01 || !inSafeBounds(uvk, margin)) {
      return vec4(0.0);
    }

    float gainLin = abs(gainSrgb - 1.0) > 0.005 ? pow(max(gainSrgb, 0.05), 2.2) : 1.0;
    float sqrtGain = abs(gainSrgb - 1.0) > 0.005 ? sqrt(gainLin) : 1.0;
    vec3 linC = clamp(srgbToLinear(sampleBicubic5(frameTex, uvk, uTexelSize)) * gainLin, 0.0, 1.25);

    vec3 ycC = linToSqrtYCoCg(linC);
    vec3 ycN = fastSrgbToSqrtYCoCg(texture2D(frameTex, clamp(uvk - dy, 0.0, 1.0)).rgb, sqrtGain);
    vec3 ycS = fastSrgbToSqrtYCoCg(texture2D(frameTex, clamp(uvk + dy, 0.0, 1.0)).rgb, sqrtGain);
    vec3 ycW = fastSrgbToSqrtYCoCg(texture2D(frameTex, clamp(uvk - dx, 0.0, 1.0)).rgb, sqrtGain);
    vec3 ycE = fastSrgbToSqrtYCoCg(texture2D(frameTex, clamp(uvk + dx, 0.0, 1.0)).rgb, sqrtGain);

    float patchErr2 = (
      ycErr2(yc0, ycC) * 2.0 +
      ycErr2(yc0N, ycN) +
      ycErr2(yc0S, ycS) +
      ycErr2(yc0W, ycW) +
      ycErr2(yc0E, ycE)
    ) / 6.0;

    float ratio = patchErr2 / max(tol2, 1e-5);
    float w = exp(-ratio * 1.4) * smoothstep(2.2, 0.65, ratio) * frameConf;
    return vec4(linC * w, w);
  }

  void main() {
    vec2 safeUv = clamp(vTexCoord, 0.0, 1.0);
    vec3 p0Srgb = uUseBicubic0 > 0.5
      ? sampleBicubic5(uFrame0, safeUv, uTexelSize)
      : texture2D(uFrame0, safeUv).rgb;
    vec3 lin0 = srgbToLinear(p0Srgb);

    if (uFrameCount < 1.5) {
      float singleCov = uPreMergedCoverage >= 0.0 ? clamp(uPreMergedCoverage, 0.0, 1.0) : 0.0;
      gl_FragColor = encodeHdr(vec4(lin0, singleCov));
      return;
    }

    vec2 dx = vec2(uTexelSize.x, 0.0);
    vec2 dy = vec2(0.0, uTexelSize.y);

    vec3 yc0  = linToSqrtYCoCg(lin0);
    vec3 yc0N = fastSrgbToSqrtYCoCg(texture2D(uFrame0, clamp(safeUv - dy, 0.0, 1.0)).rgb, 1.0);
    vec3 yc0S = fastSrgbToSqrtYCoCg(texture2D(uFrame0, clamp(safeUv + dy, 0.0, 1.0)).rgb, 1.0);
    vec3 yc0W = fastSrgbToSqrtYCoCg(texture2D(uFrame0, clamp(safeUv - dx, 0.0, 1.0)).rgb, 1.0);
    vec3 yc0E = fastSrgbToSqrtYCoCg(texture2D(uFrame0, clamp(safeUv + dx, 0.0, 1.0)).rgb, 1.0);

    float localEdge2 = 0.25 * (
      ycErr2(yc0, yc0N) + ycErr2(yc0, yc0S) + ycErr2(yc0, yc0W) + ycErr2(yc0, yc0E)
    );
    float noiseVar = max(uNoiseSigma * uNoiseSigma, 0.00018) * (0.45 + 1.15 * yc0.x);
    float tol2 = uPatchTol2 + noiseVar + 0.045 * localEdge2;

    vec3 accumLin = lin0;
    float totalW = 1.0;

    vec2 uv1 = mapAlignUv(safeUv, uAlignMat1, uAlignShift1);
    vec4 s1 = evaluateAlignedSample(
      uFrame1, uv1, dx, dy, uFrameWeights.x, uFrameGains.x,
      yc0, yc0N, yc0S, yc0W, yc0E, tol2
    );
    accumLin += s1.rgb;
    totalW += s1.a;

    if (uFrameCount > 2.5) {
      vec2 uv2 = mapAlignUv(safeUv, uAlignMat2, uAlignShift2);
      vec4 s2 = evaluateAlignedSample(
        uFrame2, uv2, dx, dy, uFrameWeights.y, uFrameGains.y,
        yc0, yc0N, yc0S, yc0W, yc0E, tol2
      );
      accumLin += s2.rgb;
      totalW += s2.a;
    }

    if (uFrameCount > 3.5) {
      vec2 uv3 = mapAlignUv(safeUv, uAlignMat3, uAlignShift3);
      vec4 s3 = evaluateAlignedSample(
        uFrame3, uv3, dx, dy, uFrameWeights.z, uFrameGains.z,
        yc0, yc0N, yc0S, yc0W, yc0E, tol2
      );
      accumLin += s3.rgb;
      totalW += s3.a;
    }

    vec3 mergedLin = accumLin / max(totalW, 1.0);
    float coverage = uPreMergedCoverage >= 0.0
      ? clamp(uPreMergedCoverage, 0.0, 1.0)
      : clamp((totalW - 1.0) / 3.0, 0.0, 1.0);

    gl_FragColor = encodeHdr(vec4(mergedLin, coverage));
  }
`;

/**
 * Pass 2a: Stratified 5-tap log2 luminance downsample to <= 160px grid.
 */
export const LUM_DOWNSAMPLE_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uHdrTex;
  uniform vec2 uLumTexelSize; // (1.0 / lumW, 1.0 / lumH)

  varying vec2 vTexCoord;

  ${COMMON_HDR_GLSL}

  float sampleLogLumaAt(vec2 uv) {
    vec3 lin = decodeHdr(texture2D(uHdrTex, clamp(uv, 0.0, 1.0))).rgb;
    float y = clamp(getLinearLuma(lin), 1e-4, 4.0);
    return log2(y);
  }

  void main() {
    vec2 stepUv = uLumTexelSize * 0.35;
    float logSum =
      sampleLogLumaAt(vTexCoord) * 0.40 +
      sampleLogLumaAt(vTexCoord + vec2(-stepUv.x, -stepUv.y)) * 0.15 +
      sampleLogLumaAt(vTexCoord + vec2( stepUv.x, -stepUv.y)) * 0.15 +
      sampleLogLumaAt(vTexCoord + vec2(-stepUv.x,  stepUv.y)) * 0.15 +
      sampleLogLumaAt(vTexCoord + vec2( stepUv.x,  stepUv.y)) * 0.15;

    gl_FragColor = vec4(encodeLogLum(logSum), 0.0, 0.0, 1.0);
  }
`;

/**
 * Pass 2b: Separable 13-tap edge-preserving bilateral filter on log2 luminance pyramid.
 */
export const LUM_BILATERAL_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uLumTex;
  uniform vec2 uDirection; // (1.0 / lumW, 0.0) or (0.0, 1.0 / lumH)

  varying vec2 vTexCoord;

  ${COMMON_HDR_GLSL}

  void main() {
    float centerLog = decodeLogLum(texture2D(uLumTex, vTexCoord).r);
    float sum = centerLog;
    float wSum = 1.0;

    const float invRangeVar = 1.0 / (2.0 * 1.15 * 1.15);
    const float invSpatialVar = 1.0 / (2.0 * 3.2 * 3.2);

    for (int i = -6; i <= 6; i++) {
      if (i == 0) continue;
      vec2 uv = clamp(vTexCoord + uDirection * float(i), 0.0, 1.0);
      float sampleLog = decodeLogLum(texture2D(uLumTex, uv).r);
      float dLog = sampleLog - centerLog;
      float w = exp(-float(i * i) * invSpatialVar - (dLog * dLog) * invRangeVar);
      sum += sampleLog * w;
      wSum += w;
    }

    gl_FragColor = vec4(encodeLogLum(sum / max(wSum, 1e-4)), 0.0, 0.0, 1.0);
  }
`;

/**
 * Pass 3: Coverage-adaptive Joint Bilateral Denoiser in sqrt-YCoCg linear space.
 */
export const DENOISE_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uHdrTex;
  uniform vec2 uTexelSize;         // (1.0 / outW, 1.0 / outH)
  uniform float uNoiseSigma;       // Estimated sensor noise std dev [0..0.18]
  uniform float uDenoiseStrength;  // Adaptive multiplier [0.18..1.0]

  varying vec2 vTexCoord;

  ${COMMON_HDR_GLSL}

  void accumDenoiseTap(
    vec2 offsetPx,
    float spatialW,
    vec3 yc0,
    float lumaSigma,
    float invLumaVar,
    float invGuideVar,
    float invChromaVar,
    inout float sumY,
    inout float wSumY,
    inout vec2 sumC,
    inout float wSumC
  ) {
    vec2 uv = clamp(vTexCoord + offsetPx * uTexelSize, 0.0, 1.0);
    vec3 ycN = linToSqrtYCoCg(decodeHdr(texture2D(uHdrTex, uv)).rgb);
    float dY = ycN.x - yc0.x;
    vec2 dC = ycN.yz - yc0.yz;
    float dY2 = dY * dY;
    float dc2 = dot(dC, dC);

    if (lumaSigma > 0.0001) {
      float wY = spatialW * exp(-dY2 * invLumaVar - dc2 * 120.0);
      sumY += ycN.x * wY;
      wSumY += wY;
    }

    float wC = spatialW * exp(-dY2 * invGuideVar - dc2 * invChromaVar);
    sumC += ycN.yz * wC;
    wSumC += wC;
  }

  void main() {
    vec4 rawCenter = texture2D(uHdrTex, vTexCoord);
    vec3 centerLin = decodeHdr(rawCenter).rgb;
    float coverage = clamp(rawCenter.a, 0.0, 1.0);

    float tempScale = mix(1.0, 0.48, coverage);
    float effSigma = uNoiseSigma * uDenoiseStrength * tempScale;

    if (effSigma <= 0.0018) {
      gl_FragColor = encodeHdr(vec4(centerLin, coverage));
      return;
    }

    float lumaSigma = clamp(max(0.0, effSigma - 0.004) * 1.35, 0.0, 0.048);
    float chromaSigma = clamp(effSigma * 2.4, 0.003, 0.095);
    float invLumaVar = lumaSigma > 0.0001 ? 1.0 / (2.0 * lumaSigma * lumaSigma) : 1e6;
    float invChromaVar = 1.0 / (2.0 * chromaSigma * chromaSigma);
    float invGuideVar = 1.0 / max(2.0 * 0.022 * 0.022 + 0.35 * lumaSigma * lumaSigma, 1e-5);

    vec3 yc0 = linToSqrtYCoCg(centerLin);
    float sumY = yc0.x;
    float wSumY = 1.0;
    vec2 sumC = yc0.yz;
    float wSumC = 1.0;

    // 4 axial neighbors (always evaluated when effSigma > 0.0018 for chroma clean)
    accumDenoiseTap(vec2( 0.0, -1.0), 0.72, yc0, lumaSigma, invLumaVar, invGuideVar, invChromaVar, sumY, wSumY, sumC, wSumC);
    accumDenoiseTap(vec2( 0.0,  1.0), 0.72, yc0, lumaSigma, invLumaVar, invGuideVar, invChromaVar, sumY, wSumY, sumC, wSumC);
    accumDenoiseTap(vec2(-1.0,  0.0), 0.72, yc0, lumaSigma, invLumaVar, invGuideVar, invChromaVar, sumY, wSumY, sumC, wSumC);
    accumDenoiseTap(vec2( 1.0,  0.0), 0.72, yc0, lumaSigma, invLumaVar, invGuideVar, invChromaVar, sumY, wSumY, sumC, wSumC);

    // 4 diagonal neighbors unlocked only on higher ISO / single-frame regions
    if (effSigma > 0.007) {
      accumDenoiseTap(vec2(-1.0, -1.0), 0.42, yc0, lumaSigma, invLumaVar, invGuideVar, invChromaVar, sumY, wSumY, sumC, wSumC);
      accumDenoiseTap(vec2( 1.0, -1.0), 0.42, yc0, lumaSigma, invLumaVar, invGuideVar, invChromaVar, sumY, wSumY, sumC, wSumC);
      accumDenoiseTap(vec2(-1.0,  1.0), 0.42, yc0, lumaSigma, invLumaVar, invGuideVar, invChromaVar, sumY, wSumY, sumC, wSumC);
      accumDenoiseTap(vec2( 1.0,  1.0), 0.42, yc0, lumaSigma, invLumaVar, invGuideVar, invChromaVar, sumY, wSumY, sumC, wSumC);
    }

    vec3 outYc = vec3(sumY / max(wSumY, 1e-4), sumC / max(wSumC, 1e-4));
    vec3 outLin = sqrtYCoCgToLin(outYc);
    gl_FragColor = encodeHdr(vec4(outLin, coverage));
  }
`;

/**
 * Pass 4: Linear WB, highlight-safe auto exposure, halo-free bilateral Local HDR + Clarity,
 * AgX-inspired highlight desaturation & continuous rational shoulder, Look tone/color.
 * Outputs perceptual sRGB [0..1] ready for Pass 5 CAS + dither.
 */
export const TONEMAP_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uHdrTex;
  uniform sampler2D uLumTex;

  uniform vec3 uWbGains;
  uniform float uExposureEv;
  uniform float uAutoExposureEv;
  uniform float uSceneMidLogL;
  uniform float uLocalHdrStrength;
  uniform float uShadowLift;
  uniform float uHighlightRoll;
  uniform float uClarity;
  uniform float uVibrance;
  uniform float uSaturation;
  uniform float uContrast;
  uniform float uFilmFade;
  uniform float uWarmth;

  varying vec2 vTexCoord;

  ${COMMON_HDR_GLSL}

  // Continuous C1 Reinhard-knee shoulder: f(knee)=knee, f'(knee)=1, f(inf)=ceilVal
  float compressChannel(float c, float knee, float ceilVal) {
    if (c <= knee) return max(c, 0.0);
    float span = max(ceilVal - knee, 0.05);
    float t = c - knee;
    return knee + (span * t) / (span + t);
  }

  void main() {
    vec3 lin = decodeHdr(texture2D(uHdrTex, vTexCoord)).rgb;
    lin *= uWbGains;

    if (abs(uExposureEv) > 0.001) {
      lin *= exp2(uExposureEv);
    }

    float baseY = getLinearLuma(lin);
    if (uAutoExposureEv > 0.001) {
      float hiSafe = 1.0 - smoothstep(0.38, 0.92, baseY);
      lin *= exp2(uAutoExposureEv * hiSafe);
    }

    float localLogL = decodeLogLum(texture2D(uLumTex, vTexCoord).r);
    float pixelY = max(getLinearLuma(lin), 1e-5);
    float pixelLogL = log2(pixelY);

    // 1) Halo-free Local HDR dodge/burn from bilateral base luminance
    float relLocal = clamp(localLogL - uSceneMidLogL, -4.0, 4.0);
    float dodgeStops = clamp(-relLocal * 0.24 * uLocalHdrStrength, -0.45, 0.72);

    // 2) Black-point anchored shadow toe lift (keeps true 0 black clean)
    float toeMask = smoothstep(0.0002, 0.0025, pixelY) * pow(1.0 - smoothstep(0.0, 0.28, pixelY), 2.0);
    float toeStops = uShadowLift * 0.65 * toeMask;

    // 3) Halo-free micro-contrast clarity on bilateral high-pass log luminance
    float detailLog = clamp(pixelLogL - localLogL, -1.6, 1.6);
    float clarityMask = smoothstep(0.004, 0.035, pixelY) * (1.0 - smoothstep(0.45, 0.90, pixelY));
    float clarityStops = detailLog * uClarity * clarityMask;

    float hdrGain = exp2(clamp(dodgeStops + toeStops + clarityStops, -0.75, 1.25));
    lin *= hdrGain;

    // AgX-inspired soft highlight path-to-white above linear white to avoid neon RGB clipping
    float peak = max(lin.r, max(lin.g, lin.b));
    if (peak > 0.98) {
      float hiMix = smoothstep(0.98, 2.5, peak) * 0.56;
      float lum = getLinearLuma(lin);
      lin = mix(lin, vec3(max(lum, peak * 0.88)), hiMix);
    }

    // Continuous rational highlight shoulder
    float knee = mix(0.74, 0.56, clamp(uHighlightRoll, 0.0, 1.0));
    lin = vec3(
      compressChannel(lin.r, knee, 1.02),
      compressChannel(lin.g, knee, 1.02),
      compressChannel(lin.b, knee, 1.02)
    );

    vec3 srgb = linearToSrgb(lin);

    // Perceptual vibrance + Look saturation
    float l = dot(srgb, vec3(0.2126, 0.7152, 0.0722));
    float cMax = max(srgb.r, max(srgb.g, srgb.b));
    float cMin = min(srgb.r, min(srgb.g, srgb.b));
    float sat = (cMax - cMin) / max(cMax, 1e-4);
    float vibMask = 1.0 - smoothstep(0.25, 0.88, sat);
    float satFactor = clamp(1.0 + uVibrance * vibMask + (uSaturation - 1.0), 0.7, 1.35);
    srgb = mix(vec3(l), srgb, satFactor);

    // Subtle filmic contrast S-curve
    vec3 sCurve = srgb * srgb * (3.0 - 2.0 * srgb);
    float curveMix = clamp((uContrast - 1.0) * 1.6, -0.15, 0.28);
    srgb = mix(srgb, sCurve, curveMix);

    // Optional Film Look split warmth + classic matte toe
    if (abs(uWarmth) > 0.001) {
      float hiW = smoothstep(0.25, 0.85, l);
      vec3 warmTint = vec3(1.0 + uWarmth, 1.0 + uWarmth * 0.35, 1.0 - uWarmth * 0.9);
      vec3 coolShadow = vec3(1.0 - uWarmth * 0.35, 1.0, 1.0 + uWarmth * 0.45);
      srgb *= mix(coolShadow, warmTint, hiW);
    }
    if (uFilmFade > 0.001) {
      srgb = uFilmFade + srgb * (1.0 - uFilmFade * 0.6);
    }

    gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
  }
`;

/**
 * Pass 5: 8-neighbor AMD FidelityFX-style Contrast-Adaptive Sharpening + TPDF IGN dither.
 */
export const OUTPUT_CAS_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uSrgbTex;
  uniform vec2 uTexelSize;   // (1.0 / outW, 1.0 / outH)
  uniform float uSharpen;    // 0.0 .. 1.0
  uniform float uNoiseSigma; // Prevents amplifying residual ISO noise

  varying vec2 vTexCoord;

  float getLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  float ign(vec2 p) {
    vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
    return fract(magic.z * fract(dot(p, magic.xy)));
  }

  void main() {
    vec3 c  = texture2D(uSrgbTex, vTexCoord).rgb;
    vec2 dx = vec2(uTexelSize.x, 0.0);
    vec2 dy = vec2(0.0, uTexelSize.y);

    vec3 n  = texture2D(uSrgbTex, clamp(vTexCoord - dy, 0.0, 1.0)).rgb;
    vec3 s  = texture2D(uSrgbTex, clamp(vTexCoord + dy, 0.0, 1.0)).rgb;
    vec3 w  = texture2D(uSrgbTex, clamp(vTexCoord - dx, 0.0, 1.0)).rgb;
    vec3 e  = texture2D(uSrgbTex, clamp(vTexCoord + dx, 0.0, 1.0)).rgb;

    vec3 nw = texture2D(uSrgbTex, clamp(vTexCoord - dx - dy, 0.0, 1.0)).rgb;
    vec3 ne = texture2D(uSrgbTex, clamp(vTexCoord + dx - dy, 0.0, 1.0)).rgb;
    vec3 sw = texture2D(uSrgbTex, clamp(vTexCoord - dx + dy, 0.0, 1.0)).rgb;
    vec3 se = texture2D(uSrgbTex, clamp(vTexCoord + dx + dy, 0.0, 1.0)).rgb;

    vec3 mnCross = min(c, min(min(n, s), min(w, e)));
    vec3 mxCross = max(c, max(max(n, s), max(w, e)));
    vec3 mnBox = min(mnCross, min(min(nw, ne), min(sw, se)));
    vec3 mxBox = max(mxCross, max(max(nw, ne), max(sw, se)));
    vec3 mn = 0.5 * (mnCross + mnBox);
    vec3 mx = 0.5 * (mxCross + mxBox);

    vec3 distMin = max(mn, vec3(0.0));
    vec3 distMax = max(1.0 - mx, vec3(0.0));
    vec3 amp = clamp(min(distMin, distMax) / max(mx, vec3(1e-4)), 0.0, 1.0);
    amp = sqrt(amp);

    float lC = getLuma(c);
    float lBlur = 0.25 * getLuma(n + s + w + e);
    float lSpan = max(getLuma(mx) - getLuma(mn), 0.0);
    float coreFloor = max(0.008, uNoiseSigma * 0.65);
    float coring = smoothstep(coreFloor * 0.5, coreFloor * 2.2, abs(lC - lBlur))
                 * smoothstep(0.014, 0.065, lSpan);

    float sharpScale = mix(-0.125, -0.20, clamp(uSharpen, 0.0, 1.0)) * coring;
    vec3 weight = amp * sharpScale;
    vec3 sharpened = (c + (n + s + w + e) * weight) / max(vec3(1.0) + 4.0 * weight, vec3(0.15));

    sharpened = clamp(sharpened, mnBox - 0.015, mxBox + 0.015);
    sharpened = clamp(sharpened, 0.0, 1.0);

    float ditherMask = smoothstep(0.004, 0.025, lC) * (1.0 - smoothstep(0.975, 0.996, lC));
    float n1 = ign(gl_FragCoord.xy);
    float n2 = ign(gl_FragCoord.xy + vec2(37.0, 17.0));
    float tpdf = (n1 - n2) * (0.7 / 255.0) * ditherMask;

    gl_FragColor = vec4(clamp(sharpened + vec3(tpdf), 0.0, 1.0), 1.0);
  }
`;
