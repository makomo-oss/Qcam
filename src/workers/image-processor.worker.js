import { computeAspectCrop } from '../utils/geometry.js';
import {
  computeMaxDimensionForMegapixels,
  getEncoderMaxDimension,
} from '../utils/resolution.js';
import { WebGLImageProcessor } from '../processing/webgl-processor.js';
import {
  COLOR_PROFILES,
  STABILIZATION_MODES,
  alignBitmapBurst,
  applyStabilizedInsetToCrop,
  computeProDevelopProfile,
  drawAlignedFrameToCanvas,
  normalizeColorProfile,
  normalizeStabilizationMode,
  summarizeAlignmentPlan,
} from '../processing/frame-aligner.js';
import {
  AVIF_DEFAULT_OPTIONS,
  AVIF_MIME_TYPE,
  JPEG_MIME_TYPE,
  canvasToEncodedBlob,
  encodeAvifBytesFromRgba,
  encodeAvifFromRgba,
  getCompiledWasmModule,
  isValidAvifBytes,
  primeCompiledWasmModule,
  resolveAdaptiveAvifOptions,
  resolveOutputFormat,
  supportsNativeCanvasAvif,
  warmupAvifEncoder,
} from '../processing/avif-encoder.js';
import {
  extractAvifGridTiles,
  muxAvifGrid,
  planAvifGrid,
} from '../processing/avif-grid-muxer.js';

const DEFAULT_JPEG_QUALITY = 0.96;

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

const tilePorts = [];
const pendingTileJobs = new Map();
let nextTileJobId = 1;
let sharedCompiledWasm = null;

function broadcastWasmWarmupToTilePorts(wasmModule) {
  for (const entry of tilePorts) {
    const port = entry.port;
    try {
      port.postMessage(wasmModule ? { type: 'warmup', wasmModule } : { type: 'warmup' });
    } catch {
      try {
        port.postMessage({ type: 'warmup' });
      } catch {
        // ignore detached port
      }
    }
  }
}

function detachTilePort(portId) {
  for (let i = tilePorts.length - 1; i >= 0; i--) {
    if (tilePorts[i].id === portId) {
      try {
        tilePorts[i].port.close();
      } catch {
        // ignore
      }
      tilePorts.splice(i, 1);
    }
  }
  for (const [jobId, job] of pendingTileJobs.entries()) {
    if (job.portId === portId) {
      pendingTileJobs.delete(jobId);
      job.reject(new Error('Tile worker detached'));
    }
  }
}

function attachTilePort(port, portId = tilePorts.length + 1) {
  if (!port) return;
  port.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.type !== 'tile-result') return;
    const entry = pendingTileJobs.get(data.jobId);
    if (!entry) return;
    pendingTileJobs.delete(data.jobId);
    if (data.ok && data.avifBuffer) {
      entry.resolve(new Uint8Array(data.avifBuffer));
    } else {
      entry.reject(new Error(data.error || 'Tile AVIF encode failed'));
    }
  });
  port.addEventListener('messageerror', () => {
    detachTilePort(portId);
  });
  port.start();
  tilePorts.push({ id: portId, port });
  if (sharedCompiledWasm) {
    try {
      port.postMessage({ type: 'warmup', wasmModule: sharedCompiledWasm });
    } catch {
      try {
        port.postMessage({ type: 'warmup' });
      } catch {
        // ignore
      }
    }
  }
}

function dispatchTileEncode(portEntry, tile, options) {
  const jobId = nextTileJobId++;
  return new Promise((resolve, reject) => {
    pendingTileJobs.set(jobId, { resolve, reject, portId: portEntry.id });
    try {
      portEntry.port.postMessage(
        {
          type: 'encode-tile',
          jobId,
          tileIndex: tile.index,
          rgbaBuffer: tile.rgba.buffer,
          width: tile.width,
          height: tile.height,
          options,
        },
        [tile.rgba.buffer]
      );
    } catch (err) {
      pendingTileJobs.delete(jobId);
      reject(err);
    }
  });
}

