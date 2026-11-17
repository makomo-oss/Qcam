/**
 * Camera enumeration, rear lens classification, and ultra-wide (0.5x) detection.
 * Pure functions allow deterministic unit tests across localized iOS / Android labels.
 */

const DESK_OR_VIRTUAL_RE =
  /desk\s*view|デスクビュー|書画カメラ|obs\s*virtual|virtual\s*camera|snap\s*camera|continuity\s*camera|連係カメラ/i;

const FRONT_LABEL_RE =
  /(?:^|[\s,(（_-])(front|user|selfie|facetime|truedepth|center\s*stage)(?:$|[\s,)）_-])|facing\s*front|前面|前置|インカメラ|セルフィー|自撮り/i;

const BACK_LABEL_RE =
  /(?:^|[\s,(（_-])(back|rear|environment)(?:$|[\s,)）_-])|facing\s*back|背面|後置|アウトカメラ|リア|rückkamera|arrière|trasera|posteriore|traseira|후면|后置/i;

const ULTRAWIDE_PHYSICAL_RE =
  /ultra\s*-?\s*wide|ultrawide|ultra\s*-?\s*grand|ultra\s*-?\s*gran|ultra\s*-?\s*weit|ultra\s*amplio|grandangolare\s*ultra|ultra\s*wide|超広角|超廣角|超广角|초광각|сверхширок|0\.5\s*[x×]/i;

const ULTRAWIDE_VIRTUAL_RE =
  /dual\s*-?\s*wide|triple\s*camera|デュアル広角|トリプルカメラ/i;

const TELEPHOTO_RE =
  /telephoto|periscope|望遠|長焦|망원|(?:^|[\s,(（])[2345]\.?0?\s*[x×](?:$|[\s,)）])/i;

const DUAL_STANDARD_RE =
  /dual\s*camera|デュアルカメラ/i;

function safeDeviceCapabilities(device) {
  if (!device || typeof device.getCapabilities !== 'function') {
    return null;
  }
  try {
    return device.getCapabilities() || null;
  } catch {
    return null;
  }
}

export function isDeskOrVirtualNonCameraLabel(label = '') {
  return DESK_OR_VIRTUAL_RE.test(label);
}

/**
 * Classify a single MediaDeviceInfo (`videoinput`) for facing and lens role.
 */
export function classifyVideoDevice(device, { isMobile = false } = {}) {
  const label = String(device?.label || '').trim();
  const deviceId = String(device?.deviceId || '');
  const caps = safeDeviceCapabilities(device);
  const facingCaps = Array.isArray(caps?.facingMode) ? caps.facingMode : [];

  const isDeskOrVirtual = isDeskOrVirtualNonCameraLabel(label);

  let facing = 'unknown';
  if (facingCaps.includes('user') && !facingCaps.includes('environment')) {
    facing = 'front';
  } else if (facingCaps.includes('environment')) {
    facing = 'back';
  } else if (FRONT_LABEL_RE.test(label) && !BACK_LABEL_RE.test(label)) {
    facing = 'front';
  } else if (BACK_LABEL_RE.test(label)) {
    facing = 'back';
  } else if (isMobile && ULTRAWIDE_PHYSICAL_RE.test(label) && !FRONT_LABEL_RE.test(label)) {
    facing = 'back';
  }

  const maxCapWidth =
    caps?.width && typeof caps.width.max === 'number' ? caps.width.max : null;
  const hwZoomCap =
    caps?.zoom &&
    typeof caps.zoom.min === 'number' &&
    typeof caps.zoom.max === 'number' &&
    caps.zoom.max >= caps.zoom.min
      ? caps.zoom
      : null;

  let role = 'other';
  if (!isDeskOrVirtual && facing !== 'front') {
    if (ULTRAWIDE_VIRTUAL_RE.test(label)) {
      role = 'ultrawide-virtual';
    } else if (ULTRAWIDE_PHYSICAL_RE.test(label)) {
      role = 'ultrawide-physical';
    } else if (TELEPHOTO_RE.test(label)) {
      role = 'telephoto';
    } else if (DUAL_STANDARD_RE.test(label)) {
      role = 'virtual-dual-std';
    } else if (facing === 'back') {
      role = 'standard';
    }
  }

  return {
    deviceId,
    label,
    facing,
    role,
    isDeskOrVirtual,
    maxCapWidth,
    hwZoomMin: hwZoomCap ? hwZoomCap.min : null,
    hwZoomMax: hwZoomCap ? hwZoomCap.max : null,
  };
}

/**
 * Inspect enumerated media devices alongside active stream capabilities
 * to determine whether 0.5x ultra-wide mode is supported on the current camera.
 */
