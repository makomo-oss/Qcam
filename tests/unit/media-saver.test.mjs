import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhotoFilename, shareOrSavePhoto } from '../../src/storage/media-saver.js';

function withMockedGlobals(overrides, fn) {
  const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const prevFileDesc = Object.getOwnPropertyDescriptor(globalThis, 'File');

  if ('navigator' in overrides) {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: overrides.navigator,
    });
  }
  if ('File' in overrides) {
    Object.defineProperty(globalThis, 'File', {
      configurable: true,
      writable: true,
      value: overrides.File,
    });
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prevNavDesc) Object.defineProperty(globalThis, 'navigator', prevNavDesc);
      else delete globalThis.navigator;
      if (prevFileDesc) Object.defineProperty(globalThis, 'File', prevFileDesc);
      else delete globalThis.File;
    });
}

class MockFile {
  constructor(parts, name, opts = {}) {
    this.parts = parts;
    this.name = name;
    this.type = opts.type || '';
    this.lastModified = opts.lastModified || 0;
  }
}

test('buildPhotoFilename formats standard and HDR filenames cleanly (AVIF default + JPEG option)', () => {
  const sampleDate = new Date(2026, 10, 17, 6, 5, 9);
  assert.equal(buildPhotoFilename(sampleDate, 'standard'), 'Qcam_20261117_060509.avif');
  assert.equal(buildPhotoFilename(sampleDate, 'hq'), 'Qcam_20261117_060509_HDR.avif');
  assert.equal(buildPhotoFilename(sampleDate, 'standard', 'avif'), 'Qcam_20261117_060509.avif');
  assert.equal(buildPhotoFilename(sampleDate, 'standard', 'jpeg'), 'Qcam_20261117_060509.jpg');
  assert.equal(buildPhotoFilename(sampleDate, 'hq', 'jpeg'), 'Qcam_20261117_060509_HDR.jpg');
});

test('shareOrSavePhoto sends strictly { files } with image/avif MIME on iOS so Save Image appears reliably', async () => {
  const shareCalls = [];
  const sampleAvif = {
    blob: new Blob(['avif-bytes'], { type: 'image/avif' }),
    url: 'blob:qcam/1',
    filename: 'Qcam_test.avif',
    mimeType: 'image/avif',
  };
  const sampleJpeg = {
    blob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    url: 'blob:qcam/1b',
    filename: 'Qcam_test.jpg',
    mimeType: 'image/jpeg',
  };

  await withMockedGlobals(
    {
      File: MockFile,
      navigator: {
        canShare: (data) => Array.isArray(data?.files) && data.files.length === 1,
        share: async (data) => {
          shareCalls.push(data);
        },
      },
    },
    async () => {
      const res = await shareOrSavePhoto(sampleAvif, { isIOS: true, preferWebShareSave: true });
      assert.deepEqual(res, { method: 'web-share', completed: true });
      assert.equal(shareCalls.length, 1);
      assert.deepEqual(Object.keys(shareCalls[0]), ['files']);
      assert.equal(shareCalls[0].files[0].name, 'Qcam_test.avif');
      assert.equal(shareCalls[0].files[0].type, 'image/avif');

      const resJpg = await shareOrSavePhoto(sampleJpeg, { isIOS: true, preferWebShareSave: true });
      assert.deepEqual(resJpg, { method: 'web-share', completed: true });
      assert.equal(shareCalls[1].files[0].name, 'Qcam_test.jpg');
      assert.equal(shareCalls[1].files[0].type, 'image/jpeg');
    }
  );
});

