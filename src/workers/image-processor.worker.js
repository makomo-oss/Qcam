import { computeAspectCrop } from '../utils/geometry.js';
import {
  computeMaxDimensionForMegapixels,
  getEncoderMaxDimension,
} from '../utils/resolution.js';
import { WebGLImageProcessor } from '../processing/webgl-processor.js';
import {
  STABILIZATION_MODES,
  alignBitmapBurst,
  applyStabilizedInsetToCrop,
  drawAlignedFrameToCanvas,
  normalizeStabilizationMode,
  summarizeAlignmentPlan,
} from '../processing/frame-aligner.js';
import {
  AVIF_DEFAULT_OPTIONS,
  AVIF_MIME_TYPE,
  JPEG_MIME_TYPE,
  canvasToEncodedBlob,
  encodeAvifFromRgba,
  isValidAvifBytes,
  resolveOutputFormat,
  supportsNativeCanvasAvif,
  warmupAvifEncoder,
} from '../processing/avif-encoder.js';

function releaseFrames(frames) {
  if (!Array.isArray(frames)) return;
  for (const frame of frames) {
    try {
      frame?.close?.();
    } catch {
      // already closed or transferred
    }
  }
}

function shrinkCanvases(canvases) {
  if (!Array.isArray(canvases)) return;
  for (const c of canvases) {
    if (c) {
      c.width = 1;
      c.height = 1;
    }
  }
}

let webglProcessor = null;
let webglUnavailable = false;

function getWebGLProcessor() {
  if (webglUnavailable) return null;
  if (webglProcessor) return webglProcessor;
  if (typeof OffscreenCanvas !== 'function') {
    webglUnavailable = true;
    return null;
  }
  try {
    const canvas = new OffscreenCanvas(1, 1);
    webglProcessor = new WebGLImageProcessor(canvas);
    return webglProcessor;
  } catch {
    webglUnavailable = true;
    return null;
  }
}

