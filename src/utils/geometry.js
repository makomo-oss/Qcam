/**
 * Geometry, aspect-ratio cropping, zoom partitioning, and tap-to-focus coordinate mapping.
 */

export const ASPECT_RATIOS = {
  '4:3': 4 / 3,
  '16:9': 16 / 9,
};

/**
 * Compute target ratio oriented to match the source frame's orientation
 * (portrait source -> 3:4 or 9:16; landscape source -> 4:3 or 16:9).
 */
export function getOrientedAspectRatio(aspectKey, srcWidth, srcHeight) {
  const baseRatio = ASPECT_RATIOS[aspectKey] || ASPECT_RATIOS['4:3'];
  const isPortrait = srcHeight > srcWidth;
  return isPortrait ? 1 / baseRatio : baseRatio;
}

/**
 * Compute source crop rectangle and output dimensions for a frame
 * given desired aspect ratio ('4:3' | '16:9') and software digital zoom (>= 1).
 */
export function computeAspectCrop(
  srcWidth,
  srcHeight,
  aspectKey = '4:3',
  softwareZoom = 1,
  maxDimension = 4096
) {
  const safeW = Math.max(1, Math.round(srcWidth));
  const safeH = Math.max(1, Math.round(srcHeight));
  const zoom = Math.max(1, Number(softwareZoom) || 1);
  const targetRatio = getOrientedAspectRatio(aspectKey, safeW, safeH);
  const srcRatio = safeW / safeH;

  let baseCropW;
  let baseCropH;
  if (srcRatio > targetRatio) {
    // Source is wider than target -> trim width
    baseCropH = safeH;
    baseCropW = Math.round(safeH * targetRatio);
  } else {
    // Source is taller than target -> trim height
    baseCropW = safeW;
    baseCropH = Math.round(safeW / targetRatio);
  }

  baseCropW = Math.max(2, Math.min(safeW, baseCropW));
  baseCropH = Math.max(2, Math.min(safeH, baseCropH));

  // Apply software digital zoom centered inside the aspect-cropped region
  const sw = Math.max(2, Math.round(baseCropW / zoom));
  const sh = Math.max(2, Math.round(baseCropH / zoom));
  const sx = Math.max(0, Math.round((safeW - sw) / 2));
  const sy = Math.max(0, Math.round((safeH - sh) / 2));

  // Preserve full aspect-cropped resolution on output (upscaled smoothly by GPU/Canvas when zoomed),
  // clamped to maxDimension (e.g. WebGL MAX_TEXTURE_SIZE).
  let outWidth = baseCropW;
  let outHeight = baseCropH;
  const maxSide = Math.max(outWidth, outHeight);
  if (maxDimension > 0 && maxSide > maxDimension) {
    const scale = maxDimension / maxSide;
    outWidth = Math.max(2, Math.round(outWidth * scale));
    outHeight = Math.max(2, Math.round(outHeight * scale));
  }

  return {
    sx,
    sy,
    sw,
    sh,
    outWidth,
    outHeight,
    baseCropW,
    baseCropH,
  };
}

/**
 * Partition requested total zoom into hardware optical/driver zoom and software crop zoom
 * so they never double-apply.
 */
export function splitZoom(targetZoom, zoomCap = null, maxTotalZoom = 5.0) {
  const clampedTarget = Math.max(1.0, Math.min(maxTotalZoom, Number(targetZoom) || 1.0));
  if (
    zoomCap &&
    typeof zoomCap.min === 'number' &&
    typeof zoomCap.max === 'number' &&
    zoomCap.max > zoomCap.min
  ) {
    const hwMin = Math.max(1.0, zoomCap.min);
    const hwMax = Math.max(hwMin, zoomCap.max);
    const step = typeof zoomCap.step === 'number' && zoomCap.step > 0 ? zoomCap.step : 0.01;

    let hardwareZoom = Math.min(clampedTarget, hwMax);
    hardwareZoom = Math.max(hwMin, hardwareZoom);
    // Snap to hardware step
    hardwareZoom = Math.round((hardwareZoom - hwMin) / step) * step + hwMin;
    hardwareZoom = Number(Math.min(hwMax, Math.max(hwMin, hardwareZoom)).toFixed(3));

    const softwareZoom = Number(Math.max(1.0, clampedTarget / hardwareZoom).toFixed(4));
    return {
      hardwareSupported: true,
      hardwareZoom,
      softwareZoom,
      totalZoom: Number((hardwareZoom * softwareZoom).toFixed(2)),
    };
  }

  return {
    hardwareSupported: false,
    hardwareZoom: 1.0,
    softwareZoom: Number(clampedTarget.toFixed(4)),
    totalZoom: Number(clampedTarget.toFixed(2)),
  };
}

/**
 * Map a client tap position inside the preview container to normalized [0..1, 0..1]
 * coordinates in the underlying camera video frame, accounting for object-fit: cover,
 * software zoom, and front-camera horizontal mirroring.
 */
export function mapTapToNormalizedPoint(
  clientX,
  clientY,
  containerRect,
  srcWidth,
  srcHeight,
  { mirrored = false, softwareZoom = 1 } = {}
) {
  if (!containerRect || containerRect.width <= 0 || containerRect.height <= 0) {
    return { x: 0.5, y: 0.5 };
  }
  const safeW = Math.max(1, srcWidth || containerRect.width);
  const safeH = Math.max(1, srcHeight || containerRect.height);
  const zoom = Math.max(1, Number(softwareZoom) || 1);

  // Normalized position within the visible container [0..1]
  let u = (clientX - containerRect.left) / containerRect.width;
  const v = (clientY - containerRect.top) / containerRect.height;

  // If preview CSS mirrors horizontally (scaleX(-1)), flip u to map back to camera sensor
  if (mirrored) {
    u = 1 - u;
  }

  // Calculate how object-fit: cover scales the source frame onto containerRect
  const coverScale = Math.max(
    containerRect.width / safeW,
    containerRect.height / safeH
  );
  const renderedW = safeW * coverScale;
  const renderedH = safeH * coverScale;

  // Center-crop offset from object-fit: cover
  const visibleFractionW = containerRect.width / renderedW;
  const visibleFractionH = containerRect.height / renderedH;

  // Software zoom crops further from center
  const zoomedFractionW = visibleFractionW / zoom;
  const zoomedFractionH = visibleFractionH / zoom;

  const normX = 0.5 + (u - 0.5) * zoomedFractionW;
  const normY = 0.5 + (v - 0.5) * zoomedFractionH;

  return {
    x: Number(Math.max(0, Math.min(1, normX)).toFixed(4)),
    y: Number(Math.max(0, Math.min(1, normY)).toFixed(4)),
  };
}
