import { computeAspectCrop } from '../utils/geometry.js';
import { WebGLImageProcessor } from './webgl-processor.js';

const JPEG_QUALITY = 0.95;

function canvasToJpegBlob(canvas, quality = JPEG_QUALITY) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('JPEG エンコードに失敗しました。'));
      },
      'image/jpeg',
      quality
    );
  });
}

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

  /**
   * Process captured frame(s) and return JPEG (quality 0.95) Blob + metadata.
   */
  async process({
    mode = 'standard',
    frames = [],
    aspectRatio = '4:3',
    softwareZoom = 1,
    mirrorX = false,
    exposureEv = 0,
  }) {
    const startTs = performance.now();

    if (!frames.length) {
      throw new Error('処理するフレームがありません。');
    }

    // Try Web Worker first when OffscreenCanvas is available
    if (this.worker && this.platform.supportsOffscreenCanvas) {
      const id = this.nextJobId++;
      // Keep duplicate bitmaps ONLY if worker may decline and ask main thread to fall back?
      // Wait: if Worker supports OffscreenCanvas WebGL, transferring is zero-copy.
      // If Worker declines (e.g. iOS 16.4 lacking WebGL in Worker), clone or only transfer if supportsOffscreenWebGL!
      if (this.platform.supportsOffscreenWebGL || mode === 'hq') {
        const result = await new Promise((resolve) => {
          this.pending.set(id, { resolve });
          this.worker.postMessage(
            {
              id,
              mode,
              frames,
              aspectRatio,
              softwareZoom,
              mirrorX,
              exposureEv,
              jpegQuality: JPEG_QUALITY,
            },
            frames
          );
        });

        if (result.ok && result.blob) {
          return {
            blob: result.blob,
            width: result.width,
            height: result.height,
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
    mode,
    frames,
    aspectRatio,
    softwareZoom,
    mirrorX,
    exposureEv,
    preCropped,
    enginePrefix,
  }) {
    const srcW = frames[0].width;
    const srcH = frames[0].height;
    const webgl = this._getMainWebGL();

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

      const blob = await canvasToJpegBlob(webgl.canvas, JPEG_QUALITY);
      for (const tc of tempCanvases) {
        tc.width = 1;
        tc.height = 1;
      }
      return {
        blob,
        width: crop.outWidth,
        height: crop.outHeight,
        engine: enginePrefix || 'main-webgl',
      };
    }

    // Ultimate Canvas2D fallback if WebGL is completely unavailable
    const crop = computeAspectCrop(srcW, srcH, aspectRatio, softwareZoom, 4096);
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
    const blob = await canvasToJpegBlob(canvas, JPEG_QUALITY);
    return {
      blob,
      width: crop.outWidth,
      height: crop.outHeight,
      engine: 'canvas2d-fallback',
    };
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