async function encodeAvifParallelOrSingle(rgbaInput, width, height, avifQuality) {
  const totalWorkers = 1 + tilePorts.length;
  const grid = planAvifGrid(width, height, totalWorkers);

  if (grid.cols * grid.rows > 1 && tilePorts.length >= 1) {
    try {
      const rgbaView =
        rgbaInput instanceof Uint8Array
          ? rgbaInput
          : rgbaInput instanceof ArrayBuffer
          ? new Uint8Array(rgbaInput)
          : new Uint8Array(rgbaInput.buffer, rgbaInput.byteOffset, rgbaInput.byteLength);

      // Resolve adaptive quality/speed/SharpYUV once against full image dimensions
      const fullOpts = resolveAdaptiveAvifOptions(width, height, { quality: avifQuality });
      const tiles = extractAvifGridTiles(rgbaView, width, height, grid);

      // Dispatch tiles 1..N-1 to auxiliary workers over direct MessageChannel ports
      // while encoding tile 0 concurrently in this worker.
      const tilePromises = new Array(tiles.length);
      for (let i = 1; i < tiles.length; i++) {
        const portEntry = tilePorts[(i - 1) % tilePorts.length];
        tilePromises[i] = dispatchTileEncode(portEntry, tiles[i], fullOpts);
      }
      tilePromises[0] = encodeAvifBytesFromRgba(
        tiles[0].rgba,
        tiles[0].width,
        tiles[0].height,
        fullOpts
      );

      const tileAvifs = await Promise.all(tilePromises);
      const muxed = muxAvifGrid({
        outputWidth: width,
        outputHeight: height,
        tileWidth: grid.tileWidth,
        tileHeight: grid.tileHeight,
        cols: grid.cols,
        rows: grid.rows,
        tileAvifs,
      });

      if (muxed && isValidAvifBytes(muxed)) {
        return {
          blob: new Blob([muxed], { type: AVIF_MIME_TYPE }),
          parallelTiles: tiles.length,
        };
      }
    } catch {
      // Fall back cleanly to single-worker AVIF encoding
    }
  }

  const blob = await encodeAvifFromRgba(rgbaInput, width, height, { quality: avifQuality });
  return { blob, parallelTiles: 1 };
}

