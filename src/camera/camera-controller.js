import { splitZoom } from '../utils/geometry.js';

/**
 * Manages MediaDevices.getUserMedia, ImageCapture API, camera switching,
 * tap-to-focus / exposure, hardware + software zoom, and frame extraction.
 * Never requests or plays audio so shutter remains strictly silent.
 */
export class CameraController {
  constructor(videoElement, platform) {
    this.video = videoElement;
    this.platform = platform;
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.capabilities = {};
    this.photoCapabilities = null;
    this.facingMode = 'environment';
    this.targetZoom = 1.0;
    this.hardwareZoom = 1.0;
    this.softwareZoom = 1.0;
    this.exposureCompensation = 0;
    this.startupTimeMs = 0;
    this.onStreamInfo = null;
  }

  async start({ facingMode = this.facingMode } = {}) {
    const startTs = performance.now();
    this.facingMode = facingMode;
    this.stop();

    if (!this.platform.supportsMediaDevices) {
      throw new Error('お使いのブラウザはカメラ API（getUserMedia）に対応していません。');
    }

    const constraintAttempts = [
      {
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
      },
      {
        audio: false,
        video: {
          facingMode: { ideal: facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      },
      {
        audio: false,
        video: { facingMode },
      },
      {
        audio: false,
        video: true,
      },
    ];

    let stream = null;
    let lastError = null;
    for (const constraints of constraintAttempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err) {
        lastError = err;
        // Do not retry if user explicitly denied permission
        if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
          throw err;
        }
      }
    }

    if (!stream) {
      throw lastError || new Error('カメラの起動に失敗しました。');
    }

    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;
    this.video.srcObject = stream;
    this.video.muted = true;
    this.video.playsInline = true;

    await this._waitForVideoReady();

    this._inspectCapabilities();
    // Reset zoom & exposure on new camera stream
    this.targetZoom = 1.0;
    this.hardwareZoom = 1.0;
    this.softwareZoom = 1.0;
    this.exposureCompensation = 0;

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
    this.imageCapture = null;

    if (!this.track) return;

    if (typeof this.track.getCapabilities === 'function') {
      try {
        this.capabilities = this.track.getCapabilities() || {};
      } catch {
        this.capabilities = {};
      }
    }

    if (this.platform.supportsImageCapture) {
      try {
        this.imageCapture = new window.ImageCapture(this.track);
        if (typeof this.imageCapture.getPhotoCapabilities === 'function') {
          this.imageCapture
            .getPhotoCapabilities()
            .then((caps) => {
              this.photoCapabilities = caps;
              if (typeof this.onStreamInfo === 'function') {
                this.onStreamInfo(this.getStreamInfo());
              }
            })
            .catch(() => {
              this.photoCapabilities = null;
            });
        }
      } catch {
        this.imageCapture = null;
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

    return {
      videoWidth,
      videoHeight,
      frameRate: settings.frameRate ? Math.round(settings.frameRate) : null,
      facingMode: actualFacing,
      startupTimeMs: this.startupTimeMs,
      supportsHardwareZoom: Boolean(maxHardwareZoom && maxHardwareZoom > 1),
      maxZoom: Math.max(5.0, maxHardwareZoom || 5.0),
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
    return this.start({ facingMode: nextFacing });
  }

  async setZoom(requestedZoom) {
    const maxTotal = Math.max(5.0, this.capabilities?.zoom?.max || 5.0);
    const result = splitZoom(requestedZoom, this.capabilities?.zoom || null, maxTotal);
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
        // Fallback smoothly to software zoom if driver rejects constraint
        this.hardwareZoom = 1.0;
        this.softwareZoom = result.totalZoom;
        return {
          ...result,
          hardwareSupported: false,
          hardwareZoom: 1.0,
          softwareZoom: result.totalZoom,
        };
      }
    }

    return result;
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

  /**
   * Capture a single high-resolution frame.
   * On Android Chrome: prioritize ImageCapture.takePhoto() for sensor max resolution.
   * On iOS Safari (and fallback): extract directly from the active <video> stream.
   */
  async captureSingleFrame({ preferTakePhoto = this.platform.preferTakePhoto } = {}) {
    if (
      preferTakePhoto &&
      this.imageCapture &&
      typeof this.imageCapture.takePhoto === 'function'
    ) {
      try {
        const photoSettings = {};
        if (this.photoCapabilities?.imageWidth?.max) {
          photoSettings.imageWidth = this.photoCapabilities.imageWidth.max;
        }
        if (this.photoCapabilities?.imageHeight?.max) {
          photoSettings.imageHeight = this.photoCapabilities.imageHeight.max;
        }
        const blob = await this.imageCapture.takePhoto(
          Object.keys(photoSettings).length > 0 ? photoSettings : undefined
        );
        const bitmap = await createImageBitmap(blob);
        return {
          sourceType: 'takePhoto',
          bitmap,
          width: bitmap.width,
          height: bitmap.height,
        };
      } catch {
        // Fall back to grabFrame / video stream cleanly
      }
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

  stop() {
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
    if (this.video) {
      this.video.srcObject = null;
    }
  }
}
