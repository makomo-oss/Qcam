import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCameraEnvironment,
  classifyVideoDevice,
  formatBackLensDisplayName,
} from '../../src/utils/camera-lenses.js';

function fakeDevice(deviceId, label, caps = null) {
  return {
    kind: 'videoinput',
    deviceId,
    label,
    ...(caps ? { getCapabilities: () => caps } : {}),
  };
}

test('analyzeCameraEnvironment detects iOS Safari English & Japanese physical ultra-wide lenses while excluding Front & Desk View', () => {
  const iosEnDevices = [
    fakeDevice('front-std', 'Front Camera'),
    fakeDevice('front-uw', 'Front Ultra Wide Camera'),
    fakeDevice('desk-1', 'Desk View Camera'),
    fakeDevice('back-std', 'Back Camera'),
    fakeDevice('back-uw', 'Back Ultra Wide Camera'),
    fakeDevice('back-tele', 'Back Telephoto Camera'),
    fakeDevice('back-triple', 'Back Triple Camera'),
  ];

  const enBackEnv = analyzeCameraEnvironment({
    devices: iosEnDevices,
    activeDeviceId: 'back-std',
    facingMode: 'environment',
    isMobile: true,
  });

  assert.equal(enBackEnv.supportsUltraWide, true);
  assert.equal(enBackEnv.ultraWideMethod, 'device-switch');
  assert.equal(enBackEnv.ultraWideZoom, 0.5);
  assert.equal(enBackEnv.standardBackDevice?.deviceId, 'back-std');
  assert.equal(enBackEnv.ultraWideDevice?.deviceId, 'back-uw');
  assert.equal(enBackEnv.activeRole, 'wide');
  assert.equal(enBackEnv.backLenses.length, 4);
  assert.ok(!enBackEnv.backLenses.some((d) => d.deviceId === 'desk-1'));
  assert.ok(!enBackEnv.backLenses.some((d) => d.deviceId === 'front-uw'));

  const iosJaDevices = [
    fakeDevice('ja-front', '前面TrueDepthカメラ'),
    fakeDevice('ja-front-uw', '前面超広角カメラ'),
    fakeDevice('ja-desk', 'デスクビューカメラ'),
    fakeDevice('ja-back', '背面カメラ'),
    fakeDevice('ja-back-dual', '背面デュアル広角カメラ'),
    fakeDevice('ja-back-uw', '背面超広角カメラ'),
  ];

  const jaBackEnv = analyzeCameraEnvironment({
    devices: iosJaDevices,
    activeDeviceId: 'ja-back-uw',
    facingMode: 'environment',
    isMobile: true,
  });

  assert.equal(jaBackEnv.supportsUltraWide, true);
  assert.equal(jaBackEnv.ultraWideMethod, 'device-switch');
  assert.equal(jaBackEnv.standardBackDevice?.deviceId, 'ja-back');
  assert.equal(jaBackEnv.ultraWideDevice?.deviceId, 'ja-back-uw');
  assert.equal(jaBackEnv.activeRole, 'ultrawide');
});

test('analyzeCameraEnvironment supports hardware zoom < 1.0 on Android Chrome (0.5x & 0.6x) and hides on front camera', () => {
  const androidDevices = [
    fakeDevice('cam-0', 'camera2 0, facing back', {
      facingMode: ['environment'],
      zoom: { min: 0.5, max: 8.0, step: 0.1 },
      width: { min: 320, max: 4000 },
    }),
    fakeDevice('cam-1', 'camera2 1, facing front', {
      facingMode: ['user'],
      width: { min: 320, max: 3264 },
    }),
  ];

  const backEnv = analyzeCameraEnvironment({
    devices: androidDevices,
    activeDeviceId: 'cam-0',
    trackCapabilities: { zoom: { min: 0.5, max: 8.0, step: 0.1 } },
    facingMode: 'environment',
    isMobile: true,
  });

  assert.equal(backEnv.supportsUltraWide, true);
  assert.equal(backEnv.ultraWideMethod, 'hardware-zoom');
  assert.equal(backEnv.ultraWideZoom, 0.5);
  assert.equal(backEnv.minZoom, 0.5);
  assert.equal(backEnv.activeRole, 'wide');

  const hw06Env = analyzeCameraEnvironment({
    devices: [fakeDevice('cam-0', 'camera2 0, facing back')],
    activeDeviceId: 'cam-0',
    trackCapabilities: { zoom: { min: 0.6, max: 6.0, step: 0.1 } },
    facingMode: 'environment',
    isMobile: true,
  });
  assert.equal(hw06Env.supportsUltraWide, true);
  assert.equal(hw06Env.ultraWideMethod, 'hardware-zoom');
  assert.equal(hw06Env.ultraWideZoom, 0.6);
  assert.equal(hw06Env.minZoom, 0.6);

  const frontEnv = analyzeCameraEnvironment({
    devices: androidDevices,
    activeDeviceId: 'cam-1',
    trackCapabilities: {},
    facingMode: 'user',
    isMobile: true,
  });
  assert.equal(frontEnv.supportsUltraWide, false);
  assert.equal(frontEnv.ultraWideMethod, 'none');
  assert.equal(frontEnv.minZoom, 1.0);
  assert.equal(frontEnv.activeRole, 'front');
});

