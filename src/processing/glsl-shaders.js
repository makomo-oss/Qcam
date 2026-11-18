/**
 * GLSL ES 1.00 shaders compatible with both WebGL1 and WebGL2 (including OffscreenCanvas).
 * Features stabilized per-frame geometric alignment, 5-tap structural patch ghost rejection,
 * and CAS-inspired ringing-safe adaptive sharpening.
 */

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

export const STANDARD_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uTexture;
  uniform vec2 uTexelSize;      // (1.0 / texWidth, 1.0 / texHeight)
  uniform float uSharpen;       // Adaptive unsharp strength (~0.58)
  uniform float uContrast;      // Subtle S-curve contrast (~0.14)
  uniform float uExposureEv;    // Software EV bias (-2.0 .. +2.0)

  varying vec2 vTexCoord;

  float getLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec3 center = texture2D(uTexture, vTexCoord).rgb;

    vec2 dx = vec2(uTexelSize.x, 0.0);
    vec2 dy = vec2(0.0, uTexelSize.y);

    float lC = getLuma(center);
    float lN = getLuma(texture2D(uTexture, clamp(vTexCoord - dy, 0.0, 1.0)).rgb);
    float lS = getLuma(texture2D(uTexture, clamp(vTexCoord + dy, 0.0, 1.0)).rgb);
    float lW = getLuma(texture2D(uTexture, clamp(vTexCoord - dx, 0.0, 1.0)).rgb);
    float lE = getLuma(texture2D(uTexture, clamp(vTexCoord + dx, 0.0, 1.0)).rgb);

    float lMin = min(lC, min(min(lN, lS), min(lW, lE)));
    float lMax = max(lC, max(max(lN, lS), max(lW, lE)));
    float lBlur = 0.25 * (lN + lS + lW + lE);

    float detail = lC - lBlur;
    float span = lMax - lMin;
    float coring = smoothstep(0.008, 0.032, abs(detail)) * smoothstep(0.015, 0.065, span);
    float headRoom = min(max(0.0, lMax - lC), max(0.0, lC - lMin)) + 0.035;
    float sharpDelta = clamp(detail * coring * uSharpen, -min(0.16, headRoom), min(0.16, headRoom));

    vec3 rgb = center + vec3(sharpDelta);

    if (abs(uExposureEv) > 0.001) {
      rgb *= exp2(uExposureEv);
    }

    rgb = clamp(rgb, 0.0, 1.0);

    vec3 sCurve = rgb * rgb * (3.0 - 2.0 * rgb);
    rgb = mix(rgb, sCurve, uContrast);

    gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
  }
