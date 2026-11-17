/**
 * GLSL ES 1.00 shaders compatible with both WebGL1 and WebGL2 (including OffscreenCanvas).
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
  uniform float uSharpen;       // Unsharp mask strength (~0.55)
  uniform float uContrast;      // Subtle S-curve contrast (~0.14)
  uniform float uExposureEv;    // Software EV bias (-2.0 .. +2.0)

  varying vec2 vTexCoord;

  float getLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  void main() {
    vec3 center = texture2D(uTexture, vTexCoord).rgb;

    // 5-tap isotropic cross kernel for fast luminance unsharp mask
    vec2 dx = vec2(uTexelSize.x, 0.0);
    vec2 dy = vec2(0.0, uTexelSize.y);

    float lC = getLuma(center);
    float lN = getLuma(texture2D(uTexture, vTexCoord - dy).rgb);
    float lS = getLuma(texture2D(uTexture, vTexCoord + dy).rgb);
    float lW = getLuma(texture2D(uTexture, vTexCoord - dx).rgb);
    float lE = getLuma(texture2D(uTexture, vTexCoord + dx).rgb);

    float lBlur = 0.25 * (lN + lS + lW + lE);

    float detail = lC - lBlur;
    // Soft noise coring so subtle grain is not amplified while real edges sharpen crisply
    float coring = smoothstep(0.006, 0.028, abs(detail));
    float sharpDelta = clamp(detail * coring * uSharpen, -0.18, 0.18);

    vec3 rgb = center + vec3(sharpDelta);

    // Optional software EV exposure compensation
    if (abs(uExposureEv) > 0.001) {
      rgb *= exp2(uExposureEv);
    }

    rgb = clamp(rgb, 0.0, 1.0);

    // Subtle S-curve micro-contrast
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
  uniform float uShadowLift;    // ~0.75
  uniform float uHighlightRoll; // ~0.65
  uniform float uSharpen;       // ~0.38
  uniform float uExposureEv;    // Software EV bias

  varying vec2 vTexCoord;

  float getLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  float motionWeight(vec3 a, vec3 b) {
    vec3 d = a - b;
    float dist2 = dot(d, d);
    // Gaussian temporal kernel: suppresses noise while rejecting motion ghosting
    return exp(-dist2 / (2.0 * 0.11 * 0.11));
  }

  void main() {
    vec3 p0 = texture2D(uFrame0, vTexCoord).rgb;
    vec3 accum = p0;
    float totalW = 1.0;

    if (uFrameCount > 1.5) {
      vec3 p1 = texture2D(uFrame1, vTexCoord).rgb;
      float w1 = motionWeight(p0, p1);
      accum += p1 * w1;
      totalW += w1;
    }
    if (uFrameCount > 2.5) {
      vec3 p2 = texture2D(uFrame2, vTexCoord).rgb;
      float w2 = motionWeight(p0, p2);
      accum += p2 * w2;
      totalW += w2;
    }
    if (uFrameCount > 3.5) {
      vec3 p3 = texture2D(uFrame3, vTexCoord).rgb;
      float w3 = motionWeight(p0, p3);
      accum += p3 * w3;
      totalW += w3;
    }

    vec3 rgb = accum / totalW;

    // Gentle luminance sharpening using reference frame gradients
    vec2 dx = vec2(uTexelSize.x, 0.0);
    vec2 dy = vec2(0.0, uTexelSize.y);
    float l0 = getLuma(p0);
    float lN = getLuma(texture2D(uFrame0, vTexCoord - dy).rgb);
    float lS = getLuma(texture2D(uFrame0, vTexCoord + dy).rgb);
    float lW = getLuma(texture2D(uFrame0, vTexCoord - dx).rgb);
    float lE = getLuma(texture2D(uFrame0, vTexCoord + dx).rgb);
    float lAvg = 0.25 * (lN + lS + lW + lE);
    float detail = l0 - lAvg;
    float coring = smoothstep(0.008, 0.032, abs(detail));
    rgb += vec3(clamp(detail * coring * uSharpen, -0.14, 0.14));

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
