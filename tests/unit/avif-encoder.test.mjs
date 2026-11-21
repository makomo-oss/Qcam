import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AVIF_DEFAULT_OPTIONS,
  isValidAvifBytes,
  normalizeAvifOptions,
  resolveAdaptiveAvifOptions,
  resolveOutputFormat,
} from '../../src/processing/avif-encoder.js';
import {
  extractAvifGridTiles,
  muxAvifGrid,
  parseSingleTileAvif,
  planAvifGrid,
} from '../../src/processing/avif-grid-muxer.js';
import avifEncoderFactory from '../../src/vendor/avif/avif_enc.js';

function makeFtypHeader(size, majorBrand, compatBrands = []) {
  const buf = new Uint8Array(Math.max(16, size));
  buf[0] = (size >>> 24) & 0xff;
  buf[1] = (size >>> 16) & 0xff;
  buf[2] = (size >>> 8) & 0xff;
  buf[3] = size & 0xff;
  buf.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  for (let i = 0; i < 4; i++) buf[8 + i] = majorBrand.charCodeAt(i);
  let offset = 16;
  for (const brand of compatBrands) {
    if (offset + 4 <= buf.length) {
      for (let i = 0; i < 4; i++) buf[offset + i] = brand.charCodeAt(i);
      offset += 4;
    }
  }
  return buf;
}

test('resolveOutputFormat defaults to avif and honors explicit jpeg', () => {
  assert.equal(resolveOutputFormat(undefined), 'avif');
  assert.equal(resolveOutputFormat('unknown'), 'avif');
  assert.equal(resolveOutputFormat('avif'), 'avif');
  assert.equal(resolveOutputFormat('jpeg'), 'jpeg');
});

test('normalizeAvifOptions applies Qcam Pro SharpYUV defaults and clamps quality/speed', () => {
  assert.equal(AVIF_DEFAULT_OPTIONS.quality, 86);
  assert.equal(AVIF_DEFAULT_OPTIONS.speed, 8);
  assert.equal(AVIF_DEFAULT_OPTIONS.subsample, 1);
  assert.equal(AVIF_DEFAULT_OPTIONS.enableSharpYUV, true);
  assert.equal(AVIF_DEFAULT_OPTIONS.chromaDeltaQ, true);

  const defaults = normalizeAvifOptions();
  assert.equal(defaults.quality, AVIF_DEFAULT_OPTIONS.quality);
  assert.equal(defaults.speed, AVIF_DEFAULT_OPTIONS.speed);
  assert.equal(defaults.subsample, 1);
  assert.equal(defaults.enableSharpYUV, true);
  assert.equal(defaults.chromaDeltaQ, true);

  const clamped = normalizeAvifOptions({ quality: 250, speed: -4 });
  assert.equal(clamped.quality, 100);
  assert.equal(clamped.speed, 0);

  const smallOpts = resolveAdaptiveAvifOptions(1600, 1200);
  assert.equal(smallOpts.quality, 86);
  assert.equal(smallOpts.speed, 7);
  assert.equal(smallOpts.enableSharpYUV, true);

  const largeOpts = resolveAdaptiveAvifOptions(4032, 3024);
  assert.equal(largeOpts.quality, 86);
  assert.equal(largeOpts.speed, 8);
  assert.equal(largeOpts.enableSharpYUV, false);
});

test('isValidAvifBytes validates authentic AVIF ISOBMFF containers and rejects PNG/JPEG/truncated data', () => {
  const validAvif = makeFtypHeader(28, 'avif', ['avif', 'mif1', 'miaf']);
  const validMif1WithAvif = makeFtypHeader(24, 'mif1', ['miaf', 'avif']);
  const validAvis = makeFtypHeader(24, 'avis', ['avif']);
  const wrongBrand = makeFtypHeader(24, 'heic', ['mif1', 'hevc']);
  const pngHeader = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const jpegHeader = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
  ]);

  assert.equal(isValidAvifBytes(validAvif), true);
  assert.equal(isValidAvifBytes(validAvif.buffer), true);
  assert.equal(isValidAvifBytes(validMif1WithAvif), true);
  assert.equal(isValidAvifBytes(validAvis), true);
  assert.equal(isValidAvifBytes(wrongBrand), false);
  assert.equal(isValidAvifBytes(pngHeader), false);
  assert.equal(isValidAvifBytes(jpegHeader), false);
  assert.equal(isValidAvifBytes(new Uint8Array(8)), false);
  assert.equal(isValidAvifBytes(null), false);
});