`;

export const HQ_FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uFrame0;
  uniform sampler2D uFrame1;
  uniform sampler2D uFrame2;
  uniform sampler2D uFrame3;

  uniform float uFrameCount;    // 1.0 .. 4.0
  uniform vec2 uTexelSize;

  // Similarity transform per frame (ref UV -> aligned frame k UV)
  uniform vec4 uAlignMat1;
  uniform vec2 uAlignShift1;
  uniform vec4 uAlignMat2;
  uniform vec2 uAlignShift2;
  uniform vec4 uAlignMat3;
  uniform vec2 uAlignShift3;

  uniform vec3 uFrameWeights;   // Confidence weights for frames 1, 2, 3
  uniform vec3 uFrameGains;     // Exposure equalization multipliers for frames 1, 2, 3
  uniform float uPatchTol2;     // Strict 5-tap structural patch MSE cutoff

  uniform float uShadowLift;    // ~0.78
  uniform float uHighlightRoll; // ~0.65
  uniform float uSharpen;       // ~0.56
  uniform float uExposureEv;    // Software EV bias

  varying vec2 vTexCoord;

  float getLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

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

  vec4 evaluateAlignedSample(
    sampler2D frameTex,
    vec2 uvk,
    vec2 dx,
    vec2 dy,
    float frameConf,
    float gain,
    vec3 p0,
    vec3 p0N,
    vec3 p0S,
    vec3 p0W,
    vec3 p0E,
    float localEdge2
  ) {
    vec2 margin = uTexelSize * 1.25;
    if (frameConf <= 0.01 || !inSafeBounds(uvk, margin)) {
      return vec4(0.0);
    }

    vec3 pkC = clamp(texture2D(frameTex, uvk).rgb * gain, 0.0, 1.0);
    vec3 pkN = clamp(texture2D(frameTex, uvk - dy).rgb * gain, 0.0, 1.0);
    vec3 pkS = clamp(texture2D(frameTex, uvk + dy).rgb * gain, 0.0, 1.0);
    vec3 pkW = clamp(texture2D(frameTex, uvk - dx).rgb * gain, 0.0, 1.0);
    vec3 pkE = clamp(texture2D(frameTex, uvk + dx).rgb * gain, 0.0, 1.0);

    vec3 dC = p0  - pkC;
    vec3 dN = p0N - pkN;
    vec3 dS = p0S - pkS;
    vec3 dW = p0W - pkW;
    vec3 dE = p0E - pkE;

    float patchErr2 = (
      dot(dC, dC) * 2.0 +
      dot(dN, dN) +
      dot(dS, dS) +
      dot(dW, dW) +
      dot(dE, dE)
    ) / 6.0;

    float tol2 = uPatchTol2 + 0.01 * localEdge2;
    float ratio = patchErr2 / max(tol2, 1e-5);
    // Exponential merge weight with strict hard cutoff (smoothstep -> 0.0) to eliminate double-edge ghosting
    float w = exp(-ratio * 1.45) * smoothstep(2.2, 0.65, ratio) * frameConf;
    return vec4(pkC * w, w);
  }

  void main() {
    vec2 dx = vec2(uTexelSize.x, 0.0);
    vec2 dy = vec2(0.0, uTexelSize.y);

    vec3 p0  = texture2D(uFrame0, vTexCoord).rgb;
    vec3 p0N = texture2D(uFrame0, clamp(vTexCoord - dy, 0.0, 1.0)).rgb;
    vec3 p0S = texture2D(uFrame0, clamp(vTexCoord + dy, 0.0, 1.0)).rgb;
    vec3 p0W = texture2D(uFrame0, clamp(vTexCoord - dx, 0.0, 1.0)).rgb;
    vec3 p0E = texture2D(uFrame0, clamp(vTexCoord + dx, 0.0, 1.0)).rgb;

    vec3 eN = p0 - p0N;
    vec3 eS = p0 - p0S;
    vec3 eW = p0 - p0W;
    vec3 eE = p0 - p0E;
    float localEdge2 = 0.25 * (dot(eN, eN) + dot(eS, eS) + dot(eW, eW) + dot(eE, eE));

    vec3 accum = p0;
    float totalW = 1.0;

    if (uFrameCount > 1.5) {
      vec2 uv1 = mapAlignUv(vTexCoord, uAlignMat1, uAlignShift1);
      vec4 s1 = evaluateAlignedSample(
        uFrame1, uv1, dx, dy, uFrameWeights.x, uFrameGains.x,
        p0, p0N, p0S, p0W, p0E, localEdge2
      );
      accum += s1.rgb;
      totalW += s1.a;
    }
    if (uFrameCount > 2.5) {
      vec2 uv2 = mapAlignUv(vTexCoord, uAlignMat2, uAlignShift2);
      vec4 s2 = evaluateAlignedSample(
        uFrame2, uv2, dx, dy, uFrameWeights.y, uFrameGains.y,
        p0, p0N, p0S, p0W, p0E, localEdge2
      );
      accum += s2.rgb;
      totalW += s2.a;
    }
    if (uFrameCount > 3.5) {
      vec2 uv3 = mapAlignUv(vTexCoord, uAlignMat3, uAlignShift3);
      vec4 s3 = evaluateAlignedSample(
        uFrame3, uv3, dx, dy, uFrameWeights.z, uFrameGains.z,
        p0, p0N, p0S, p0W, p0E, localEdge2
      );
      accum += s3.rgb;
      totalW += s3.a;
    }

    vec3 rgb = accum / totalW;

    // CAS-inspired ringing-safe micro-contrast restoration on real edges
    float l0 = getLuma(p0);
    float lN = getLuma(p0N);
    float lS = getLuma(p0S);
    float lW = getLuma(p0W);
    float lE = getLuma(p0E);
    float lMin = min(l0, min(min(lN, lS), min(lW, lE)));
    float lMax = max(l0, max(max(lN, lS), max(lW, lE)));
    float lAvg = 0.25 * (lN + lS + lW + lE);
    float lMerged = getLuma(rgb);
    float detail = l0 - lAvg;
    float span = lMax - lMin;
    float coring = smoothstep(0.01, 0.038, abs(detail)) * smoothstep(0.02, 0.08, span);
    float headRoom = min(max(0.0, lMax - lMerged), max(0.0, lMerged - lMin)) + 0.035;
    float sharpDelta = clamp(detail * coring * uSharpen, -min(0.15, headRoom), min(0.15, headRoom));
    rgb += vec3(sharpDelta);

    if (abs(uExposureEv) > 0.001) {
      rgb *= exp2(uExposureEv);
    }

    rgb = clamp(rgb, 0.0, 1.0);

    // Perceptual HDR tone mapping: lift shadows & roll off highlights while preserving hue
    float luma = max(getLuma(rgb), 1e-4);

    // 1) Shadow lift (smooth toe curve; preserves deep blacks near 0 to avoid murky shadows)
    float shadowMask = pow(1.0 - luma, 2.3);
    float toeLift = uShadowLift * shadowMask * (0.24 * (1.0 - exp(-luma * 7.5)) + 0.03 * luma);
    float liftedLuma = luma + toeLift;

    // 2) Highlight roll-off (smooth shoulder compression above 0.58)
    float hiExcess = max(0.0, liftedLuma - 0.58);
    float mappedLuma = liftedLuma - (uHighlightRoll * hiExcess * hiExcess) / (0.42 + hiExcess);
    mappedLuma = clamp(mappedLuma, 0.0, 0.985);

    float scale = mappedLuma / luma;
    vec3 toned = rgb * scale;

    // Soft per-channel highlight shoulder to keep bright details colored rather than clipped
    vec3 softRoll = toned / (1.0 + 0.18 * max(toned - 0.85, vec3(0.0)));
    toned = clamp(softRoll, 0.0, 1.0);

    // Subtle vibrance boost to offset contrast compression from tone mapping
    float finalLuma = getLuma(toned);
    float satBoost = 1.0 + 0.08 * (1.0 - abs(finalLuma * 2.0 - 1.0));
    toned = mix(vec3(finalLuma), toned, satBoost);

    gl_FragColor = vec4(clamp(toned, 0.0, 1.0), 1.0);
  }
`;