export function analyzeCameraEnvironment({
  devices = [],
  activeDeviceId = null,
  trackCapabilities = {},
  facingMode = 'environment',
  isMobile = false,
  blockedDeviceIds = null,
} = {}) {
  const blocked = blockedDeviceIds instanceof Set ? blockedDeviceIds : new Set();

  const videoInputs = (Array.isArray(devices) ? devices : []).filter(
    (d) => d && d.kind === 'videoinput' && d.deviceId
  );

  const classified = videoInputs.map((d) => classifyVideoDevice(d, { isMobile }));

  const backLenses = classified.filter(
    (c) =>
      c.facing === 'back' &&
      !c.isDeskOrVirtual &&
      !blocked.has(c.deviceId) &&
      (c.maxCapWidth === null || c.maxCapWidth >= 640)
  );

  // Exclude rear hardware check cleanly when user selected front ('user') camera
  if (facingMode !== 'environment') {
    return {
      backLenses,
      standardBackDevice: null,
      ultraWideDevice: null,
      supportsUltraWide: false,
      ultraWideMethod: 'none',
      ultraWideZoom: 1.0,
      minZoom: 1.0,
      activeRole: 'front',
    };
  }

  const activeEntry =
    classified.find((c) => c.deviceId && c.deviceId === activeDeviceId) || null;

  const physicalUw = backLenses.find((c) => c.role === 'ultrawide-physical') || null;
  const hwZoomDeviceUw =
    backLenses.find((c) => typeof c.hwZoomMin === 'number' && c.hwZoomMin < 0.99) || null;
  const virtualUw = backLenses.find((c) => c.role === 'ultrawide-virtual') || null;

  // Prefer plain standard rear lens ("Back Camera" / "背面カメラ" / "camera2 0, facing back")
  const standardCandidates = backLenses.filter((c) => c.role === 'standard');
  const standardBackDevice =
    standardCandidates.find((c) => c.deviceId === activeDeviceId) ||
    standardCandidates[0] ||
    backLenses.find((c) => c.role === 'virtual-dual-std') ||
    (physicalUw ? virtualUw : null) ||
    null;

  // Only advertise 0.5x device-switch for genuine physical ultra-wide lenses or devices advertising zoom < 1.0
  // Virtual multi-lens devices ("Back Triple Camera" / "Back Dual Wide Camera") default to 1x in WebKit and remain selectable manually
  const ultraWideDevice = physicalUw || hwZoomDeviceUw || null;

  const trackZoom = trackCapabilities?.zoom;
  const hasTrackUltraWideZoom = Boolean(
    trackZoom &&
      typeof trackZoom.min === 'number' &&
      typeof trackZoom.max === 'number' &&
      trackZoom.max >= trackZoom.min &&
      trackZoom.min < 0.99
  );

  let ultraWideMethod = 'none';
  let ultraWideZoom = 1.0;

  if (hasTrackUltraWideZoom) {
    ultraWideMethod = 'hardware-zoom';
    const rawMin = Math.max(0.25, trackZoom.min);
    ultraWideZoom = rawMin <= 0.5 ? 0.5 : Number(rawMin.toFixed(1));
  } else if (ultraWideDevice) {
    ultraWideMethod = 'device-switch';
    ultraWideZoom = 0.5;
  }

  const supportsUltraWide = ultraWideMethod !== 'none';
  const minZoom = supportsUltraWide
    ? hasTrackUltraWideZoom
      ? Number(Math.max(0.25, trackZoom.min).toFixed(2))
      : 0.5
    : 1.0;

  const isActiveUltraWide = Boolean(
    activeEntry &&
      (activeEntry.role === 'ultrawide-physical' ||
        (ultraWideDevice &&
          standardBackDevice &&
          ultraWideDevice.deviceId !== standardBackDevice.deviceId &&
          activeEntry.deviceId === ultraWideDevice.deviceId))
  );

  const activeRole = isActiveUltraWide
    ? 'ultrawide'
    : activeEntry && activeEntry.role === 'telephoto'
    ? 'telephoto'
    : 'wide';

  return {
    backLenses,
    standardBackDevice,
    ultraWideDevice,
    supportsUltraWide,
    ultraWideMethod,
    ultraWideZoom,
    minZoom,
    activeRole,
  };
}

/**
 * Produce a clean Japanese display name for an enumerated back lens entry.
 */
export function formatBackLensDisplayName(lens, index = 0) {
  if (!lens) return `背面レンズ ${index + 1}`;
  if (lens.role === 'ultrawide-physical') return '超広角 (0.5×)';
  if (lens.role === 'ultrawide-virtual') return '超広角/広角統合';
  if (lens.role === 'telephoto') return '望遠レンズ';
  if (lens.role === 'virtual-dual-std') return '標準デュアル';
  if (/camera2\s+\d+/i.test(lens.label)) {
    return lens.label;
  }
  if (/back\s*camera|背面カメラ/i.test(lens.label)) {
    return '標準広角 (1×)';
  }
  return lens.label || `背面レンズ ${index + 1}`;
}