test('planAvifGrid aligns tiles to 64px AV1 superblocks and skips small frames', () => {
  assert.deepEqual(planAvifGrid(320, 240, 4), {
    cols: 1,
    rows: 1,
    tileWidth: 320,
    tileHeight: 240,
  });

  const g2 = planAvifGrid(1600, 1200, 2);
  assert.equal(g2.cols, 2);
  assert.equal(g2.rows, 1);
  assert.equal(g2.tileWidth % 64, 0);
  assert.equal(g2.tileHeight, 1200);
  assert.ok(g2.tileWidth * (g2.cols - 1) < 1600 && g2.tileWidth * g2.cols >= 1600);

  const g2Portrait = planAvifGrid(1200, 1600, 2);
  assert.equal(g2Portrait.cols, 1);
  assert.equal(g2Portrait.rows, 2);
  assert.equal(g2Portrait.tileWidth, 1200);
  assert.equal(g2Portrait.tileHeight % 64, 0);

  const g4 = planAvifGrid(4032, 3024, 4);
  assert.equal(g4.cols, 2);
  assert.equal(g4.rows, 2);
  assert.equal(g4.tileWidth, 2048);
  assert.equal(g4.tileHeight, 1536);
  assert.ok(g4.tileWidth * 2 >= 4032 && g4.tileHeight * 2 >= 3024);
});

test('extractAvifGridTiles edge-clamps right/bottom padding without introducing black borders', () => {
  const w = 10;
  const h = 6;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      rgba[p] = x * 20 + 10;
      rgba[p + 1] = y * 30 + 20;
      rgba[p + 2] = 180;
      rgba[p + 3] = 255;
    }
  }
  const tiles = extractAvifGridTiles(rgba, w, h, {
    cols: 2,
    rows: 2,
    tileWidth: 6,
    tileHeight: 4,
  });
  assert.equal(tiles.length, 4);

  // Bottom-right tile covers x=[6..9] padded to [6..11] and y=[4..5] padded to [4..7]
  const br = tiles[3].rgba;
  // Last valid pixel in source is (x=9, y=5) -> [190, 170, 180, 255]
  const paddedOff = (3 * 6 + 5) * 4;
  assert.deepEqual(Array.from(br.slice(paddedOff, paddedOff + 4)), [190, 170, 180, 255]);
});

test('muxAvifGrid produces valid ISOBMFF Grid AVIF from real vendored WASM tile outputs', async () => {
  const wasmPath = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'src',
    'vendor',
    'avif',
    'avif_enc.wasm'
  );
  const wasmBinary = fs.readFileSync(wasmPath);
  const mod = await avifEncoderFactory({ noInitialRun: true, wasmBinary });

  const w = 800;
  const h = 600;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      rgba[p] = (x * 255) / w;
      rgba[p + 1] = (y * 255) / h;
      rgba[p + 2] = 140;
      rgba[p + 3] = 255;
    }
  }

  const grid = planAvifGrid(w, h, 2);
  const tiles = extractAvifGridTiles(rgba, w, h, grid);
  const opts = resolveAdaptiveAvifOptions(w, h, { quality: 86 });
  const tileAvifs = tiles.map((t) => new Uint8Array(mod.encode(t.rgba, t.width, t.height, opts)));

  for (const ta of tileAvifs) {
    const parsed = parseSingleTileAvif(ta);
    assert.ok(parsed, 'Single tile AVIF should parse cleanly');
    assert.equal(parsed.hasAlpha, false);
    assert.ok(parsed.obu.byteLength > 0);
  }

  const muxed = muxAvifGrid({
    outputWidth: w,
    outputHeight: h,
    tileWidth: grid.tileWidth,
    tileHeight: grid.tileHeight,
    cols: grid.cols,
    rows: grid.rows,
    tileAvifs,
  });

  assert.ok(muxed instanceof Uint8Array);
  assert.equal(isValidAvifBytes(muxed), true);
  assert.equal(String.fromCharCode(...muxed.slice(4, 12)), 'ftypavif');
  // Verify 'grid' and 'dimg' boxes are present in meta
  const ascii = String.fromCharCode(...muxed.slice(0, Math.min(muxed.length, 600)));
  assert.ok(ascii.includes('grid'), 'Grid AVIF must declare grid derived item');
  assert.ok(ascii.includes('dimg'), 'Grid AVIF must link tiles via dimg reference');

  // Verify invalid inputs safely return null so caller falls back cleanly
  assert.equal(
    muxAvifGrid({
      outputWidth: w,
      outputHeight: h,
      tileWidth: grid.tileWidth,
      tileHeight: grid.tileHeight,
      cols: grid.cols,
      rows: grid.rows,
      tileAvifs: [new Uint8Array(16), new Uint8Array(16)],
    }),
    null
  );
});