function cropFrameToCanvas(bitmap, crop, mirrorX, alignEntry = null) {
  const canvas = new OffscreenCanvas(crop.outWidth, crop.outHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  drawAlignedFrameToCanvas(
    ctx,
    bitmap,
    crop,
    mirrorX,
    alignEntry,
    crop.outWidth,
    crop.outHeight
  );
  return { canvas, ctx };
}

/**
 * Stabilized motion-aware pixel averaging across up to 4 aligned frames
 * (used when OffscreenCanvas lacks WebGL, e.g., older Safari builds).
 */
function averageFramesCPU(frames, crop, mirrorX, alignEntries = null) {
  const width = crop.outWidth;
  const height = crop.outHeight;
  const buffers = [];
  let workCanvas = null;
  let workCtx = null;

  for (let i = 0; i < frames.length; i++) {
    const alignEntry = Array.isArray(alignEntries) ? alignEntries[i] : null;
    if (!workCanvas) {
      const res = cropFrameToCanvas(frames[i], crop, mirrorX, alignEntry);
      workCanvas = res.canvas;
      workCtx = res.ctx;
    } else {
      drawAlignedFrameToCanvas(
        workCtx,
        frames[i],
        crop,
        mirrorX,
        alignEntry,
        width,
        height
      );
    }
    buffers.push(workCtx.getImageData(0, 0, width, height).data);
    if (i > 0) {
      try {
        frames[i]?.close?.();
      } catch {
        // already closed
      }
    }
  }

  const ref = buffers[0];
  const out = new Uint8ClampedArray(ref.length);
  const frameCount = buffers.length;

  for (let i = 0; i < ref.length; i += 4) {
    const r0 = ref[i];
    const g0 = ref[i + 1];
    const b0 = ref[i + 2];

    let sumR = r0 * 4;
    let sumG = g0 * 4;
    let sumB = b0 * 4;
    let totalW = 4;

    for (let f = 1; f < frameCount; f++) {
      const entry = Array.isArray(alignEntries) ? alignEntries[f] : null;
      const conf = entry?.weight ?? 1;
      if (conf <= 0.01) continue;
      const gain = entry?.lumaGain ?? 1;

      const buf = buffers[f];
      if (buf[i + 3] < 200) continue;
      const rf = Math.min(255, buf[i] * gain);
      const gf = Math.min(255, buf[i + 1] * gain);
      const bf = Math.min(255, buf[i + 2] * gain);
      const diff = Math.abs(rf - r0) + Math.abs(gf - g0) + Math.abs(bf - b0);

      let w = 0;
      if (diff < 24) {
        w = 4 * conf;
      } else if (diff < 46) {
        w = 2 * conf * ((46 - diff) / 22);
      }
      if (w > 0) {
        sumR += rf * w;
        sumG += gf * w;
        sumB += bf * w;
        totalW += w;
      }
    }

    out[i] = Math.round(sumR / totalW);
    out[i + 1] = Math.round(sumG / totalW);
    out[i + 2] = Math.round(sumB / totalW);
    out[i + 3] = 255;
  }

  buffers.length = 0;
  const outImageData = new ImageData(out, width, height);
  workCtx.setTransform(1, 0, 0, 1, 0, 0);
  workCtx.putImageData(outImageData, 0, 0);
  return workCanvas;
}

async function encodeWorkerOutput({
  format,
  webgl,
  canvas,
  ctx2d,
  avifQuality = AVIF_DEFAULT_OPTIONS.quality,
  jpegQuality = 0.95,
  engineBase,
}) {
  if (format === 'jpeg') {
    const blob = await canvasToEncodedBlob(canvas, JPEG_MIME_TYPE, jpegQuality);
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
    return {
      blob,
      mimeType: JPEG_MIME_TYPE,
      format: 'jpeg',
      engine: engineBase,
    };
  }

  if (await supportsNativeCanvasAvif()) {
    const blob = await canvasToEncodedBlob(canvas, AVIF_MIME_TYPE, avifQuality / 100);
    if (blob && blob.type === AVIF_MIME_TYPE && blob.size >= 16) {
      const header = await blob.slice(0, 64).arrayBuffer();
      if (isValidAvifBytes(header)) {
        if (canvas) {
          canvas.width = 1;
          canvas.height = 1;
        }
        return {
          blob,
          mimeType: AVIF_MIME_TYPE,
          format: 'avif',
          engine: `${engineBase}+native-avif`,
        };
      }
    }
  }

  let rgbaPixels;
  let width = canvas.width;
  let height = canvas.height;
  if (webgl) {
    const read = webgl.readRgbaTopDown();
    rgbaPixels = read.data;
    width = read.width;
    height = read.height;
    // Free the full-resolution WebGL drawing buffer before WASM AVIF allocates heap memory
    webgl.canvas.width = 1;
    webgl.canvas.height = 1;
  } else {
    const imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    rgbaPixels = new Uint8Array(
      imageData.data.buffer,
      imageData.data.byteOffset,
      imageData.data.byteLength
    );
    canvas.width = 1;
    canvas.height = 1;
  }

  const blob = await encodeAvifFromRgba(rgbaPixels, width, height, { quality: avifQuality });
  return {
    blob,
    mimeType: AVIF_MIME_TYPE,
    format: 'avif',
    engine: `${engineBase}+wasm-avif`,
  };
}

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'warmup') {
    const webgl = getWebGLProcessor();
    warmupAvifEncoder().catch(() => {});
    supportsNativeCanvasAvif()
      .catch(() => false)
      .then((nativeAvif) => {
        self.postMessage({
          type: 'capabilities',
          maxTextureSize: webgl ? webgl.maxTextureSize : 4096,
          supportsWebGL: Boolean(webgl),
          supportsNativeAvif: Boolean(nativeAvif),
        });
      });
    return;
  }

  if (msg.type === 'encode-avif') {
    const {
      id,
      rgbaBuffer,
      width,
      height,
      avifQuality = AVIF_DEFAULT_OPTIONS.quality,
      engine = 'main-webgl+worker-avif',
    } = msg;
    try {
      const blob = await encodeAvifFromRgba(rgbaBuffer, width, height, { quality: avifQuality });
      self.postMessage({
        id,
        ok: true,
        blob,
        width,
        height,
        format: 'avif',
        mimeType: AVIF_MIME_TYPE,
        engine,
      });
    } catch (err) {
      self.postMessage({
        id,
        ok: false,
        error: err?.message || String(err),
      });
    }
    return;
  }

  if (msg.type !== 'process') return;

  const {
    id,
    mode = 'hq',
    frames = [],
    aspectRatio = '4:3',
    softwareZoom = 1,
    mirrorX = false,
    exposureEv = 0,
    outputMegapixels = 'max',
    maxDimension = null,
    jpegQuality = 0.95,
    avifQuality = AVIF_DEFAULT_OPTIONS.quality,
  } = msg;
  const outputFormat = resolveOutputFormat(msg.outputFormat);
  const stabilizationMode = normalizeStabilizationMode(msg.stabilizationMode);

  const intermediates = [];

  let fallbackMaxDim = 4096;

  try {
    if (!frames.length) {
      throw new Error('No frames provided to image processor worker');
    }

    const srcW = frames[0].width;
    const srcH = frames[0].height;
    const webgl = getWebGLProcessor();
    const nativeAvif =
      outputFormat === 'avif' ? await supportsNativeCanvasAvif().catch(() => false) : false;
    const texLimit = webgl ? webgl.maxTextureSize : 4096;
    const encoderMax = getEncoderMaxDimension({
      outputFormat,
      maxTextureSize: texLimit,
      supportsNativeAvif: nativeAvif,
      aspectRatio,
    });
    const mpDim = computeMaxDimensionForMegapixels({
      outputMegapixels,
      aspectRatio,
      outputFormat,
      maxTextureSize: texLimit,
      supportsNativeAvif: nativeAvif,
    });
    const maxDim =
      typeof maxDimension === 'number' && Number.isFinite(maxDimension) && maxDimension >= 320
        ? Math.max(320, Math.min(encoderMax, Math.round(maxDimension)))
        : mpDim;
    fallbackMaxDim = maxDim;

    let workingFrames = frames;
    let alignmentPlan = null;
    let stabilizationInfo = null;

    if (typeof OffscreenCanvas === 'function' && mode === 'hq' && frames.length > 1) {
      alignmentPlan = alignBitmapBurst({
        frames,
        stabilizationMode,
        createCanvas: (w, h) => new OffscreenCanvas(w, h),
        maxFrames: 4,
      });
      workingFrames = alignmentPlan.selectedIndices.map((idx) => frames[idx]);
      const adoptedSet = new Set(alignmentPlan.selectedIndices);
      for (let i = 0; i < frames.length; i++) {
        if (!adoptedSet.has(i)) {
          try {
            frames[i]?.close?.();
          } catch {
            // already closed
          }
        }
      }
      stabilizationInfo = summarizeAlignmentPlan(alignmentPlan, frames.length, stabilizationMode);
    }

    if (webgl) {
      const baseCrop = computeAspectCrop(
        srcW,
        srcH,
        aspectRatio,
        softwareZoom,
        maxDim
      );
      const crop = applyStabilizedInsetToCrop(baseCrop, alignmentPlan?.safeCrop);

      let gpuSources = workingFrames;
      let cropNorm = {
        x: crop.sx / srcW,
        y: crop.sy / srcH,
        w: crop.sw / srcW,
        h: crop.sh / srcH,
      };
      let applyMirrorInShader = mirrorX;
      let frameAlignments = alignmentPlan?.entries || null;

      // Downscale & pre-align pre-cropped inputs only if raw sensor size exceeds WebGL MAX_TEXTURE_SIZE
      if (srcW > webgl.maxTextureSize || srcH > webgl.maxTextureSize) {
        gpuSources = workingFrames.map((frame, idx) => {
          const { canvas } = cropFrameToCanvas(
            frame,
            crop,
            mirrorX,
            alignmentPlan?.entries?.[idx] || null
          );
          intermediates.push(canvas);
          return canvas;
        });
        cropNorm = { x: 0, y: 0, w: 1, h: 1 };
        applyMirrorInShader = false;
        if (frameAlignments) {
          frameAlignments = frameAlignments.map((entry) => ({
            ...entry,
            uvMatrix: { mat: [1, 0, 0, 1], shift: [0, 0] },
          }));
        }
      }

      if (mode === 'hq') {
        webgl.processHQ(gpuSources, {
          outWidth: crop.outWidth,
          outHeight: crop.outHeight,
          cropNorm,
          mirrorX: applyMirrorInShader,
          exposureEv,
          frameAlignments,
          patchTol2: stabilizationMode === STABILIZATION_MODES.OFF ? 0.0085 : 0.0018,
          sharpen: stabilizationMode === STABILIZATION_MODES.HIGH ? 0.62 : 0.54,
        });
      } else {
        webgl.processStandard(gpuSources[0], {
          outWidth: crop.outWidth,
          outHeight: crop.outHeight,
          cropNorm,
          mirrorX: applyMirrorInShader,
          exposureEv,
        });
      }

      // WebGL has already rendered to webgl.canvas; release all source bitmaps and temp canvases before encoding
      releaseFrames(frames);
      shrinkCanvases(intermediates);
      intermediates.length = 0;

      const encoded = await encodeWorkerOutput({
        format: outputFormat,
        webgl,
        canvas: webgl.canvas,
        avifQuality,
        jpegQuality,
        engineBase: 'worker-webgl',
      });

      self.postMessage({
        id,
        ok: true,
        blob: encoded.blob,
        width: crop.outWidth,
        height: crop.outHeight,
        format: encoded.format,
        mimeType: encoded.mimeType,
        engine: encoded.engine,
        stabilizationInfo,
      });
      return;
    }

    // Fallback when Worker OffscreenCanvas lacks WebGL (e.g. iOS 16.4-16.6 Safari):
    // Still perform full frame selection, alignment, and low-ghost averaging inside Worker!
    if (typeof OffscreenCanvas === 'function' && mode === 'hq' && workingFrames.length > 1) {
      const baseCrop = computeAspectCrop(srcW, srcH, aspectRatio, softwareZoom, maxDim);
      const crop = applyStabilizedInsetToCrop(baseCrop, alignmentPlan?.safeCrop);
      const averagedCanvas = averageFramesCPU(
        workingFrames,
        crop,
        mirrorX,
        alignmentPlan?.entries || null
      );
      releaseFrames(frames);
      const averagedBitmap = averagedCanvas.transferToImageBitmap();
      self.postMessage(
        {
          id,
          ok: true,
          needsMainWebGL: true,
          averagedBitmap,
          width: crop.outWidth,
          height: crop.outHeight,
          engine: 'worker-cpu-avg+main-webgl',
          stabilizationInfo,
        },
        [averagedBitmap]
      );
      return;
    }

    // Ultimate Canvas2D fallback inside Worker so transferred bitmaps are never lost
    if (typeof OffscreenCanvas === 'function') {
      const crop = computeAspectCrop(srcW, srcH, aspectRatio, softwareZoom, maxDim);
      const refBmp = workingFrames[0] || frames[0];
      const { canvas, ctx } = cropFrameToCanvas(refBmp, crop, mirrorX);
      releaseFrames(frames);
      const encoded = await encodeWorkerOutput({
        format: outputFormat,
        canvas,
        ctx2d: ctx,
        avifQuality,
        jpegQuality,
        engineBase: 'worker-canvas2d',
      });
      self.postMessage({
        id,
        ok: true,
        blob: encoded.blob,
        width: crop.outWidth,
        height: crop.outHeight,
        format: encoded.format,
        mimeType: encoded.mimeType,
        engine: encoded.engine,
        stabilizationInfo,
      });
      return;
    }

    self.postMessage({
      id,
      ok: false,
      fallbackToMain: true,
      reason: 'offscreen-canvas-unavailable',
    });
  } catch (err) {
    // Attempt single-frame 2D rescue before reporting failure
    try {
      const rescueFrame = frames.find((f) => f && f.width > 0);
      if (typeof OffscreenCanvas === 'function' && rescueFrame) {
        const crop = computeAspectCrop(
          rescueFrame.width,
          rescueFrame.height,
          aspectRatio,
          softwareZoom,
          fallbackMaxDim
        );
        const { canvas, ctx } = cropFrameToCanvas(rescueFrame, crop, mirrorX);
        releaseFrames(frames);
        const encoded = await encodeWorkerOutput({
          format: outputFormat,
          canvas,
          ctx2d: ctx,
          avifQuality,
          jpegQuality,
          engineBase: 'worker-rescue-2d',
        });
        self.postMessage({
          id,
          ok: true,
          blob: encoded.blob,
          width: crop.outWidth,
          height: crop.outHeight,
          format: encoded.format,
          mimeType: encoded.mimeType,
          engine: encoded.engine,
        });
        return;
      }
    } catch {
      // ignore rescue error
    }
    self.postMessage({
      id,
      ok: false,
      fallbackToMain: true,
      error: err?.message || String(err),
    });
  } finally {
    releaseFrames(frames);
    shrinkCanvases(intermediates);
  }
});
