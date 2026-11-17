import { computeAspectCrop } from '../utils/geometry.js';
import {
  computeMaxDimensionForMegapixels,
  getEncoderMaxDimension,
} from '../utils/resolution.js';
import { WebGLImageProcessor } from './webgl-processor.js';
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
} from './avif-encoder.js';

const JPEG_QUALITY = 0.95;

/**
 * Coordinates image processing across Web Worker (preferred) and main-thread WebGL / Canvas2D fallback.
 */
export class ImagePipeline {
  constructor(platform) {
    this.platform = platform;
    this.worker = null;
    this.mainWebGL = null;
    this.pending = new Map();
    this.nextJobId = 1;
    this.maxTextureSize = 4096;
    this.supportsNativeAvif = false;
    this.onCapabilitiesChange = null;
    this._initWorker();
  }

  _initWorker() {
    if (!this.platform.supportsWorker) return;
    try {
      this.worker = new Worker(
        new URL('../workers/image-processor.worker.js', import.meta.url),
        { type: 'module' }
      );
      this.worker.addEventListener('message', (event) => {
        const data = event.data;
        if (data?.type === 'capabilities') {
          if (typeof data.maxTextureSize === 'number' && data.maxTextureSize > 0) {
            this.maxTextureSize = data.maxTextureSize;
          }
          this.supportsNativeAvif = Boolean(data.supportsNativeAvif);
          if (typeof this.onCapabilitiesChange === 'function') {
            this.onCapabilitiesChange(this.getCapabilities());
          }
          return;
        }
        if (!data || !this.pending.has(data.id)) return;
        const { resolve } = this.pending.get(data.id);
        this.pending.delete(data.id);
        resolve(data);
      });
      this.worker.addEventListener('error', () => {
        // Reject pending jobs so main-thread fallback picks up seamlessly
        for (const [, entry] of this.pending) {
          entry.resolve({ ok: false, fallbackToMain: true });
        }
        this.pending.clear();
        this.worker = null;
      });
    } catch {
      this.worker = null;
    }
  }

  _getMainWebGL() {
    if (this.mainWebGL) return this.mainWebGL;
    try {
      const canvas = document.createElement('canvas');
      this.mainWebGL = new WebGLImageProcessor(canvas);
      return this.mainWebGL;
    } catch {
      return null;
    }
  }

  getCapabilities() {
    return {
      maxTextureSize: this.maxTextureSize,
      supportsNativeAvif: this.supportsNativeAvif,
    };
  }

  warmup() {
    if (this.worker) {
      this.worker.postMessage({ type: 'warmup' });
    } else {
      warmupAvifEncoder().catch(() => {});
    }
    if (!this.worker || !this.platform.supportsOffscreenWebGL) {
      const webgl = this._getMainWebGL();
      if (webgl && webgl.maxTextureSize) {
        this.maxTextureSize = webgl.maxTextureSize;
      }
      supportsNativeCanvasAvif()
        .catch(() => false)
        .then((native) => {
          this.supportsNativeAvif = Boolean(native);
          if (typeof this.onCapabilitiesChange === 'function') {
            this.onCapabilitiesChange(this.getCapabilities());
          }
        });
    }
  }

  async _encodeRgbaToAvif({ rgbaPixels, width, height, avifQuality, engineBase }) {
    if (this.worker) {
      const buf =
        rgbaPixels.byteOffset === 0 && rgbaPixels.byteLength === rgbaPixels.buffer.byteLength
          ? rgbaPixels.buffer
          : new Uint8Array(rgbaPixels).buffer;
      const id = this.nextJobId++;
      const res = await new Promise((resolve) => {
        this.pending.set(id, { resolve });
        this.worker.postMessage(
          {
            id,
            type: 'encode-avif',
            rgbaBuffer: buf,
            width,
            height,
            avifQuality,
            engine: `${engineBase}+worker-avif`,
          },
          [buf]
        );
      });
      if (res.ok && res.blob) {
        return {
          blob: res.blob,
          width: res.width,
          height: res.height,
          format: 'avif',
          mimeType: AVIF_MIME_TYPE,
          engine: res.engine,
        };
      }
      throw new Error(res.error || 'AVIF エンコードに失敗しました。');
    }

    const blob = await encodeAvifFromRgba(rgbaPixels, width, height, { quality: avifQuality });
    return {
      blob,
      width,
      height,
      format: 'avif',
      mimeType: AVIF_MIME_TYPE,
      engine: `${engineBase}+wasm-avif`,
    };
  }