function cropFrameToCanvas(bitmap, crop, mirrorX, alignEntry = null) {
  const canvas = new OffscreenCanvas(crop.outWidth, crop.outHeight);
  const ctx = canvas.getContext('2d');
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
 * Stabilized noise-calibrated motion-aware pixel averaging across up to 4 aligned frames
 * (used when OffscreenCanvas lacks WebGL, e.g., older Safari builds).
 */
function averageFramesCPU(frames, crop, mirrorX, alignEntries = null, noiseSigma = 0.012) {
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
  const noiseLift = Math.round(Math.max(0, Number(noiseSigma) || 0) * 180);
  const tightThresh = 22 + noiseLift;
  const looseThresh = 44 + Math.round(noiseLift * 1.5);
  const falloffSpan = Math.max(8, looseThresh - tightThresh);

  let extraWeightSum = 0;
  const pixelCount = Math.max(1, ref.length / 4);

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
      if (diff < tightThresh) {
        w = 4 * conf;
      } else if (diff < looseThresh) {
        w = 2 * conf * ((looseThresh - diff) / falloffSpan);
      }
      if (w > 0) {
        sumR += rf * w;
        sumG += gf * w;
        sumB += bf * w;
        totalW += w;
        extraWeightSum += w * 0.25;
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

  const preMergedCoverage =
    frameCount > 1
      ? Math.max(0, Math.min(1, extraWeightSum / (pixelCount * 3)))
      : 0;
  return { canvas: workCanvas, preMergedCoverage };
}

async function encodeWorkerOutput({
  format,
  webgl,
  canvas,
  ctx2d,
  avifQuality = AVIF_DEFAULT_OPTIONS.quality,
  jpegQuality = DEFAULT_JPEG_QUALITY,
  engineBase,
  nativeAvif = null,
}) {
  if (format === 'jpeg') {
    const blob = await canvasToEncodedBlob(canvas, JPEG_MIME_TYPE, jpegQuality);
    if (webgl) {
      webgl.releaseWorkingBuffers();
    }
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

  const canUseNativeAvif =
    nativeAvif !== null ? Boolean(nativeAvif) : await supportsNativeCanvasAvif();
  if (canUseNativeAvif) {
    const blob = await canvasToEncodedBlob(canvas, AVIF_MIME_TYPE, avifQuality / 100);
    if (blob && blob.type === AVIF_MIME_TYPE && blob.size >= 16) {
      const header = await blob.slice(0, 64).arrayBuffer();
      if (isValidAvifBytes(header)) {
        if (webgl) {
          webgl.releaseWorkingBuffers();
        }
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
    // Free intermediate WebGL textures/FBOs & full-resolution canvas before WASM AVIF allocates heap memory
    webgl.releaseWorkingBuffers();
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

  const { blob, parallelTiles } = await encodeAvifParallelOrSingle(
    rgbaPixels,
    width,
    height,
    avifQuality
  );
  return {
    blob,
    mimeType: AVIF_MIME_TYPE,
    format: 'avif',
    engine:
      parallelTiles > 1
        ? `${engineBase}+wasm-avif-grid${parallelTiles}`
        : `${engineBase}+wasm-avif`,
  };
}

self.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg) return;

  if (msg.type === 'attach-tile-port' && msg.port) {
    attachTilePort(msg.port, msg.portId);
    return;
  }

  if (msg.type === 'detach-tile-port') {
    detachTilePort(msg.portId);
    return;
  }

  if (msg.type === 'warmup') {
    const webgl = getWebGLProcessor();
    if (msg.wasmModule) {
      sharedCompiledWasm = msg.wasmModule;
      primeCompiledWasmModule(msg.wasmModule);
    }
    supportsNativeCanvasAvif()
      .catch(() => false)
      .then((nativeAvif) => {
        self.postMessage({
          type: 'capabilities',
          maxTextureSize: webgl ? webgl.maxTextureSize : 4096,
          supportsWebGL: Boolean(webgl),
          supportsNativeAvif: Boolean(nativeAvif),
        });
        if (webgl) {
          setTimeout(() => webgl.warmup(), 250);
        }
        if (!nativeAvif) {
          getCompiledWasmModule()
            .then((mod) => {
              sharedCompiledWasm = mod;
              broadcastWasmWarmupToTilePorts(mod);
              return warmupAvifEncoder({ forceWasm: true, wasmModule: mod });
            })
            .catch(() => {});
        }
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
      engine = 'main-webgl-pro+worker-avif',
    } = msg;
    try {
      const { blob, parallelTiles } = await encodeAvifParallelOrSingle(
        rgbaBuffer,
        width,
        height,
        avifQuality
      );
      self.postMessage({
        id,
        ok: true,
        blob,
        width,
        height,
        format: 'avif',
        mimeType: AVIF_MIME_TYPE,
        engine: parallelTiles > 1 ? `${engine}-grid${parallelTiles}` : engine,
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
    jpegQuality = DEFAULT_JPEG_QUALITY,
    avifQuality = AVIF_DEFAULT_OPTIONS.quality,
  } = msg;
  const outputFormat = resolveOutputFormat(msg.outputFormat);
  const stabilizationMode = normalizeStabilizationMode(msg.stabilizationMode);
  const colorProfile = normalizeColorProfile(msg.colorProfile || COLOR_PROFILES.NATURAL);

  const intermediates = [];
  let fallbackMaxDim = 4096;
  let gpuSession = null;

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

    if (webgl && srcW <= webgl.maxTextureSize && srcH <= webgl.maxTextureSize) {
      try {
        const sessionFrames = mode === 'hq' ? frames : [frames[0]];
        gpuSession = webgl.createFrameTextureSession(sessionFrames);
      } catch {
        gpuSession = null;
      }
    }

    if (typeof OffscreenCanvas === 'function' || gpuSession) {
      alignmentPlan = alignBitmapBurst({
        frames,
        stabilizationMode,
        colorProfile,
        createCanvas:
          typeof OffscreenCanvas === 'function' ? (w, h) => new OffscreenCanvas(w, h) : null,
        maxFrames: mode === 'hq' ? 4 : 1,
        gpuSession,
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
      if (mode === 'hq' && frames.length > 1) {
        stabilizationInfo = summarizeAlignmentPlan(alignmentPlan, frames.length, stabilizationMode);
      }
    }

    const developProfile =
      alignmentPlan?.developProfile ||
      computeProDevelopProfile(alignmentPlan?.sceneStats || null, {
        frameCount: workingFrames.length,
        mergedCount: workingFrames.length,
        stabilizationMode,
        colorProfile,
      });

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
      let preUploadedTextures = null;

      // Downscale & pre-align pre-cropped inputs only if raw sensor size exceeds WebGL MAX_TEXTURE_SIZE
      if (srcW > webgl.maxTextureSize || srcH > webgl.maxTextureSize) {
        gpuSession?.dispose?.();
        gpuSession = null;
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
      } else if (gpuSession) {
        const selected = alignmentPlan ? alignmentPlan.selectedIndices : [0];
        const taken = gpuSession.takeSelectedTextures(selected);
        if (taken.length === gpuSources.length) {
          preUploadedTextures = taken;
        }
      }

      // Render Y-flipped directly when feeding gl.readPixels -> WASM AVIF so CPU row reversal is skipped
      const flipOutputY = outputFormat === 'avif' && !nativeAvif;
      if (mode === 'hq') {
        webgl.processHQ(gpuSources, {
          outWidth: crop.outWidth,
          outHeight: crop.outHeight,
          cropNorm,
          mirrorX: applyMirrorInShader,
          exposureEv,
          frameAlignments,
          developProfile,
          flipOutputY,
          preUploadedTextures,
        });
      } else {
        webgl.processStandard(gpuSources[0], {
          outWidth: crop.outWidth,
          outHeight: crop.outHeight,
          cropNorm,
          mirrorX: applyMirrorInShader,
          exposureEv,
          developProfile,
          flipOutputY,
          preUploadedTextures,
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
        engineBase: 'worker-webgl-pro',
        nativeAvif,
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
    // Still perform full frame selection, alignment, noise analysis, and ghost-free averaging inside Worker!
    if (typeof OffscreenCanvas === 'function' && mode === 'hq' && workingFrames.length > 1) {
      const baseCrop = computeAspectCrop(srcW, srcH, aspectRatio, softwareZoom, maxDim);
      const crop = applyStabilizedInsetToCrop(baseCrop, alignmentPlan?.safeCrop);
      const avgResult = averageFramesCPU(
        workingFrames,
        crop,
        mirrorX,
        alignmentPlan?.entries || null,
        alignmentPlan?.sceneStats?.noiseSigma
      );
      releaseFrames(frames);
      const averagedBitmap = avgResult.canvas.transferToImageBitmap();
      self.postMessage(
        {
          id,
          ok: true,
          needsMainWebGL: true,
          averagedBitmap,
          width: crop.outWidth,
          height: crop.outHeight,
          engine: 'worker-cpu-avg+main-webgl-pro',
          stabilizationInfo,
          colorProfile,
          sceneStats: alignmentPlan?.sceneStats || null,
          preMergedCoverage: avgResult.preMergedCoverage,
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
        nativeAvif,
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
    gpuSession?.dispose?.();
    releaseFrames(frames);
    shrinkCanvases(intermediates);
  }
});
