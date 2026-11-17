import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform } from '../../src/utils/platform.js';

test('detectPlatform identifies iOS Safari and selects Video Stream + Web Share strategy', () => {
  const iosEnv = {
    navigator: {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 5,
      mediaDevices: { getUserMedia: async () => {} },
      share: async () => {},
      canShare: () => true,
      standalone: true,
    },
    window: {
      ImageCapture: undefined,
      OffscreenCanvas: function () {},
      Worker: function () {},
      File: function () {},
      matchMedia: () => ({ matches: true }),
    },
  };
  iosEnv.window = { ...iosEnv.window, navigator: iosEnv.navigator };

  const info = detectPlatform(iosEnv);
  assert.equal(info.isIOS, true);
  assert.equal(info.isSafari, true);
  assert.equal(info.isAndroid, false);
  assert.equal(info.preferTakePhoto, false);
  assert.equal(info.preferWebShareSave, true);
  assert.equal(info.isStandalonePWA, true);
});

test('detectPlatform identifies iPadOS desktop-mode UA as iOS', () => {
  const ipadEnv = {
    navigator: {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      maxTouchPoints: 5,
      mediaDevices: { getUserMedia: async () => {} },
    },
    window: {},
  };
  const info = detectPlatform(ipadEnv);
  assert.equal(info.isIOS, true);
  assert.equal(info.isSafari, true);
});

test('detectPlatform identifies Android Chrome and selects ImageCapture + download strategy', () => {
  const androidEnv = {
    navigator: {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      maxTouchPoints: 5,
      mediaDevices: { getUserMedia: async () => {} },
      share: async () => {},
      canShare: () => true,
    },
    window: {
      ImageCapture: function () {},
      OffscreenCanvas: function () {},
      Worker: function () {},
      File: function () {},
    },
  };

  const info = detectPlatform(androidEnv);
  assert.equal(info.isAndroid, true);
  assert.equal(info.isChrome, true);
  assert.equal(info.isIOS, false);
  assert.equal(info.preferTakePhoto, true);
  assert.equal(info.preferWebShareSave, false);
  assert.equal(info.supportsWebShareFiles, true);
  assert.equal(info.supportsWebShareAvif, true);
});

test('detectPlatform differentiates image/avif vs image/jpeg support in navigator.canShare', () => {
  class FakeFile {
    constructor(parts, name, opts = {}) {
      this.name = name;
      this.type = opts.type || '';
    }
  }
  const selectiveEnv = {
    navigator: {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
      maxTouchPoints: 5,
      mediaDevices: { getUserMedia: async () => {} },
      share: async () => {},
      canShare: (data) => data?.files?.[0]?.type === 'image/jpeg',
    },
    window: {
      File: FakeFile,
    },
  };

  const info = detectPlatform(selectiveEnv);
  assert.equal(info.supportsWebShareFiles, true);
  assert.equal(info.supportsWebShareAvif, false);
});
