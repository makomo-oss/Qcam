import { splitZoom } from '../utils/geometry.js';
import {
  analyzeCameraEnvironment,
  classifyVideoDevice,
  formatBackLensDisplayName,
} from '../utils/camera-lenses.js';
import {
  buildInitialConstraintAttempts,
  computeTargetForCapabilities,
  normalizeResolutionPreset,
  shouldApplyResolutionUpgrade,
} from '../utils/resolution.js';

/**
 * Manages MediaDevices.getUserMedia, ImageCapture API, camera switching,
 * 0.5x ultra-wide lens selection, tap-to-focus / exposure, hardware + software zoom,
 * per-device max resolution acquisition, and frame extraction.
 * Never requests or plays audio so shutter remains strictly silent.
 */
const DEVICE_STORAGE_KEY = 'qcam_device_ids_v1';

function readStoredDeviceIds() {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeStoredDeviceId(facingMode, deviceId) {
  if (!deviceId) return;
  try {
    const map = readStoredDeviceIds();
    map[facingMode] = deviceId;
    localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors in private browsing
  }
}

export class CameraController {
  constructor(videoElement, platform) {
    this.video = videoElement;
    this.platform = platform;
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.capabilities = {};
    this.photoCapabilities = null;
    this._photoCapabilitiesPromise = null;
    this.facingMode = 'environment';
    this.resolutionPreset = 'max';
    this.aspectRatio = '4:3';
    this.targetZoom = 1.0;
    this.hardwareZoom = 1.0;
    this.softwareZoom = 1.0;
    this.exposureCompensation = 0;
    this.startupTimeMs = 0;
    this.onStreamInfo = null;

    this.baseLensScale = 1.0;
    this.activeBackLens = 'wide';
    this.activeDeviceId = null;
    this.activeDeviceLabel = '';
    this.backLenses = [];
    this.standardBackDeviceId = null;
    this.ultraWideDeviceId = null;
    this.ultraWideMethod = 'none';
    this.supportsUltraWide = false;
    this.ultraWideZoom = 1.0;
    this.minZoom = 1.0;
    this.blockedDeviceIds = new Set();
    this._lensSwitchPromise = null;
    this._initializingStream = false;

    this.video?.addEventListener?.('resize', () => {
      if (
        !this._initializingStream &&
        this.stream &&
        this.track?.readyState === 'live' &&
        typeof this.onStreamInfo === 'function'
      ) {
        this.onStreamInfo(this.getStreamInfo());
      }
    });
  }

  _resetLensState(activeRole = 'wide') {
    this.baseLensScale = 1.0;
    this.activeBackLens = activeRole;
    this.activeDeviceId = null;
    this.activeDeviceLabel = '';
    this.backLenses = [];
    this.standardBackDeviceId = null;
    this.ultraWideDeviceId = null;
    this.ultraWideMethod = 'none';
    this.supportsUltraWide = false;
    this.ultraWideZoom = 1.0;
    this.minZoom = 1.0;
  }

  async checkPermissionState() {
    let state = 'unknown';
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      try {
        const status = await navigator.permissions.query({ name: 'camera' });
        if (status && status.state) {
          state = status.state; // 'granted' | 'denied' | 'prompt'
        }
      } catch {
        // Safari/older browsers may throw on { name: 'camera' }
      }
    }

    let hasLabeledVideoDevice = false;
    if (
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.enumerateDevices === 'function'
    ) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        hasLabeledVideoDevice = devices.some(
          (d) => d.kind === 'videoinput' && Boolean(d.label)
        );
        if (hasLabeledVideoDevice && state === 'unknown') {
          state = 'granted';
        }
      } catch {
        // ignore enumerateDevices failure
      }
    }

    return { state, hasLabeledVideoDevice };
  }

  async _getPreferredDeviceId(facingMode) {
    const stored = readStoredDeviceIds()[facingMode];
    if (!stored || !navigator.mediaDevices?.enumerateDevices) return null;
    if (this.blockedDeviceIds.has(stored)) return null;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const match = devices.find(
        (d) => d.kind === 'videoinput' && d.deviceId === stored && Boolean(d.label)
      );
      if (!match) return null;
      if (facingMode === 'environment') {
        const classified = classifyVideoDevice(match, {
          isMobile: Boolean(this.platform?.isMobile),
        });
        if (
          classified.isDeskOrVirtual ||
          classified.facing === 'front' ||
          classified.role === 'ultrawide-physical' ||
          classified.role === 'telephoto'
        ) {
          return null;
        }
      }
      return match.deviceId;
    } catch {
      return null;
    }
  }

  _stopTracks(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // ignore
      }
    }
  }

  async _acquireConstraintsList(constraintAttempts) {
    let acquired = null;
    let errOut = null;
    for (const constraints of constraintAttempts) {
      try {
        acquired = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        errOut = err;
        if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
          throw err;
        }
      }
    }
    if (!acquired) {
      throw errOut || new Error('カメラの起動に失敗しました。');
    }
    return acquired;
  }

  async start({
    facingMode = this.facingMode,
    resolutionPreset = this.resolutionPreset,
    aspectRatio = this.aspectRatio,
    keepOldStreamDuringAcquire = false,
  } = {}) {
    const startTs = performance.now();
    this.resolutionPreset = normalizeResolutionPreset(resolutionPreset);
    this.aspectRatio = aspectRatio === '16:9' ? '16:9' : '4:3';

    if (!this.platform.supportsMediaDevices) {
      throw new Error('お使いのブラウザはカメラ API（getUserMedia）に対応していません。');
    }

    const oldStream = this.stream;
    if (!keepOldStreamDuringAcquire) {
      this.stop();
    }

    const preferredDeviceId = await this._getPreferredDeviceId(facingMode);
    const baseVideo = {
      facingMode: { ideal: facingMode },
      ...(preferredDeviceId ? { deviceId: { ideal: preferredDeviceId } } : {}),
    };

    const constraintAttempts = buildInitialConstraintAttempts({
      resolutionPreset: this.resolutionPreset,
      aspectRatio: this.aspectRatio,
      baseVideo,
    });

    let stream = null;
    try {
      stream = await this._acquireConstraintsList(constraintAttempts);
      if (keepOldStreamDuringAcquire && oldStream) {
        this._stopTracks(oldStream);
      }
    } catch (err) {
      // Single-ISP hardware cannot open front+back simultaneously -> stop old stream and retry once
      if (
        keepOldStreamDuringAcquire &&
        oldStream &&
        err?.name !== 'NotAllowedError' &&
        err?.name !== 'PermissionDeniedError'
      ) {
        this.stop();
        stream = await this._acquireConstraintsList(constraintAttempts);
      } else if (err?.name === 'NotReadableError' || err?.name === 'AbortError') {
        // Previous tab/reload may still be releasing camera sensor; brief backoff retry once
        await new Promise((r) => setTimeout(r, 220));
        stream = await this._acquireConstraintsList(constraintAttempts);
      } else {
        throw err;
      }
    }

    this._initializingStream = true;
    try {
      this.facingMode = facingMode;
      this.stream = stream;
      this.track = stream.getVideoTracks()[0] || null;
      const settings =
        this.track && typeof this.track.getSettings === 'function'
          ? this.track.getSettings()
          : {};
      this.activeDeviceId = settings.deviceId || null;
      this.activeDeviceLabel = this.track?.label || '';

      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;

      await this._waitForVideoReady();

      this._inspectCapabilities();
      await this._maybeApplyResolutionOnTrack({ onlyUpgrade: this.resolutionPreset === 'max' });
      await Promise.all([
        this._awaitPhotoCapabilities(80),
        this._refreshLensCapabilities({ preserveStandardId: false }),
      ]);

      if (
        this.activeDeviceId &&
        (facingMode === 'user' || (facingMode === 'environment' && this.activeBackLens === 'wide'))
      ) {
        writeStoredDeviceId(facingMode, this.activeDeviceId);
      }

      // Reset zoom & exposure on new camera stream
      this.targetZoom = this.baseLensScale;
      this.hardwareZoom = 1.0;
      this.softwareZoom = 1.0;
      this.exposureCompensation = 0;
    } finally {
      this._initializingStream = false;
    }

    this.startupTimeMs = Math.round(performance.now() - startTs);

    const info = this.getStreamInfo();
    if (typeof this.onStreamInfo === 'function') {
      this.onStreamInfo(info);
    }
    return info;
  }

  async _waitForVideoReady() {
    if (this.video.readyState < 1) {
      await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          cleanup();
          resolve();
        }, 1200);
        const onLoaded = () => {
          cleanup();
          resolve();
        };
        const onError = (e) => {
          cleanup();
          reject(e);
        };
        const cleanup = () => {
          clearTimeout(timeoutId);
          this.video.removeEventListener('loadedmetadata', onLoaded);
          this.video.removeEventListener('error', onError);
        };
        this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
        this.video.addEventListener('error', onError, { once: true });
      });
    }

    try {
      await this.video.play();
    } catch {
      // Autoplay might already be running or blocked until user interaction
    }

    // Wait briefly for valid videoWidth/videoHeight if metadata hadn't populated dimensions yet
    const waitStart = performance.now();
    while (
      (this.video.videoWidth === 0 || this.video.videoHeight === 0) &&
      performance.now() - waitStart < 800
    ) {
      await new Promise((r) => setTimeout(r, 16));
    }
  }

  _inspectCapabilities() {
    this.capabilities = {};
    this.photoCapabilities = null;
    this._photoCapabilitiesPromise = null;
    this.imageCapture = null;

    const capturedTrack = this.track;
    if (!capturedTrack) return;

    if (typeof capturedTrack.getCapabilities === 'function') {
      try {
        this.capabilities = capturedTrack.getCapabilities() || {};
      } catch {
        this.capabilities = {};
      }
    }

    if (this.platform.supportsImageCapture) {
      try {
        this.imageCapture = new window.ImageCapture(capturedTrack);
        if (typeof this.imageCapture.getPhotoCapabilities === 'function') {
          this._photoCapabilitiesPromise = this.imageCapture
            .getPhotoCapabilities()
            .then((caps) => {
              if (this.track !== capturedTrack) return null;
              this.photoCapabilities = caps || null;
              if (!this._initializingStream && typeof this.onStreamInfo === 'function') {
                this.onStreamInfo(this.getStreamInfo());
              }
              return this.photoCapabilities;
            })
            .catch(() => {
              if (this.track === capturedTrack) {
                this.photoCapabilities = null;
              }
              return null;
            });
        }
      } catch {
        this.imageCapture = null;
        this._photoCapabilitiesPromise = null;
      }
    }
  }

  async _awaitPhotoCapabilities(timeoutMs = 80) {
    if (!this._photoCapabilitiesPromise) return this.photoCapabilities;
    await Promise.race([
      this._photoCapabilitiesPromise,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return this.photoCapabilities;
  }

  async _waitForDimensionSettlement(prevWidth, prevHeight, timeoutMs = 140) {
    const start = performance.now();
    do {
      const vw = this.video.videoWidth || 0;
      const vh = this.video.videoHeight || 0;
      if (vw && vh && (vw !== prevWidth || vh !== prevHeight)) {
        return;
      }
      await new Promise((r) => setTimeout(r, 16));
    } while (performance.now() - start < timeoutMs);
  }

  async _maybeApplyResolutionOnTrack({ onlyUpgrade = false } = {}) {
    if (
      !this.track ||
      typeof this.track.applyConstraints !== 'function' ||
      !this.capabilities?.width?.max ||
      !this.capabilities?.height?.max
    ) {
      return false;
    }

    const currentSettings =
      typeof this.track.getSettings === 'function' ? this.track.getSettings() : {};
    const curW = this.video.videoWidth || currentSettings.width || 0;
    const curH = this.video.videoHeight || currentSettings.height || 0;

    const decision = shouldApplyResolutionUpgrade(
      { width: curW, height: curH },
      this.capabilities,
      {
        resolutionPreset: this.resolutionPreset,
        aspectRatio: this.aspectRatio,
      }
    );

    if (onlyUpgrade && this.resolutionPreset !== 'max') {
      return false;
    }
    if (!decision.shouldApply) {
      return false;
    }

    try {
      await this.track.applyConstraints({
        width: { ideal: decision.target.width },
        height: { ideal: decision.target.height },
      });
      await this._waitForDimensionSettlement(curW, curH, 100);
      return true;
    } catch {
      return false;
    }
  }

  async setResolutionPreset(
    presetId,
    { aspectRatio = this.aspectRatio, allowReacquire = true } = {}
  ) {
    this.resolutionPreset = normalizeResolutionPreset(presetId);
    this.aspectRatio = aspectRatio === '16:9' ? '16:9' : '4:3';

    if (!this.track || this.track.readyState !== 'live') {
      return this.getStreamInfo();
    }

    const sBefore = this.track.getSettings?.() || {};
    const beforeW = this.video.videoWidth || sBefore.width || 0;
    const beforeH = this.video.videoHeight || sBefore.height || 0;

    const target = computeTargetForCapabilities(this.capabilities, {
      resolutionPreset: this.resolutionPreset,
      aspectRatio: this.aspectRatio,
      fallbackWidth: beforeW,
      fallbackHeight: beforeH,
    });

    if (typeof this.track.applyConstraints === 'function') {
      try {
        await this.track.applyConstraints({
          width: { ideal: target.width },
          height: { ideal: target.height },
        });
        await this._waitForDimensionSettlement(beforeW, beforeH, 220);
      } catch {
        // Ignore if live track rejects width/height applyConstraints
      }
    }

    const sAfter = this.track.getSettings?.() || {};
    const afterW = this.video.videoWidth || sAfter.width || 0;
    const afterH = this.video.videoHeight || sAfter.height || 0;

    const targetLong = Math.max(target.width, target.height);
    const targetShort = Math.min(target.width, target.height);
    const afterLong = Math.max(afterW, afterH);
    const afterShort = Math.min(afterW, afterH);

    // If driver left resolution far from explicitly chosen target, restart stream with ideal constraints
    if (
      allowReacquire &&
      targetLong > 0 &&
      (Math.abs(afterLong - targetLong) > targetLong * 0.14 ||
        Math.abs(afterShort - targetShort) > targetShort * 0.14)
    ) {
      try {
        const perm = await this.checkPermissionState();
        if (!this.platform.isIOS || perm.state === 'granted') {
          if (this.facingMode === 'environment' && this.activeDeviceId && this.activeBackLens !== 'wide') {
            return await this.selectBackLens(this.activeDeviceId, {
              targetZoom: this.targetZoom,
              forceReacquire: true,
            });
          }
          return await this.start({
            facingMode: this.facingMode,
            resolutionPreset: this.resolutionPreset,
            aspectRatio: this.aspectRatio,
            keepOldStreamDuringAcquire: this.platform.isIOS,
          });
        }
      } catch {
        // Keep active working stream on reacquire failure
      }
    }

    const info = this.getStreamInfo();
    if (typeof this.onStreamInfo === 'function') {
      this.onStreamInfo(info);
    }
    return info;
  }

  async _refreshLensCapabilities({ preserveStandardId = false } = {}) {
    if (this.facingMode !== 'environment') {
      this._resetLensState('front');
      return;
    }

    let devices = [];
    if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
      try {
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        devices = [];
      }
    }

    const env = analyzeCameraEnvironment({
      devices,
      activeDeviceId: this.activeDeviceId,
      trackCapabilities: this.capabilities,
      facingMode: this.facingMode,
      isMobile: Boolean(this.platform?.isMobile),
      blockedDeviceIds: this.blockedDeviceIds,
    });

    this.backLenses = env.backLenses;
    if (
      !preserveStandardId ||
      !this.standardBackDeviceId ||
      this.blockedDeviceIds.has(this.standardBackDeviceId)
    ) {
      this.standardBackDeviceId =
        env.standardBackDevice?.deviceId ||
        (env.activeRole === 'wide' ? this.activeDeviceId : null);
    }

    this.ultraWideDeviceId = env.ultraWideDevice?.deviceId || null;
    this.supportsUltraWide = env.supportsUltraWide;
    this.ultraWideMethod = env.ultraWideMethod;
    this.ultraWideZoom = env.ultraWideZoom;
    this.minZoom = env.minZoom;

    if (env.activeRole === 'ultrawide') {
      this.activeBackLens = 'ultrawide';
    } else if (
      env.activeRole === 'telephoto' ||
      (this.standardBackDeviceId &&
        this.activeDeviceId &&
        this.activeDeviceId !== this.standardBackDeviceId)
    ) {
      this.activeBackLens = 'custom';
    } else {
      this.activeBackLens = 'wide';
    }

    this.baseLensScale =
      this.ultraWideMethod === 'device-switch' && this.activeBackLens === 'ultrawide'
        ? 0.5
        : 1.0;

    if (!this.activeDeviceLabel && this.activeDeviceId && devices.length) {
      const matched = devices.find((d) => d.deviceId === this.activeDeviceId);
      if (matched?.label) {
        this.activeDeviceLabel = matched.label;
      }
    }
  }

  getStreamInfo() {
    const settings =
      this.track && typeof this.track.getSettings === 'function'
        ? this.track.getSettings()
        : {};
    const videoWidth = this.video.videoWidth || settings.width || 0;
    const videoHeight = this.video.videoHeight || settings.height || 0;
    const actualFacing = settings.facingMode || this.facingMode;
    const maxHardwareZoom =
      this.capabilities.zoom && typeof this.capabilities.zoom.max === 'number'
        ? this.capabilities.zoom.max
        : null;
    const minHardwareZoom =
      this.capabilities.zoom && typeof this.capabilities.zoom.min === 'number'
        ? this.capabilities.zoom.min
        : null;

    const formattedLenses = (this.backLenses || []).map((lens, idx) => ({
      deviceId: lens.deviceId,
      role: lens.role,
      label: formatBackLensDisplayName(lens, idx),
      rawLabel: lens.label,
    }));

    return {
      videoWidth,
      videoHeight,
      frameRate: settings.frameRate ? Math.round(settings.frameRate) : null,
      facingMode: actualFacing,
      resolutionPreset: this.resolutionPreset,
      trackCapabilities: this.capabilities,
      capWidth: this.capabilities?.width?.max || videoWidth || null,
      capHeight: this.capabilities?.height?.max || videoHeight || null,
      startupTimeMs: this.startupTimeMs,
      supportsHardwareZoom: Boolean(
        (maxHardwareZoom && maxHardwareZoom > 1) ||
          (minHardwareZoom && minHardwareZoom < 0.99)
      ),
      minZoom: this.minZoom,
      maxZoom: Math.max(5.0, maxHardwareZoom || 5.0),
      supportsUltraWide: this.supportsUltraWide,
      ultraWideMethod: this.ultraWideMethod,
      ultraWideZoom: this.ultraWideZoom,
      activeBackLens: this.activeBackLens,
      activeDeviceId: this.activeDeviceId,
      activeDeviceLabel: this.activeDeviceLabel,
      backLenses: formattedLenses,
      supportsPointsOfInterest: Boolean(this.capabilities.pointsOfInterest),
      supportsFocusMode: Array.isArray(this.capabilities.focusMode),
      supportsHardwareExposure: Boolean(this.capabilities.exposureCompensation),
      exposureRange: this.capabilities.exposureCompensation || { min: -2, max: 2, step: 0.2 },
      supportsTakePhoto: Boolean(
        this.platform.preferTakePhoto &&
          this.imageCapture &&
          typeof this.imageCapture.takePhoto === 'function'
      ),
      photoMaxWidth: this.photoCapabilities?.imageWidth?.max || null,
      photoMaxHeight: this.photoCapabilities?.imageHeight?.max || null,
    };
  }

  async switchCamera() {
    const nextFacing = this.facingMode === 'environment' ? 'user' : 'environment';
    this._resetLensState(nextFacing === 'user' ? 'front' : 'wide');
    return this.start({
      facingMode: nextFacing,
      resolutionPreset: this.resolutionPreset,
      aspectRatio: this.aspectRatio,
      keepOldStreamDuringAcquire: this.platform.isIOS,
    });
  }

  async selectBackLens(targetDeviceId, { targetZoom = null, forceReacquire = false } = {}) {
    if (!targetDeviceId || this.facingMode !== 'environment') {
      return this.getStreamInfo();
    }
    const runSwitch = () =>
      this._performSelectBackLens(targetDeviceId, { targetZoom, forceReacquire });
    const queued = this._lensSwitchPromise
      ? this._lensSwitchPromise.then(runSwitch, runSwitch)
      : runSwitch();
    this._lensSwitchPromise = queued.finally(() => {
      if (this._lensSwitchPromise === queued) {
        this._lensSwitchPromise = null;
      }
    });
    return queued;
  }

  async _performSelectBackLens(targetDeviceId, { targetZoom = null, forceReacquire = false } = {}) {
    if (
      !forceReacquire &&
      this.activeDeviceId === targetDeviceId &&
      this.track &&
      this.track.readyState === 'live'
    ) {
      if (typeof targetZoom === 'number') {
        await this._applySplitZoom(targetZoom);
        this.onStreamInfo?.(this.getStreamInfo());
      }
      return this.getStreamInfo();
    }

    const prevDeviceId = this.activeDeviceId;
    const savedStandardId = this.standardBackDeviceId;
    const oldStream = this.stream;
    const keepOldStreamDuringAcquire = Boolean(this.platform?.isIOS);

    if (!keepOldStreamDuringAcquire) {
      this.stop({ clearLensCache: false });
    }

    // Request exact deviceId WITHOUT pairing facingMode to avoid HAL OverconstrainedError on auxiliary lenses
    const exactAttempts = buildInitialConstraintAttempts({
      resolutionPreset: this.resolutionPreset,
      aspectRatio: this.aspectRatio,
      baseVideo: { deviceId: { exact: targetDeviceId } },
    });

    let stream = null;
    try {
      try {
        stream = await this._acquireConstraintsList(exactAttempts);
        if (keepOldStreamDuringAcquire && oldStream) {
          this._stopTracks(oldStream);
        }
      } catch (err) {
        if (
          keepOldStreamDuringAcquire &&
          oldStream &&
          err?.name !== 'NotAllowedError' &&
          err?.name !== 'PermissionDeniedError'
        ) {
          this.stop({ clearLensCache: false });
          stream = await this._acquireConstraintsList(exactAttempts);
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'PermissionDeniedError') {
        this.blockedDeviceIds.add(targetDeviceId);
      }
      if (!this.stream || !this.track || this.track.readyState === 'ended') {
        const recoverId =
          prevDeviceId &&
          prevDeviceId !== targetDeviceId &&
          !this.blockedDeviceIds.has(prevDeviceId)
            ? prevDeviceId
            : savedStandardId &&
              savedStandardId !== targetDeviceId &&
              !this.blockedDeviceIds.has(savedStandardId)
            ? savedStandardId
            : null;
        try {
          if (recoverId) {
            const recoverStream = await this._acquireConstraintsList(
              buildInitialConstraintAttempts({
                resolutionPreset: this.resolutionPreset,
                aspectRatio: this.aspectRatio,
                baseVideo: { deviceId: { exact: recoverId } },
              })
            );
            this._initializingStream = true;
            try {
              this.facingMode = 'environment';
              this.stream = recoverStream;
              this.track = recoverStream.getVideoTracks()[0] || null;
              const rSettings = this.track?.getSettings?.() || {};
              this.activeDeviceId = rSettings.deviceId || recoverId;
              this.activeDeviceLabel = this.track?.label || '';
              this.video.srcObject = recoverStream;
              this.video.muted = true;
              this.video.playsInline = true;
              await this._waitForVideoReady();
              this._inspectCapabilities();
              await this._maybeApplyResolutionOnTrack({ onlyUpgrade: this.resolutionPreset === 'max' });
              await Promise.all([
                this._awaitPhotoCapabilities(80),
                this._refreshLensCapabilities({ preserveStandardId: true }),
              ]);
              if (
                !this.standardBackDeviceId &&
                savedStandardId &&
                !this.blockedDeviceIds.has(savedStandardId)
              ) {
                this.standardBackDeviceId = savedStandardId;
              }
            } finally {
              this._initializingStream = false;
            }
          } else {
            await this.start({ facingMode: 'environment' });
          }
        } catch {
          // Leave clean state if recovery also failed
        }
      } else {
        await this._refreshLensCapabilities({ preserveStandardId: true });
      }
      this.onStreamInfo?.(this.getStreamInfo());
      throw err;
    }

    this._initializingStream = true;
    try {
      this.facingMode = 'environment';
      this.stream = stream;
      this.track = stream.getVideoTracks()[0] || null;
      const settings =
        this.track && typeof this.track.getSettings === 'function'
          ? this.track.getSettings()
          : {};
      this.activeDeviceId = settings.deviceId || targetDeviceId;
      this.activeDeviceLabel = this.track?.label || '';

      this.video.srcObject = stream;
      this.video.muted = true;
      this.video.playsInline = true;

      await this._waitForVideoReady();

      this._inspectCapabilities();
      await this._maybeApplyResolutionOnTrack({ onlyUpgrade: this.resolutionPreset === 'max' });
      await Promise.all([
        this._awaitPhotoCapabilities(80),
        this._refreshLensCapabilities({ preserveStandardId: true }),
      ]);
      if (
        !this.standardBackDeviceId &&
        savedStandardId &&
        !this.blockedDeviceIds.has(savedStandardId)
      ) {
        this.standardBackDeviceId = savedStandardId;
      }

      if (this.activeDeviceId && this.activeBackLens === 'wide') {
        writeStoredDeviceId('environment', this.activeDeviceId);
      }

      this.exposureCompensation = 0;
      const desiredZoom =
        typeof targetZoom === 'number' && Number.isFinite(targetZoom)
          ? targetZoom
          : this.baseLensScale;
      await this._applySplitZoom(desiredZoom);
    } finally {
      this._initializingStream = false;
    }

    const info = this.getStreamInfo();
    if (typeof this.onStreamInfo === 'function') {
      this.onStreamInfo(info);
    }
    return info;
  }

  async _applySplitZoom(requestedZoom) {
    const maxTotal = Math.max(5.0, this.capabilities?.zoom?.max || 5.0);
    const result = splitZoom(
      requestedZoom,
      this.capabilities?.zoom || null,
      maxTotal,
      { baseLensScale: this.baseLensScale }
    );
    this.targetZoom = result.totalZoom;
    this.hardwareZoom = result.hardwareZoom;
    this.softwareZoom = result.softwareZoom;

    if (
      result.hardwareSupported &&
      this.track &&
      typeof this.track.applyConstraints === 'function'
    ) {
      try {
        await this.track.applyConstraints({
          advanced: [{ zoom: result.hardwareZoom }],
        });
      } catch {
        // Fallback safely without ever shrinking preview (< 1.0 software crop)
        const fallbackSoftware = Number(
          Math.max(1.0, result.totalZoom / this.baseLensScale).toFixed(4)
        );
        const fallbackTotal = Number((this.baseLensScale * fallbackSoftware).toFixed(2));
        this.hardwareZoom = 1.0;
        this.softwareZoom = fallbackSoftware;
        this.targetZoom = fallbackTotal;
        return {
          hardwareSupported: false,
          hardwareZoom: 1.0,
          softwareZoom: fallbackSoftware,
          totalZoom: fallbackTotal,
        };
      }
    }

    return result;
  }

  async setZoom(requestedZoom) {
    const req = Number(requestedZoom);
    const safeReq = Number.isFinite(req) ? req : this.baseLensScale;

    if (this.facingMode === 'environment') {
      const shouldSwitchToUltraWide =
        this.ultraWideMethod === 'device-switch' &&
        Boolean(this.ultraWideDeviceId) &&
        this.activeBackLens !== 'ultrawide' &&
        safeReq <= 0.75;

      if (shouldSwitchToUltraWide) {
        const uwTarget = Math.max(this.ultraWideZoom || 0.5, Math.min(0.9, safeReq));
        await this.selectBackLens(this.ultraWideDeviceId, { targetZoom: uwTarget });
        return {
          hardwareSupported: this.hardwareZoom !== 1.0,
          hardwareZoom: this.hardwareZoom,
          softwareZoom: this.softwareZoom,
          totalZoom: this.targetZoom,
        };
      }

      const maxTrackZoom =
        this.capabilities?.zoom && typeof this.capabilities.zoom.max === 'number'
          ? this.capabilities.zoom.max
          : 1.0;
      const shouldSwitchBackToWide =
        this.activeBackLens === 'ultrawide' &&
        Boolean(this.standardBackDeviceId) &&
        this.standardBackDeviceId !== this.activeDeviceId &&
        safeReq >= 0.95 &&
        (this.ultraWideMethod === 'device-switch' || maxTrackZoom < 1.5);

      if (shouldSwitchBackToWide) {
        const wideTarget = Math.max(1.0, safeReq);
        await this.selectBackLens(this.standardBackDeviceId, { targetZoom: wideTarget });
        return {
          hardwareSupported: this.hardwareZoom !== 1.0,
          hardwareZoom: this.hardwareZoom,
          softwareZoom: this.softwareZoom,
          totalZoom: this.targetZoom,
        };
      }
    }

    return this._applySplitZoom(safeReq);
  }

  async focusAt(normalizedX, normalizedY) {
    if (!this.track || typeof this.track.applyConstraints !== 'function') {
      return { appliedHardware: false };
    }

    const advancedConstraints = [];
    const caps = this.capabilities || {};

    if (caps.pointsOfInterest) {
      advancedConstraints.push({
        pointsOfInterest: [{ x: normalizedX, y: normalizedY }],
      });
    }

    if (Array.isArray(caps.focusMode)) {
      if (caps.focusMode.includes('single-shot')) {
        advancedConstraints.push({ focusMode: 'single-shot' });
      } else if (caps.focusMode.includes('continuous')) {
        advancedConstraints.push({ focusMode: 'continuous' });
      }
    }

    if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('continuous')) {
      advancedConstraints.push({ exposureMode: 'continuous' });
    }

    if (advancedConstraints.length === 0) {
      return { appliedHardware: false };
    }

    try {
      await this.track.applyConstraints({ advanced: advancedConstraints });
      return { appliedHardware: true };
    } catch {
      return { appliedHardware: false };
    }
  }

  async setExposureCompensation(ev) {
    const clamped = Math.max(-2.0, Math.min(2.0, Number(ev) || 0));
    this.exposureCompensation = clamped;

    const hwRange = this.capabilities?.exposureCompensation;
    if (
      hwRange &&
      this.track &&
      typeof this.track.applyConstraints === 'function'
    ) {
      const hwClamped = Math.max(
        hwRange.min ?? -2,
        Math.min(hwRange.max ?? 2, clamped)
      );
      try {
        await this.track.applyConstraints({
          advanced: [{ exposureCompensation: hwClamped }],
        });
        return { hardwareApplied: true, softwareEv: 0, value: hwClamped };
      } catch {
        // Fall through to software EV
      }
    }

    return { hardwareApplied: false, softwareEv: clamped, value: clamped };
  }

  async tryCaptureTakePhoto() {
    if (
      !this.platform.preferTakePhoto ||
      !this.imageCapture ||
      typeof this.imageCapture.takePhoto !== 'function'
    ) {
      return null;
    }

    const photoSettings = {};
    if (this.photoCapabilities?.imageWidth?.max) {
      photoSettings.imageWidth = this.photoCapabilities.imageWidth.max;
    }
    if (this.photoCapabilities?.imageHeight?.max) {
      photoSettings.imageHeight = this.photoCapabilities.imageHeight.max;
    }

    let blob = null;
    try {
      blob =
        Object.keys(photoSettings).length > 0
          ? await this.imageCapture.takePhoto(photoSettings)
          : await this.imageCapture.takePhoto();
    } catch {
      if (Object.keys(photoSettings).length > 0) {
        try {
          blob = await this.imageCapture.takePhoto();
        } catch {
          blob = null;
        }
      }
    }

    if (!blob) return null;

    try {
      const bitmap = await createImageBitmap(blob);
      const streamW = this.video.videoWidth || 0;
      const streamH = this.video.videoHeight || 0;
      // Only prefer takePhoto if it achieves >= stream resolution (avoids budget drivers returning VGA stills)
      if (streamW > 0 && streamH > 0 && bitmap.width * bitmap.height < streamW * streamH * 0.95) {
        bitmap.close();
        return null;
      }
      return {
        sourceType: 'takePhoto',
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
      };
    } catch {
      return null;
    }
  }

  /**
   * Capture a single high-resolution frame.
   * On Android Chrome: prioritize ImageCapture.takePhoto() for sensor max resolution.
   * On iOS Safari (and fallback): extract directly from the active <video> stream.
   */
  async captureSingleFrame({ preferTakePhoto = this.platform.preferTakePhoto } = {}) {
    if (preferTakePhoto) {
      const still = await this.tryCaptureTakePhoto();
      if (still) return still;
    }

    const bitmap = await this._grabStreamBitmap();
    return {
      sourceType: 'videoStream',
      bitmap,
      width: bitmap.width,
      height: bitmap.height,
    };
  }

  /**
   * Capture N frames consecutively across ~0.2s for multi-frame noise reduction.
   * Uses requestVideoFrameCallback when available with timer guard so it never stalls.
   */
  async captureBurstFrames(frameCount = 4, targetDurationMs = 200) {
    const frames = [];
    const intervalMs = Math.max(40, Math.floor(targetDurationMs / Math.max(1, frameCount)));

    for (let i = 0; i < frameCount; i++) {
      const frameStart = performance.now();
      if (i > 0) {
        await this._waitNextFrameOrInterval(intervalMs);
      }
      const bitmap = await this._grabStreamBitmap();
      frames.push(bitmap);
      const elapsed = performance.now() - frameStart;
      if (i < frameCount - 1 && elapsed < 35) {
        await new Promise((r) => setTimeout(r, 35 - elapsed));
      }
    }

    return {
      sourceType: 'burstStream',
      frames,
      width: frames[0]?.width || this.video.videoWidth,
      height: frames[0]?.height || this.video.videoHeight,
    };
  }

  async _waitNextFrameOrInterval(maxWaitMs) {
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, maxWaitMs);

        this.video.requestVideoFrameCallback(() => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });
      });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, maxWaitMs));
  }

  async _grabStreamBitmap() {
    // Try ImageCapture.grabFrame() first on Chrome/Android if stream is active
    if (
      !this.platform.isIOS &&
      this.imageCapture &&
      typeof this.imageCapture.grabFrame === 'function'
    ) {
      try {
        const bitmap = await this.imageCapture.grabFrame();
        if (bitmap && bitmap.width > 0 && bitmap.height > 0) {
          return bitmap;
        }
      } catch {
        // Fallback to <video> element extraction
      }
    }

    if (typeof createImageBitmap === 'function' && this.video.readyState >= 2) {
      return createImageBitmap(this.video);
    }

    // Ultimate Canvas2D fallback if createImageBitmap(video) is unavailable
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, this.video.videoWidth);
    canvas.height = Math.max(1, this.video.videoHeight);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return createImageBitmap(canvas);
  }

  stop({ clearLensCache = true } = {}) {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
    }
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.capabilities = {};
    this.photoCapabilities = null;
    this._photoCapabilitiesPromise = null;
    this.activeDeviceId = null;
    this.activeDeviceLabel = '';
    this.baseLensScale = 1.0;
    if (clearLensCache) {
      this._resetLensState(this.facingMode === 'user' ? 'front' : 'wide');
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }
}