test('shareOrSavePhoto distinguishes AbortError cancel vs NotAllowedError activation expiry on iOS', async () => {
  const samplePhoto = {
    blob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    url: 'blob:qcam/2',
    filename: 'Qcam_test2.jpg',
  };

  await withMockedGlobals(
    {
      File: MockFile,
      navigator: {
        canShare: () => true,
        share: async () => {
          const err = new Error('User cancelled');
          err.name = 'AbortError';
          throw err;
        },
      },
    },
    async () => {
      const res = await shareOrSavePhoto(samplePhoto, { isIOS: true, preferWebShareSave: true });
      assert.deepEqual(res, { method: 'web-share', completed: false, cancelled: true });
    }
  );

  await withMockedGlobals(
    {
      File: MockFile,
      navigator: {
        canShare: () => true,
        share: async () => {
          const err = new Error('Activation expired');
          err.name = 'NotAllowedError';
          throw err;
        },
      },
    },
    async () => {
      const res = await shareOrSavePhoto(samplePhoto, { isIOS: true, preferWebShareSave: true });
      assert.deepEqual(res, {
        method: 'ios-manual-hint',
        completed: false,
        gestureExpired: true,
        reason: 'NotAllowedError',
      });
    }
  );
});

test('shareOrSavePhoto on iOS returns ios-manual-hint instead of downloading to Files when Share is unavailable', async () => {
  const samplePhoto = {
    blob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    url: 'blob:qcam/3',
    filename: 'Qcam_test3.jpg',
  };

  await withMockedGlobals(
    {
      File: MockFile,
      navigator: {},
    },
    async () => {
      const res = await shareOrSavePhoto(samplePhoto, { isIOS: true, preferWebShareSave: false });
      assert.deepEqual(res, {
        method: 'ios-manual-hint',
        completed: false,
        gestureExpired: false,
        reason: 'web-share-unavailable',
      });
    }
  );
});

test('shareOrSavePhoto guards against concurrent navigator.share invocations', async () => {
  const samplePhoto = {
    blob: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }),
    url: 'blob:qcam/4',
    filename: 'Qcam_test4.jpg',
  };
  let releaseShare;
  const sharePromise = new Promise((resolve) => {
    releaseShare = resolve;
  });

  await withMockedGlobals(
    {
      File: MockFile,
      navigator: {
        canShare: () => true,
        share: () => sharePromise,
      },
    },
    async () => {
      const firstCall = shareOrSavePhoto(samplePhoto, { isIOS: true, preferWebShareSave: true });
      const secondCall = await shareOrSavePhoto(samplePhoto, { isIOS: true, preferWebShareSave: true });
      assert.deepEqual(secondCall, { method: 'web-share', completed: false, busy: true });
      releaseShare();
      const firstRes = await firstCall;
      assert.deepEqual(firstRes, { method: 'web-share', completed: true });
    }
  );
});

test('shareOrSavePhoto supports explicit forceDownload (.avif) on iOS Safari and distinguishes share-file-unsupported', async () => {
  const sampleAvif = {
    blob: new Blob(['avif-bytes'], { type: 'image/avif' }),
    url: 'blob:qcam/avif-dl',
    filename: 'Qcam_force.avif',
    mimeType: 'image/avif',
  };

  const clickedAnchors = [];
  const prevDocDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      createElement: () => ({
        style: {},
        click() {
          clickedAnchors.push({ href: this.href, download: this.download });
        },
        remove() {},
      }),
      body: {
        appendChild() {},
      },
    },
  });

  try {
    await withMockedGlobals(
      {
        File: MockFile,
        navigator: {
          canShare: () => false,
          share: async () => {
            throw new Error('should not call share');
          },
        },
      },
      async () => {
        const unsupportedRes = await shareOrSavePhoto(sampleAvif, {
          isIOS: true,
          preferWebShareSave: true,
        });
        assert.deepEqual(unsupportedRes, {
          method: 'ios-manual-hint',
          completed: false,
          gestureExpired: false,
          reason: 'share-file-unsupported',
        });

        const dlRes = await shareOrSavePhoto(sampleAvif, { isIOS: true }, { forceDownload: true });
        assert.deepEqual(dlRes, { method: 'download', completed: true });
        assert.deepEqual(clickedAnchors, [{ href: 'blob:qcam/avif-dl', download: 'Qcam_force.avif' }]);
      }
    );
  } finally {
    if (prevDocDesc) Object.defineProperty(globalThis, 'document', prevDocDesc);
    else delete globalThis.document;
  }
});

