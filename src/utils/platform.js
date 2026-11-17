/**
 * Platform & browser capability detection for OS-specific camera and save flows.
 * Pure functions allow deterministic unit testing with mocked environment objects.
 */

export function detectPlatform(env = globalThis) {
  const nav = env.navigator || {};
  const win = env.window || env;
  const ua = nav.userAgent || '';
  const platform = nav.platform || '';
  const maxTouchPoints = Number(nav.maxTouchPoints || 0);

  // iPadOS 13+ reports Macintosh in UA while having touch points > 1
  const isIPadOS = /Macintosh/i.test(ua) && maxTouchPoints > 1;
  const isIPhoneOrIPod = /iPhone|iPod/i.test(ua);
  const isIPadUA = /iPad/i.test(ua);
  const isIOS = isIPhoneOrIPod || isIPadUA || isIPadOS;

  const isAndroid = /Android/i.test(ua);

  // Detect Safari vs Chrome/CriOS/FxiOS/EdgA
  const isCriOS = /CriOS/i.test(ua);
  const isFxiOS = /FxiOS/i.test(ua);
  const isEdge = /Edg|EdgA|EdgiOS/i.test(ua);
  const isChrome = (/Chrome|Chromium/i.test(ua) && !isEdge) || isCriOS;
  const isSafari =
    /Safari/i.test(ua) &&
    !isChrome &&
    !isEdge &&
    !isFxiOS &&
    !/Firefox/i.test(ua);

  const supportsMediaDevices = Boolean(
    nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function'
  );
  const supportsImageCapture = typeof win.ImageCapture === 'function';
  const supportsOffscreenCanvas = typeof win.OffscreenCanvas === 'function';
  const supportsWorker = typeof win.Worker === 'function';

  let supportsOffscreenWebGL = false;
  if (supportsOffscreenCanvas) {
    try {
      const probe = new win.OffscreenCanvas(1, 1);
      supportsOffscreenWebGL = Boolean(
        probe.getContext('webgl2') || probe.getContext('webgl')
      );
    } catch {
      supportsOffscreenWebGL = false;
    }
  }

  let supportsWebShareFiles = false;
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function') {
    try {
      if (typeof win.File === 'function') {
        const probeFile = new win.File(['x'], 'probe.jpg', { type: 'image/jpeg' });
        supportsWebShareFiles = Boolean(nav.canShare({ files: [probeFile] }));
      } else {
        supportsWebShareFiles = true;
      }
    } catch {
      supportsWebShareFiles = false;
    }
  }

  const isStandalonePWA = Boolean(
    nav.standalone === true ||
      (typeof win.matchMedia === 'function' &&
        win.matchMedia('(display-mode: standalone)').matches)
  );

  // Strategy selection matching Section 4 of the specification
  const preferTakePhoto = !isIOS && supportsImageCapture;
  const preferWebShareSave = isIOS && supportsWebShareFiles;

  return {
    isIOS,
    isAndroid,
    isSafari,
    isChrome,
    isStandalonePWA,
    supportsMediaDevices,
    supportsImageCapture,
    supportsOffscreenCanvas,
    supportsOffscreenWebGL,
    supportsWorker,
    supportsWebShareFiles,
    preferTakePhoto,
    preferWebShareSave,
    osLabel: isIOS ? 'iOS' : isAndroid ? 'Android' : 'Desktop',
    browserLabel: isSafari ? 'Safari' : isChrome ? 'Chrome' : 'Browser',
  };
}
