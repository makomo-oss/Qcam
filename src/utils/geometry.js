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
 * so they never double-apply. Supports < 1.0 hardware ultra-wide zoom as well as
 * dedicated ultra-wide physical lenses via options.baseLensScale (e.g. 0.5).
 */
export function splitZoom(
  targetZoom,
  zoomCap = null,
  maxTotalZoom = 5.0,
  { baseLensScale = 1.0 } = {}
) {
  const safeBase = Math.max(0.25, Math.min(1.0, Number(baseLensScale) || 1.0));
  const hasHwRange = Boolean(
    zoomCap &&
      typeof zoomCap.min === 'number' &&
      typeof zoomCap.max === 'number' &&
      zoomCap.max > zoomCap.min
  );
  const hwMinRaw = hasHwRange ? Math.max(0.25, zoomCap.min) : 1.0;
  const hwMaxRaw = hasHwRange ? Math.max(hwMinRaw, zoomCap.max) : 1.0;
  const minTotalZoom = Math.min(safeBase, safeBase * hwMinRaw);

  const clampedTarget = Math.max(
    minTotalZoom,
    Math.min(maxTotalZoom, Number(targetZoom) || safeBase)
  );
  const desiredRelativeZoom = Math.max(hwMinRaw, clampedTarget / safeBase);

  if (hasHwRange) {
    const hwMin = hwMinRaw;
    const hwMax = hwMaxRaw;
    const step = typeof zoomCap.step === 'number' && zoomCap.step > 0 ? zoomCap.step : 0.01;

    let hardwareZoom = Math.min(desiredRelativeZoom, hwMax);
    hardwareZoom = Math.max(hwMin, hardwareZoom);
    // Snap to hardware step
    hardwareZoom = Math.round((hardwareZoom - hwMin) / step) * step + hwMin;
    hardwareZoom = Number(Math.min(hwMax, Math.max(hwMin, hardwareZoom)).toFixed(3));

    const softwareZoom = Number(
      Math.max(1.0, desiredRelativeZoom / hardwareZoom).toFixed(4)
    );
    return {
      hardwareSupported: true,
      hardwareZoom,
      softwareZoom,
      totalZoom: Number((safeBase * hardwareZoom * softwareZoom).toFixed(2)),
    };
  }

  const softwareZoom = Number(Math.max(1.0, clampedTarget / safeBase).toFixed(4));
  return {
    hardwareSupported: false,
    hardwareZoom: 1.0,
    softwareZoom,
    totalZoom: Number((safeBase * softwareZoom).toFixed(2)),
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

/**
 * Compute optimal viewfinder frame placement across smartphone portrait,
 * short browser viewports (address bars visible), compact smartphone landscape,
 * and tablet/desktop viewports.
 */
export function computeViewfinderLayout({
  stageWidth,
  stageHeight,
  topBarBottom = 0,
  dockTop = stageHeight,
  dockLeft = stageWidth,
  dockWidth = 0,
  dockHeight = 0,
  aspectRatio = '4:3',
}) {
  const safeW = Math.max(120, stageWidth || 360);
  const safeH = Math.max(120, stageHeight || 640);
  const baseRatio = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['4:3'];
  const isPortrait = safeH >= safeW;
  const targetRatio = isPortrait ? 1 / baseRatio : baseRatio;

  const isSideDock =
    dockWidth > 0 &&
    dockHeight > safeH * 0.65 &&
    dockWidth < safeW * 0.45 &&
    dockLeft > safeW * 0.5;

  const fitInto = (maxW, maxH) => {
    let w = maxW;
    let h = w / targetRatio;
    if (h > maxH) {
      h = maxH;
      w = h * targetRatio;
    }
    return { width: w, height: h };
  };

  let frameW;
  let frameH;
  let left;
  let top;

  if (isSideDock) {
    const clearW = Math.max(120, dockLeft);
    if (aspectRatio === '16:9') {
      const fitted = fitInto(safeW, safeH);
      frameW = fitted.width;
      frameH = fitted.height;
      // If 16:9 still clears the side dock comfortably, center inside clear area; otherwise full-bleed
      left = frameW <= clearW ? (clearW - frameW) / 2 : (safeW - frameW) / 2;
      top = (safeH - frameH) / 2;
    } else {
      const fitted = fitInto(Math.max(120, clearW - 8), Math.max(120, safeH - 4));
      frameW = fitted.width;
      frameH = fitted.height;
      left = (clearW - frameW) / 2;
      top = (safeH - frameH) / 2;
    }
  } else if (isPortrait) {
    const clearTop = Math.max(0, topBarBottom);
    const clearBottom = Math.min(safeH, dockTop > 0 ? dockTop : safeH - dockHeight);
    const clearH = Math.max(120, clearBottom - clearTop);

    if (aspectRatio === '16:9') {
      const fitted = fitInto(safeW, safeH);
      frameW = fitted.width;
      frameH = fitted.height;
      left = (safeW - frameW) / 2;
      top = (safeH - frameH) / 2;
    } else {
      const fullWHeight = safeW / targetRatio;
      const clearFitW = Math.max(0, clearH - 4) * targetRatio;

      if (fullWHeight <= clearH - 4) {
        frameW = safeW;
        frameH = fullWHeight;
        left = 0;
        top = clearTop + (clearH - frameH) / 2;
      } else if (clearFitW >= safeW * 0.88) {
        frameW = clearFitW;
        frameH = clearH - 4;
        left = (safeW - frameW) / 2;
        top = clearTop + 2;
      } else {
        // Short phone screens (e.g. mobile Safari/Chrome with bottom toolbar open):
        // allow translucent top bar / zoom pill over the frame while keeping shutter button unobstructed
        const measuredDockH = Math.max(0, dockHeight || safeH - clearBottom);
        const shutterGuard = Math.min(92, measuredDockH * 0.56);
        const topGuard = Math.min(24, clearTop * 0.5);
        const availH = Math.min(safeH, Math.max(clearH, safeH - topGuard - shutterGuard));
        const fitted = fitInto(safeW, availH);
        frameW = fitted.width;
        frameH = fitted.height;
        left = (safeW - frameW) / 2;
        top = topGuard + Math.max(0, (availH - frameH) / 2);
      }
    }
  } else {
    // Tablet / Desktop landscape (dock at bottom)
    const clearTop = Math.max(0, topBarBottom);
    const clearBottom = Math.min(safeH, dockTop > 0 ? dockTop : safeH - dockHeight);
    const clearH = Math.max(120, clearBottom - clearTop - 12);
    const availW = Math.max(120, safeW - 24);
    const fitted = fitInto(availW, clearH);
    frameW = fitted.width;
    frameH = fitted.height;
    left = (safeW - frameW) / 2;
    top = clearTop + 6 + (clearH - frameH) / 2;
  }

  const width = Math.round(frameW);
  const height = Math.round(frameH);
  const roundedLeft = Math.round(left);
  const roundedTop = Math.round(top);
  const edgeToEdge = width >= safeW - 2 || height >= safeH - 2;
  const topInset = isSideDock ? Math.max(0, Math.round(topBarBottom - roundedTop)) : Math.max(0, Math.round(topBarBottom - roundedTop));
  const bottomInset = isSideDock
    ? 0
    : Math.max(0, Math.round(roundedTop + height - Math.min(safeH, dockTop > 0 ? dockTop : safeH - dockHeight)));

  return {
    left: roundedLeft,
    top: roundedTop,
    width,
    height,
    edgeToEdge,
    topInset,
    bottomInset,
    isSideDock,
  };
}

