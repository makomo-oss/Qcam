import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AVIF_DEFAULT_OPTIONS,
  isValidAvifBytes,
  normalizeAvifOptions,
  resolveOutputFormat,
} from '../../src/processing/avif-encoder.js';

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

test('normalizeAvifOptions applies Qcam defaults and clamps quality/speed', () => {
  const defaults = normalizeAvifOptions();
  assert.equal(defaults.quality, AVIF_DEFAULT_OPTIONS.quality);
  assert.equal(defaults.speed, AVIF_DEFAULT_OPTIONS.speed);
  assert.equal(defaults.subsample, 1);

  const clamped = normalizeAvifOptions({ quality: 250, speed: -4 });
  assert.equal(clamped.quality, 100);
  assert.equal(clamped.speed, 0);
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
