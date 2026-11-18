/**
 * Client-side AVIF encoder wrapper (powered by vendored @jsquash/avif single-threaded libavif WASM).
 * Also verifies native Canvas AVIF encoding strictly before ever trusting native canvas fallback.
 */

export const AVIF_MIME_TYPE = 'image/avif';
export const JPEG_MIME_TYPE = 'image/jpeg';

export const AVIF_DEFAULT_OPTIONS = Object.freeze({
  quality: 86,
  qualityAlpha: -1,
  denoiseLevel: 0,
  tileColsLog2: 0,
  tileRowsLog2: 0,
  speed: 8,
  subsample: 1, // YUV 4:2:0
  chromaDeltaQ: true,
  sharpness: 0,
  enableSharpYUV: true,
  tune: 0, // AVIFTune.auto
  bitDepth: 8,
});

export function resolveOutputFormat(value) {
  return value === 'jpeg' ? 'jpeg' : 'avif';
}

export function normalizeAvifOptions(options = {}) {
  const merged = { ...AVIF_DEFAULT_OPTIONS, ...options };
  merged.quality = Math.max(1, Math.min(100, Math.round(Number(merged.quality) || AVIF_DEFAULT_OPTIONS.quality)));
  merged.speed = Math.max(0, Math.min(10, Math.round(Number(merged.speed ?? AVIF_DEFAULT_OPTIONS.speed))));
  merged.chromaDeltaQ = Boolean(merged.chromaDeltaQ);
  merged.enableSharpYUV = Boolean(merged.enableSharpYUV);
  return merged;
}

function readAscii4(bytes, offset) {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

/**
 * Strictly verify an ISOBMFF AVIF container header (`ftyp` box + `avif`/`avis`/`mif1` brand)
 * so silent browser fallbacks to PNG or empty buffers are never mistaken for AVIF.
 */
export function isValidAvifBytes(input) {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : null;

  if (!bytes || bytes.byteLength < 16) return false;

  const boxSize =
    ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (boxSize < 16) return false;

  if (readAscii4(bytes, 4) !== 'ftyp') return false;

  const majorBrand = readAscii4(bytes, 8);
  if (majorBrand === 'avif' || majorBrand === 'avis') {
    return true;
  }

  if (majorBrand === 'mif1' || majorBrand === 'msf1') {
    const scanLimit = Math.min(bytes.byteLength, boxSize);
    for (let offset = 16; offset + 4 <= scanLimit; offset += 4) {
      const brand = readAscii4(bytes, offset);
      if (brand === 'avif' || brand === 'avis') {
        return true;
      }
    }
  }

  return false;
}

export async function canvasToEncodedBlob(canvas, mimeType, quality) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: mimeType, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`${mimeType} エンコードに失敗しました。`));
      },
      mimeType,
      quality
    );
  });
}

let nativeCanvasAvifPromise = null;

/**
 * Detect whether the current JS execution context genuinely supports native Canvas AVIF encoding.
 * Browsers often silently fall back to PNG when given 'image/avif', so we validate both
 * header bytes and round-trip decode via createImageBitmap.
 */
export function supportsNativeCanvasAvif() {
  if (nativeCanvasAvifPromise) return nativeCanvasAvifPromise;

  nativeCanvasAvifPromise = (async () => {
    try {
      let canvas = null;
      if (typeof OffscreenCanvas === 'function') {
        canvas = new OffscreenCanvas(4, 4);
      } else if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        canvas = document.createElement('canvas');
        canvas.width = 4;
        canvas.height = 4;
      }
      if (!canvas) return false;

      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      ctx.fillStyle = '#e11d48';
      ctx.fillRect(0, 0, 2, 2);
      ctx.fillStyle = '#22c55e';
      ctx.fillRect(2, 0, 2, 2);
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(0, 2, 2, 2);
      ctx.fillStyle = '#facc15';
      ctx.fillRect(2, 2, 2, 2);

      const blob = await canvasToEncodedBlob(canvas, AVIF_MIME_TYPE, 0.8);
      if (!blob || blob.type !== AVIF_MIME_TYPE || blob.size < 16) {
        return false;
      }

      const headerBuf = await blob.slice(0, 64).arrayBuffer();
      if (!isValidAvifBytes(headerBuf)) {
        return false;
      }

      if (typeof createImageBitmap === 'function') {
        const bmp = await createImageBitmap(blob);
        const ok = bmp.width === 4 && bmp.height === 4;
        bmp.close();
        return ok;
      }
      return true;
    } catch {
      return false;
    }
  })();

  return nativeCanvasAvifPromise;
}

let compiledWasmPromise = null;
let encoderModulePromise = null;

