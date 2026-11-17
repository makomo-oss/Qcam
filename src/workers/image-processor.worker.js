import { computeAspectCrop } from '../utils/geometry.js';
import { WebGLImageProcessor } from '../processing/webgl-processor.js';

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

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'process') return;

  const {
    id,
    mode = 'standard',
    frames = [],
    aspectRatio = '4:3',
    softwareZoom = 1,
    mirrorX = false,
    exposureEv = 0,
    jpegQuality = 0.95,
  } = msg;

  const intermediates = [];

  try {
    if (!frames.length) {
      throw new Error('No frames provided to image processor worker');
    }

    const srcW = frames[0].width;
    const srcH = frames[0].height;
    const webgl = getWebGLProcessor();

    if (webgl) {
      const crop = computeAspectCrop(
        srcW,
        srcH,
        aspectRatio,
        softwareZoom,
        webgl.maxTextureSize
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

      const blob = await webgl.canvas.convertToBlob({
        type: 'image/jpeg',
        quality: jpegQuality,
      });

      self.postMessage({
        id,
        ok: true,
        blob,
        width: crop.outWidth,
        height: crop.outHeight,
        engine: 'worker-webgl',
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
      const { canvas } = cropFrameToCanvas(frames[0], crop, mirrorX);
      const blob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: jpegQuality,
      });
      self.postMessage({
        id,
        ok: true,
        blob,
        width: crop.outWidth,
        height: crop.outHeight,
        engine: 'worker-canvas2d',
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
        const { canvas } = cropFrameToCanvas(frames[0], crop, mirrorX);
        const blob = await canvas.convertToBlob({
          type: 'image/jpeg',
          quality: jpegQuality,
        });
        self.postMessage({
          id,
          ok: true,
          blob,
          width: crop.outWidth,
          height: crop.outHeight,
          engine: 'worker-rescue-2d',
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