test('analyzeCameraEnvironment does not show fake 0.5x for unverified Android camera2 sub-sensors, depth sensors, or lone Back Triple Camera', () => {
  // Typical Pixel / generic Chrome multi-camera without hw zoom < 1 or ultra-wide labels
  const pixelLike = [
    fakeDevice('c0', 'camera2 0, facing back', {
      facingMode: ['environment'],
      zoom: { min: 1.0, max: 8.0, step: 0.1 },
      width: { min: 320, max: 4080 },
    }),
    fakeDevice('c2', 'camera2 2, facing back', {
      facingMode: ['environment'],
      width: { min: 320, max: 4000 },
    }),
    fakeDevice('c4-ir', 'camera2 4, facing back', {
      facingMode: ['environment'],
      width: { min: 160, max: 480 }, // small depth/IR sensor
    }),
  ];

  const env = analyzeCameraEnvironment({
    devices: pixelLike,
    activeDeviceId: 'c0',
    trackCapabilities: { zoom: { min: 1.0, max: 8.0, step: 0.1 } },
    facingMode: 'environment',
    isMobile: true,
  });

  assert.equal(env.supportsUltraWide, false);
  assert.equal(env.ultraWideMethod, 'none');
  // Small depth/IR sensor filtered out, leaving two standard rear sensors for manual selection
  assert.equal(env.backLenses.length, 2);

  // Blocked device exclusion removes failed sensors cleanly
  const afterBlock = analyzeCameraEnvironment({
    devices: pixelLike,
    activeDeviceId: 'c0',
    trackCapabilities: { zoom: { min: 1.0, max: 8.0, step: 0.1 } },
    facingMode: 'environment',
    isMobile: true,
    blockedDeviceIds: new Set(['c2']),
  });
  assert.equal(afterBlock.backLenses.length, 1);

  // Lone Back Triple Camera without Back Ultra Wide Camera defaults to 1x, so should not fake 0.5x
  const loneTriple = analyzeCameraEnvironment({
    devices: [
      fakeDevice('b-std', 'Back Camera'),
      fakeDevice('b-tri', 'Back Triple Camera'),
    ],
    activeDeviceId: 'b-std',
    facingMode: 'environment',
    isMobile: true,
  });
  assert.equal(loneTriple.supportsUltraWide, false);
  assert.equal(loneTriple.backLenses.length, 2);
});

test('classifyVideoDevice and formatBackLensDisplayName handle labels cleanly', () => {
  const uw = classifyVideoDevice(fakeDevice('uw', '背面超広角カメラ'), { isMobile: true });
  assert.equal(uw.facing, 'back');
  assert.equal(uw.role, 'ultrawide-physical');
  assert.equal(formatBackLensDisplayName(uw), '超広角 (0.5×)');

  const frontUw = classifyVideoDevice(fakeDevice('fuw', 'Front Ultra Wide Camera'), { isMobile: true });
  assert.equal(frontUw.facing, 'front');
  assert.equal(frontUw.role, 'other');

  const desk = classifyVideoDevice(fakeDevice('dv', 'Desk View Camera'), { isMobile: true });
  assert.equal(desk.isDeskOrVirtual, true);
  assert.equal(desk.role, 'other');
});