async function getCompiledWasmModule() {
  if (compiledWasmPromise) return compiledWasmPromise;

  compiledWasmPromise = (async () => {
    const wasmUrl = new URL('../vendor/avif/avif_enc.wasm', import.meta.url).href;
    const response = await fetch(wasmUrl, { credentials: 'same-origin' });
    if (!response.ok) {
      throw new Error(`AVIF WASM の読み込みに失敗しました (HTTP ${response.status})`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (
      typeof WebAssembly.compileStreaming === 'function' &&
      contentType.includes('application/wasm')
    ) {
      const fallbackResponse = response.clone();
      try {
        return await WebAssembly.compileStreaming(response);
      } catch {
        const bytes = await fallbackResponse.arrayBuffer();
        return await WebAssembly.compile(bytes);
      }
    }

    const bytes = await response.arrayBuffer();
    return await WebAssembly.compile(bytes);
  })().catch((err) => {
    compiledWasmPromise = null;
    throw err;
  });

  return compiledWasmPromise;
}

async function loadAvifEncoderModule() {
  if (encoderModulePromise) return encoderModulePromise;

  encoderModulePromise = (async () => {
    const [{ default: avifEncoderFactory }, wasmModule] = await Promise.all([
      import('../vendor/avif/avif_enc.js'),
      getCompiledWasmModule(),
    ]);

    let rejectInstantiate;
    const instantiateFailed = new Promise((_, reject) => {
      rejectInstantiate = reject;
    });

    // Explicit instantiateWasm works identically in Window, Classic Worker, and ES Module Worker
    // (avoids Emscripten's ENVIRONMENT_IS_WORKER === typeof importScripts quirk in module workers).
    const factoryPromise = avifEncoderFactory({
      noInitialRun: true,
      instantiateWasm(imports, successCallback) {
        WebAssembly.instantiate(wasmModule, imports)
          .then((instance) => {
            successCallback(instance, wasmModule);
          })
          .catch((err) => {
            rejectInstantiate(err);
          });
        return {};
      },
    });

    return await Promise.race([factoryPromise, instantiateFailed]);
  })().catch((err) => {
    encoderModulePromise = null;
    throw err;
  });

  return encoderModulePromise;
}

export async function warmupAvifEncoder() {
  if (await supportsNativeCanvasAvif()) {
    return 'native';
  }
  await loadAvifEncoderModule();
  return 'wasm';
}

/**
 * Encode top-down RGBA8 pixel buffer into an AVIF Blob (`image/avif`).
 */
export async function encodeAvifFromRgba(rgbaPixels, width, height, options = {}) {
  const safeW = Math.round(width);
  const safeH = Math.round(height);
  if (safeW < 2 || safeH < 2) {
    throw new Error(`Invalid dimensions for AVIF encoding: ${width}x${height}`);
  }

  let rgbaView;
  if (rgbaPixels instanceof Uint8Array) {
    rgbaView =
      rgbaPixels.byteOffset === 0 && rgbaPixels.byteLength === rgbaPixels.buffer.byteLength
        ? rgbaPixels
        : new Uint8Array(rgbaPixels);
  } else if (rgbaPixels instanceof ArrayBuffer) {
    rgbaView = new Uint8Array(rgbaPixels);
  } else if (ArrayBuffer.isView(rgbaPixels)) {
    rgbaView = new Uint8Array(
      rgbaPixels.buffer,
      rgbaPixels.byteOffset,
      rgbaPixels.byteLength
    );
    if (rgbaView.byteOffset !== 0 || rgbaView.byteLength !== rgbaView.buffer.byteLength) {
      rgbaView = new Uint8Array(rgbaView);
    }
  } else {
    throw new Error('RGBA pixel buffer expected for AVIF encoding');
  }

  const expectedBytes = safeW * safeH * 4;
  if (rgbaView.byteLength !== expectedBytes) {
    throw new Error(
      `RGBA buffer size mismatch: expected ${expectedBytes} bytes, got ${rgbaView.byteLength}`
    );
  }

  const pixelCount = safeW * safeH;
  const adaptiveOpts = { ...options };
  if (adaptiveOpts.speed === undefined && pixelCount <= 2_100_000) {
    adaptiveOpts.speed = 7;
  }
  if (adaptiveOpts.enableSharpYUV === undefined && pixelCount > 2_100_000) {
    adaptiveOpts.enableSharpYUV = false;
  }
  const opts = normalizeAvifOptions(adaptiveOpts);
  const mod = await loadAvifEncoderModule();
  const encoded = mod.encode(rgbaView, safeW, safeH, opts);

  if (!encoded || !isValidAvifBytes(encoded)) {
    throw new Error('AVIF エンコードに失敗しました。');
  }

  const detached =
    encoded.byteOffset === 0 &&
    encoded.byteLength === encoded.buffer.byteLength &&
    encoded.buffer !== mod.HEAPU8?.buffer
      ? encoded
      : new Uint8Array(encoded);

  return new Blob([detached], { type: AVIF_MIME_TYPE });
}
