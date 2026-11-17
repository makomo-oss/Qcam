import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhotoFilename } from '../../src/storage/media-saver.js';

test('buildPhotoFilename formats standard and HDR filenames cleanly', () => {
  const sampleDate = new Date(2026, 10, 17, 6, 5, 9);
  assert.equal(buildPhotoFilename(sampleDate, 'standard'), 'Qcam_20261117_060509.jpg');
  assert.equal(buildPhotoFilename(sampleDate, 'hq'), 'Qcam_20261117_060509_HDR.jpg');
});