  async _encodeMainCanvas({
    format,
    webgl,
    canvas,
    ctx2d,
    width,
    height,
    avifQuality,
    jpegQuality,
    engineBase,
  }) {
    if (format === 'jpeg') {
      const blob = await canvasToEncodedBlob(canvas, JPEG_MIME_TYPE, jpegQuality);
      return {
        blob,
        width,
        height,
        format: 'jpeg',
        mimeType: JPEG_MIME_TYPE,
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
            width,
            height,
            format: 'avif',
            mimeType: AVIF_MIME_TYPE,
            engine: `${engineBase}+native-avif`,
          };
        }
      }
    }

    let rgbaPixels;
    if (webgl) {
      rgbaPixels = webgl.readRgbaTopDown().data;
    } else {
      const imageData = ctx2d.getImageData(0, 0, width, height);
      rgbaPixels = new Uint8Array(
        imageData.data.buffer,
        imageData.data.byteOffset,
        imageData.data.byteLength
      );
    }

    return this._encodeRgbaToAvif({
      rgbaPixels,
      width,
      height,
      avifQuality,
      engineBase,
    });
  }

  /**
   * Process captured frame(s) and return encoded AVIF (default) or JPEG Blob + metadata.
   */
  async process({
    mode = 'hq',
    frames = [],
    aspectRatio = '4:3',
    softwareZoom = 1,
    mirrorX = false,
    exposureEv = 0,
    outputFormat = 'avif',
    outputMegapixels = 'max',
    maxDimension = null,
    jpegQuality = JPEG_QUALITY,
    avifQuality = AVIF_DEFAULT_OPTIONS.quality,
  }) {
    const startTs = performance.now();
    const format = resolveOutputFormat(outputFormat);

    if (!frames.length) {
      throw new Error('処理するフレームがありません。');
    }

    // Try Web Worker first when OffscreenCanvas is available
    if (this.worker && this.platform.supportsOffscreenCanvas) {
      const id = this.nextJobId++;
      // Keep bitmaps on main thread when Worker lacks OffscreenCanvas WebGL on single-frame shots;
      // Worker still offloads multi-frame HQ averaging and AVIF WASM encoding.
      if (this.platform.supportsOffscreenWebGL || mode === 'hq') {
        const result = await new Promise((resolve) => {
          this.pending.set(id, { resolve });
          this.worker.postMessage(
            {
              id,
              type: 'process',
              mode,
              frames,
              aspectRatio,
              softwareZoom,
              mirrorX,
              exposureEv,
              outputFormat: format,
              outputMegapixels,
              maxDimension,
              jpegQuality,
              avifQuality,
            },
            frames
          );
        });

        if (result.ok && result.blob) {
          return {
            blob: result.blob,
            width: result.width,
            height: result.height,
            format: result.format || format,
            mimeType: result.mimeType || (format === 'jpeg' ? JPEG_MIME_TYPE : AVIF_MIME_TYPE),
            engine: result.engine,
            processTimeMs: Math.round(performance.now() - startTs),
          };
        }

        if (result.ok && result.needsMainWebGL && result.averagedBitmap) {
          try {
            const out = await this._processOnMainThread({
              mode: 'hq',
              frames: [result.averagedBitmap],
              aspectRatio,
              softwareZoom: 1, // Already cropped & mirrored in Worker
              mirrorX: false,
              exposureEv,
              outputFormat: format,
              outputMegapixels,
              maxDimension,
              jpegQuality,
              avifQuality,
              preCropped: true,
              enginePrefix: result.engine,
            });
            return {
              ...out,
              processTimeMs: Math.round(performance.now() - startTs),
            };
          } finally {
            try {
              result.averagedBitmap.close();
            } catch {
              // ignore
            }
          }
        }
      }
    }

    // Main-thread WebGL (or Canvas2D) fallback
    try {
      const out = await this._processOnMainThread({
        mode,
        frames,
        aspectRatio,
        softwareZoom,
        mirrorX,
        exposureEv,
        outputFormat: format,
        outputMegapixels,
        maxDimension,
        jpegQuality,
        avifQuality,
        preCropped: false,
      });
      return {
        ...out,
        processTimeMs: Math.round(performance.now() - startTs),
      };
    } finally {
      for (const frame of frames) {
        try {
          frame.close();
        } catch {
          // ignore
        }
      }
    }
  }

  async _processOnMainThread({
    mode = 'hq',
    frames,
    aspectRatio,
    softwareZoom,
    mirrorX,
    exposureEv,
    outputFormat = 'avif',
    outputMegapixels = 'max',
    maxDimension = null,
    jpegQuality = JPEG_QUALITY,
    avifQuality = AVIF_DEFAULT_OPTIONS.quality,
    preCropped,
    enginePrefix,
  }) {
    const srcW = frames[0].width;
    const srcH = frames[0].height;
    const format = resolveOutputFormat(outputFormat);
    const webgl = this._getMainWebGL();
    const nativeAvif =
      format === 'avif' ? await supportsNativeCanvasAvif().catch(() => false) : false;
    const texLimit = webgl ? webgl.maxTextureSize : 4096;
    const encoderMax = getEncoderMaxDimension({
      outputFormat: format,
      maxTextureSize: texLimit,
      supportsNativeAvif: nativeAvif,
      aspectRatio,
    });
    const mpDim = computeMaxDimensionForMegapixels({
      outputMegapixels,
      aspectRatio,
      outputFormat: format,
      maxTextureSize: texLimit,
      supportsNativeAvif: nativeAvif,
    });
    const maxDim =
      typeof maxDimension === 'number' && Number.isFinite(maxDimension) && maxDimension >= 320
        ? Math.max(320, Math.min(encoderMax, Math.round(maxDimension)))
        : mpDim;

    if (webgl) {
      const crop = preCropped
        ? {
            sx: 0,
            sy: 0,
            sw: srcW,
            sh: srcH,
            outWidth: srcW,
            outHeight: srcH,
          }
        : computeAspectCrop(
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
      const tempCanvases = [];

      if (srcW > webgl.maxTextureSize || srcH > webgl.maxTextureSize) {
        gpuSources = frames.map((frame) => {
          const c = document.createElement('canvas');
          c.width = crop.outWidth;
          c.height = crop.outHeight;
          const ctx = c.getContext('2d');
          if (mirrorX) {
            ctx.translate(crop.outWidth, 0);
            ctx.scale(-1, 1);
          }
          ctx.drawImage(
            frame,
            crop.sx,
            crop.sy,
            crop.sw,
            crop.sh,
            0,
            0,
            crop.outWidth,
            crop.outHeight
          );
          tempCanvases.push(c);
          return c;
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

      const encoded = await this._encodeMainCanvas({
        format,
        webgl,
        canvas: webgl.canvas,
        width: crop.outWidth,
        height: crop.outHeight,
        avifQuality,
        jpegQuality,
        engineBase: enginePrefix || 'main-webgl',
      });

      for (const tc of tempCanvases) {
        tc.width = 1;
        tc.height = 1;
      }
      return encoded;
    }

    // Ultimate Canvas2D fallback if WebGL is completely unavailable
    const crop = computeAspectCrop(srcW, srcH, aspectRatio, softwareZoom, maxDim);
    const canvas = document.createElement('canvas');
    canvas.width = crop.outWidth;
    canvas.height = crop.outHeight;
    const ctx = canvas.getContext('2d');
    if (mirrorX) {
      ctx.translate(crop.outWidth, 0);
      ctx.scale(-1, 1);
    }
    ctx.filter =
      mode === 'hq'
        ? 'contrast(1.06) saturate(1.06) brightness(1.04)'
        : 'contrast(1.05)';
    ctx.drawImage(
      frames[0],
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      crop.outWidth,
      crop.outHeight
    );
    return this._encodeMainCanvas({
      format,
      canvas,
      ctx2d: ctx,
      width: crop.outWidth,
      height: crop.outHeight,
      avifQuality,
      jpegQuality,
      engineBase: 'canvas2d-fallback',
    });
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.mainWebGL) {
      this.mainWebGL.dispose();
      this.mainWebGL = null;
    }
  }
}
