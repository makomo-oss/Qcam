import { computeAspectCrop } from '../utils/geometry.js';
import { WebGLImageProcessor } from '../processing/webgl-processor.js';
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

function cropFrameToCanvas(bitmap, crop, mirrorX) {
  const canvas = new OffscreenCanvas(crop.outWidth, crop.outHeight);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (mirrorX) {
    ctx.translate(crop.outWidth, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(
    bitmap,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    crop.outWidth,
    crop.outHeight
  );
  return { canvas, ctx };
}

/**
 * Motion-aware integer pixel averaging across up to 4 frames for low-light noise reduction.
 */
function averageFramesCPU(frames, crop, mirrorX) {
  const width = crop.outWidth;
  const height = crop.outHeight;
  const buffers = [];
  let workCanvas = null;
  let workCtx = null;

  for (let i = 0; i < frames.length; i++) {
    if (!workCanvas) {
      const res = cropFrameToCanvas(frames[i], crop, mirrorX);
      workCanvas = res.canvas;
      workCtx = res.ctx;
    } else {
      workCtx.setTransform(1, 0, 0, 1, 0, 0);
      if (mirrorX) {
        workCtx.translate(width, 0);
        workCtx.scale(-1, 1);
      }
      workCtx.clearRect(0, 0, width, height);
      workCtx.drawImage(
        frames[i],
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        0,
        0,
        width,
        height
      );
    }
    buffers.push(workCtx.getImageData(0, 0, width, height).data);
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
      const buf = buffers[f];
      const rf = buf[i];
      const gf = buf[i + 1];
      const bf = buf[i + 2];
      const diff =
        Math.abs(rf - r0) + Math.abs(gf - g0) + Math.abs(bf - b0);

      let w = 0;
      if (diff < 54) {
        w = 4;
      } else if (diff < 108) {
        w = 2;
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
  } else {
    const imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
    rgbaPixels = new Uint8Array(
      imageData.data.buffer,
      imageData.data.byteOffset,
      imageData.data.byteLength
    );
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
    getWebGLProcessor();
    warmupAvifEncoder().catch(() => {});
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
    mode = 'standard',
    frames = [],
    aspectRatio = '4:3',
    softwareZoom = 1,
    mirrorX = false,
    exposureEv = 0,
    jpegQuality = 0.95,
    avifQuality = AVIF_DEFAULT_OPTIONS.quality,
  } = msg;
  const outputFormat = resolveOutputFormat(msg.outputFormat);

  const intermediates = [];

  try {
    if (!frames.length) {
      throw new Error('No frames provided to image processor worker');
    }

    const srcW = frames[0].width;
    const srcH = frames[0].height;
    const webgl = getWebGLProcessor();

    if (webgl) {
      const maxDim =
        outputFormat === 'avif'
          ? Math.min(webgl.maxTextureSize, 4096)
          : webgl.maxTextureSize;
      const crop = computeAspectCrop(
        srcW,
        srcH,
        aspectRatio,
        softwareZoom,
        maxDim
      );

      let gpuSources = frames;
      let cropNorm = {
        x: crop.sx / srcW,
        y: crop.sy / srcH,
        w: crop.sw / srcW,
        h: crop.sh / srcH,
      };
      let applyMirrorInShader = mirrorX;

      // Downscale pre-cropped inputs only if raw sensor size exceeds WebGL MAX_TEXTURE_SIZE
      if (srcW > webgl.maxTextureSize || srcH > webgl.maxTextureSize) {
        gpuSources = frames.map((frame) => {
          const { canvas } = cropFrameToCanvas(frame, crop, mirrorX);
          intermediates.push(canvas);
          return canvas;
        });
        cropNorm = { x: 0, y: 0, w: 1, h: 1 };
        applyMirrorInShader = false;
      }

      if (mode === 'hq') {
        webgl.processHQ(gpuSources, {
          outWidth: crop.outWidth,
          outHeight: crop.outHeight,
          cropNorm,
          mirrorX: applyMirrorInShader,
          exposureEv,
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
      });
      return;
    }

    // Fallback when Worker OffscreenCanvas lacks WebGL (e.g. iOS 16.4-16.6 Safari):
    // Still offload heavy multi-frame pixel averaging to the Worker!
    if (typeof OffscreenCanvas === 'function' && mode === 'hq' && frames.length > 1) {
      const crop = computeAspectCrop(srcW, srcH, aspectRatio, softwareZoom, 4096);
      const averagedCanvas = averageFramesCPU(frames, crop, mirrorX);
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
        },
        [averagedBitmap]
      );
      return;
    }

    // Ultimate Canvas2D fallback inside Worker so transferred bitmaps are never lost
    if (typeof OffscreenCanvas === 'function') {
      const crop = computeAspectCrop(srcW, srcH, aspectRatio, softwareZoom, 4096);
      const { canvas, ctx } = cropFrameToCanvas(frames[0], crop, mirrorX);
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
      if (typeof OffscreenCanvas === 'function' && frames.length && frames[0].width > 0) {
        const crop = computeAspectCrop(
          frames[0].width,
          frames[0].height,
          aspectRatio,
          softwareZoom,
          4096
        );
        const { canvas, ctx } = cropFrameToCanvas(frames[0], crop, mirrorX);
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
    for (const frame of frames) {
      try {
        frame.close();
      } catch {
        // already closed or transferred
      }
    }
    for (const c of intermediates) {
      c.width = 1;
      c.height = 1;
    }
  }
});
