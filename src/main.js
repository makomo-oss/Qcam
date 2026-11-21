import { APP_VERSION, detectPlatform } from './utils/platform.js';
import { CameraController } from './camera/camera-controller.js';
import { ImagePipeline } from './processing/image-pipeline.js';
import { buildPhotoFilename, shareOrSavePhoto, triggerAnchorDownload } from './storage/media-saver.js';
import { CameraUI } from './ui/camera-ui.js';
import {
  formatMegapixelsLabel,
  getAvailableMegapixelOptions,
  getAvailableResolutionOptions,
  normalizeMegapixelsSetting,
  normalizeResolutionPreset,
  selectHqCapturePlan,
} from './utils/resolution.js';
import {
  COLOR_PROFILES,
  STABILIZATION_MODES,
  normalizeColorProfile,
  normalizeStabilizationMode,
} from './processing/frame-aligner.js';

const MAX_SESSION_PHOTOS = 30;
const TIMER_CYCLE = [0, 3, 10];
const SETTINGS_STORAGE_KEY = 'qcam_settings_v1';

function readJsonStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage errors in private mode
  }
}

class QcamApp {
  constructor() {
    this.platform = detectPlatform(window);
    const saved = readJsonStorage(SETTINGS_STORAGE_KEY) || {};
    const autoSave =
      saved.autoSaveExplicit === true
        ? Boolean(saved.autoSave)
        : typeof saved.autoSave === 'boolean' && !this.platform.isIOS
        ? saved.autoSave
        : true;
    this.settings = {
      aspectRatio: saved.aspectRatio === '16:9' ? '16:9' : '4:3',
      gridVisible: Boolean(saved.gridVisible),
      timerSeconds: 0,
      mode: 'hq',
      colorProfile: normalizeColorProfile(saved.colorProfile || COLOR_PROFILES.NATURAL),
      stabilization: normalizeStabilizationMode(saved.stabilization),
      cameraResolution: normalizeResolutionPreset(saved.cameraResolution),
      outputMegapixels: normalizeMegapixelsSetting(saved.outputMegapixels),
      outputFormat: saved.outputFormat === 'jpeg' ? 'jpeg' : 'avif',
      autoSave,
      autoSaveExplicit: Boolean(saved.autoSaveExplicit),
      mirrorFrontSave: Boolean(saved.mirrorFrontSave),
      facingMode: saved.facingMode === 'user' ? 'user' : 'environment',
    };

    this.photos = [];
    this.currentGalleryIndex = 0;
    this.isCapturing = false;
    this._bgQueue = [];
    this._isDrainingQueue = false;
    this.pendingProcessCount = 0;
    this.maxPendingJobs = this.platform.isIOS ? 2 : 4;
    this.isSwitchingCamera = false;
    this.countdownTimerId = null;
    this.countdownRemaining = 0;
    this.streamInfo = null;
    this.lastProcessEngine = '--';
    this.lastCaptureSource = null;
    this.lastCaptureTimeMs = null;
    this.lastStabilizationInfo = null;
    this.lastSavedInfo = null;
    this.lastPermissionState = 'unknown';
    this._swRegistration = null;

    this.ui = new CameraUI({
      onSelectStabilization: (mode) => this.selectStabilizationMode(mode),
      onSelectColorProfile: (profile) => this.selectColorProfile(profile),
      onToggleAspect: () => this.toggleAspectRatio(),
      onToggleGrid: () => this.toggleGrid(),
      onCycleTimer: () => this.cycleTimer(),
      onRetryCamera: () => this.startCamera(),
      onShutterClick: () => this.handleShutter(),
      onSwitchCamera: () => this.switchCamera(),
      onZoomChange: (zoom) => this.applyZoom(zoom),
      onTapFocus: (normPoint) => this.applyFocus(normPoint),
      onExposureChange: (ev) => this.applyExposure(ev),
      onOpenGallery: () => this.openGallery(),
      onSelectGalleryIndex: (idx) => this.selectGalleryIndex(idx),
      onDeleteCurrentPhoto: () => this.deleteCurrentPhoto(),
      onSaveCurrentPhoto: (preferShare) => this.saveCurrentPhoto(preferShare),
      onSettingChange: (key, val) => this.updateSetting(key, val),
      onSelectResolution: (presetId) => this.selectResolutionPreset(presetId),
      onSelectMegapixels: (mpValue) => this.selectMegapixels(mpValue),
      onSelectBackLens: (deviceId) => this.selectBackLens(deviceId),
      onRefreshDiagnostics: () => this.refreshDiagnostics(),
      onOpenPermissionGuide: () => this.ui.openInfoModal({ scrollToPermissionGuide: true }),
    });

    this.camera = new CameraController(this.ui.els.video, this.platform);
    this.camera.facingMode = this.settings.facingMode;
    this.camera.resolutionPreset = this.settings.cameraResolution;
    this.camera.aspectRatio = this.settings.aspectRatio;
    this.camera.onStreamInfo = (info) => {
      this.streamInfo = info;
      this.ui.updateLensControls(info);
      this._refreshQualityControls();
      this._syncPreviewTransform();
    };

    this.pipeline = new ImagePipeline(this.platform);
    this.pipeline.onCapabilitiesChange = () => this._refreshQualityControls();
  }

  _persistSettings() {
    writeJsonStorage(SETTINGS_STORAGE_KEY, {
      aspectRatio: this.settings.aspectRatio,
      gridVisible: this.settings.gridVisible,
      mode: 'hq',
      colorProfile: this.settings.colorProfile,
      stabilization: this.settings.stabilization,
      cameraResolution: this.settings.cameraResolution,
      outputMegapixels: this.settings.outputMegapixels,
      outputFormat: this.settings.outputFormat,
      autoSave: this.settings.autoSave,
      autoSaveExplicit: Boolean(this.settings.autoSaveExplicit),
      mirrorFrontSave: this.settings.mirrorFrontSave,
      facingMode: this.settings.facingMode,
    });
  }

  _computeQualityData() {
    const info = this.streamInfo || {};
    const caps = this.pipeline.getCapabilities();
    const resolutionData = getAvailableResolutionOptions({
      trackCapabilities: info.trackCapabilities || {},
      streamWidth: info.videoWidth || 0,
      streamHeight: info.videoHeight || 0,
      aspectRatio: this.settings.aspectRatio,
      currentPreset: this.settings.cameraResolution,
    });
    const megapixelData = getAvailableMegapixelOptions({
      trackCapabilities: info.trackCapabilities || {},
      photoMaxWidth: info.photoMaxWidth || null,
      photoMaxHeight: info.photoMaxHeight || null,
      streamWidth: info.videoWidth || 0,
      streamHeight: info.videoHeight || 0,
      preferTakePhoto: Boolean(this.platform.preferTakePhoto && info.supportsTakePhoto),
      aspectRatio: this.settings.aspectRatio,
      outputFormat: this.settings.outputFormat,
      maxTextureSize: caps.maxTextureSize,
      supportsNativeAvif: caps.supportsNativeAvif,
      currentSelection: this.settings.outputMegapixels,
    });
    return { resolutionData, megapixelData, isIOS: Boolean(this.platform.isIOS) };
  }

  _refreshQualityControls() {
    const data = this._computeQualityData();
    this.ui.renderQualityControls(data);
    return data;
  }

  async init() {
    document.documentElement.dataset.os = this.platform.isIOS
      ? 'ios'
      : this.platform.isAndroid
      ? 'android'
      : 'desktop';
    document.documentElement.dataset.pwa = String(this.platform.isStandalonePWA);

    this.ui.setAspectRatio(this.settings.aspectRatio);
    this.ui.setGridVisible(this.settings.gridVisible);
    this.ui.setTimerSeconds(this.settings.timerSeconds);
    this.ui.setColorProfile(this.settings.colorProfile);
    this.ui.setStabilizationMode(this.settings.stabilization);
    this.ui.setOutputFormat(this.settings.outputFormat);
    this.ui.els.toggleAutoSave.checked = this.settings.autoSave;
    this.ui.els.toggleMirrorFront.checked = this.settings.mirrorFrontSave;
    this.ui.renderPermissionGuide(this.platform);
    this._refreshQualityControls();

    // Warm up Worker WebGL shaders and AVIF WASM encoder in parallel with camera startup
    this.pipeline.warmup();
    await this.startCamera();
    this._registerServiceWorker();
    this._setupLifecycleHandlers();
  }

  async startCamera() {
    this.ui.hideCameraOverlay();

    const permBefore = await this.camera.checkPermissionState();
    this.lastPermissionState = permBefore.state;

    if (permBefore.state === 'denied') {
      this.ui.showCameraOverlay(
        'カメラの使用が許可されていません',
        'ブラウザまたは端末のサイト設定からカメラへのアクセスを「許可」に変更し、「カメラを起動」を押してください。',
        { showRetry: true, showHelp: true }
      );
      return;
    }

    try {
      const info = await this.camera.start({
        facingMode: this.settings.facingMode,
        resolutionPreset: this.settings.cameraResolution,
        aspectRatio: this.settings.aspectRatio,
      });
      this.streamInfo = info;
      this.ui.updateLensControls(info);
      this._refreshQualityControls();
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();

      const permAfter = await this.camera.checkPermissionState();
      this.lastPermissionState = permAfter.state !== 'unknown' ? permAfter.state : 'granted';
    } catch (err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        this.lastPermissionState = 'denied';
        this.ui.showCameraOverlay(
          'カメラの使用が許可されていません',
          'ブラウザまたは端末の設定からこのサイトのカメラアクセスを許可して「カメラを起動」を押してください。',
          { showRetry: true, showHelp: true }
        );
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        this.ui.showCameraOverlay(
          '利用可能なカメラが見つかりません',
          '端末にカメラが接続されているか確認してください。'
        );
      } else {
        this.ui.showCameraOverlay(
          'カメラを起動できませんでした',
          err?.message || '他のアプリがカメラを使用中の可能性があります。'
        );
      }
    }
  }

  async switchCamera() {
    if (this.isCapturing || this.countdownRemaining > 0 || this.isSwitchingCamera) return;
    this.isSwitchingCamera = true;
    this.ui.animateSwitchCamera();
    try {
      const info = await this.camera.switchCamera();
      this.settings.facingMode = this.camera.facingMode;
      this._persistSettings();
      this.streamInfo = info;
      this.ui.updateLensControls(info);
      this._refreshQualityControls();
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();
    } catch {
      this.ui.showToast('カメラの切り替えに失敗しました');
    } finally {
      this.isSwitchingCamera = false;
    }
  }

  async selectBackLens(deviceId) {
    if (this.isCapturing || this.countdownRemaining > 0 || this.isSwitchingCamera) return;
    this.isSwitchingCamera = true;
    try {
      const info = await this.camera.selectBackLens(deviceId);
      this.streamInfo = info;
      this.ui.updateLensControls(info);
      this._refreshQualityControls();
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();
    } catch {
      const refreshed = this.camera.getStreamInfo();
      this.streamInfo = refreshed;
      this.ui.updateLensControls(refreshed);
      this._refreshQualityControls();
      this._syncPreviewTransform();
      this.ui.showToast('このレンズはブラウザから開けませんでした');
    } finally {
      this.isSwitchingCamera = false;
    }
  }

  async selectResolutionPreset(presetId) {
    if (this.isCapturing || this.countdownRemaining > 0 || this.isSwitchingCamera) return;
    const next = normalizeResolutionPreset(presetId);
    this.settings.cameraResolution = next;
    this._persistSettings();
    this._refreshQualityControls();

    this.isSwitchingCamera = true;
    try {
      const info = await this.camera.setResolutionPreset(next, {
        aspectRatio: this.settings.aspectRatio,
        allowReacquire: true,
      });
      this.streamInfo = info;
      this.ui.updateLensControls(info);
      this._syncPreviewTransform();
      this._refreshQualityControls();
    } catch {
      this.ui.showToast('解像度の変更に失敗しました');
    } finally {
      this.isSwitchingCamera = false;
    }
  }

  selectMegapixels(mpValue) {
    const next = normalizeMegapixelsSetting(mpValue);
    this.settings.outputMegapixels = next;
    this._persistSettings();
    this._refreshQualityControls();
  }

  toggleAspectRatio() {
    const next = this.settings.aspectRatio === '4:3' ? '16:9' : '4:3';
    this.settings.aspectRatio = next;
    this._persistSettings();
    this.ui.setAspectRatio(next);
    if (this.camera.track && this.camera.track.readyState === 'live') {
      this.camera
        .setResolutionPreset(this.settings.cameraResolution, {
          aspectRatio: next,
          allowReacquire: false,
        })
        .then((info) => {
          this.streamInfo = info;
          this._refreshQualityControls();
        })
        .catch(() => {});
    } else {
      this._refreshQualityControls();
    }
  }

  toggleGrid() {
    this.settings.gridVisible = !this.settings.gridVisible;
    this._persistSettings();
    this.ui.setGridVisible(this.settings.gridVisible);
  }

  cycleTimer() {
    const idx = TIMER_CYCLE.indexOf(this.settings.timerSeconds);
    const next = TIMER_CYCLE[(idx + 1) % TIMER_CYCLE.length];
    this.settings.timerSeconds = next;
    this.ui.setTimerSeconds(next);
  }

  selectStabilizationMode(mode) {
    const next = normalizeStabilizationMode(mode);
    this.settings.stabilization = next;
    this._persistSettings();
    this.ui.setStabilizationMode(next);
  }

  selectColorProfile(profile) {
    const next = normalizeColorProfile(profile);
    this.settings.colorProfile = next;
    this._persistSettings();
    this.ui.setColorProfile(next);
  }

  async applyZoom(zoom) {
    try {
      const res = await this.camera.setZoom(zoom);
      this._syncPreviewTransform(res);
    } catch {
      const refreshed = this.camera.getStreamInfo();
      this.streamInfo = refreshed;
      this.ui.updateLensControls(refreshed);
      this._syncPreviewTransform();
      this.ui.showToast('超広角レンズへの切り替えに失敗しました');
    }
  }

  async applyFocus(normPoint) {
    await this.camera.focusAt(normPoint.x, normPoint.y);
  }

  async applyExposure(ev) {
    const res = await this.camera.setExposureCompensation(ev);
    this._syncPreviewTransform(null, res.softwareEv);
  }

  _syncPreviewTransform(zoomRes = null, softwareEv = null) {
    const isFront = this.camera.facingMode === 'user';
    const swZoom = zoomRes ? zoomRes.softwareZoom : this.camera.softwareZoom;
    const totZoom = zoomRes ? zoomRes.totalZoom : this.camera.targetZoom;
    const maxZoom = this.streamInfo?.maxZoom || 5.0;
    const ev =
      softwareEv !== null
        ? softwareEv
        : this.streamInfo?.supportsHardwareExposure
        ? 0
        : this.camera.exposureCompensation;

    this.ui.setVideoTransform({
      mirroredPreview: isFront,
      softwareZoom: swZoom,
      totalZoom: totZoom,
      maxZoom,
      softwareEv: ev,
    });
  }

  _isShutterLocked() {
    return this.isCapturing || this.pendingProcessCount >= this.maxPendingJobs;
  }

  _syncShutterState() {
    this.ui.setCapturing(this._isShutterLocked());
    this.ui.setProcessingCount(this.pendingProcessCount);
  }

  _dedupeFilename(baseFilename) {
    if (!this.photos.some((p) => p.filename === baseFilename)) {
      return baseFilename;
    }
    const hdrIdx = baseFilename.lastIndexOf('_HDR.');
    const dotIdx = baseFilename.lastIndexOf('.');
    const splitIdx = hdrIdx > 0 ? hdrIdx : dotIdx > 0 ? dotIdx : baseFilename.length;
    const prefix = baseFilename.slice(0, splitIdx);
    const suffix = baseFilename.slice(splitIdx);
    let seq = 2;
    let candidate = `${prefix}-${seq}${suffix}`;
    while (this.photos.some((p) => p.filename === candidate)) {
      seq += 1;
      candidate = `${prefix}-${seq}${suffix}`;
    }
    return candidate;
  }

  _releaseQueuedJobs() {
    while (this._bgQueue.length > 0) {
      const job = this._bgQueue.shift();
      for (const frame of job?.frames || []) {
        try {
          frame?.close?.();
        } catch {
          // ignore
        }
      }
      this.pendingProcessCount = Math.max(0, this.pendingProcessCount - 1);
    }
    this._syncShutterState();
  }

  handleShutter() {
    if (this.isCapturing) return;

    // Cancel active countdown if shutter clicked again
    if (this.countdownRemaining > 0) {
      this._cancelCountdown();
      return;
    }

    if (this.pendingProcessCount >= this.maxPendingJobs) {
      this.ui.showToast('前の写真を保存中です · まもなく撮影できます', { durationMs: 1400 });
      return;
    }

    if (this.settings.timerSeconds > 0) {
      this._startCountdown(this.settings.timerSeconds);
      return;
    }

    this._captureNow({ fromTimer: false });
  }

  _startCountdown(seconds) {
    this.countdownRemaining = seconds;
    this.ui.setCountdown(this.countdownRemaining);

    this.countdownTimerId = setInterval(() => {
      this.countdownRemaining -= 1;
      if (this.countdownRemaining <= 0) {
        clearInterval(this.countdownTimerId);
        this.countdownTimerId = null;
        this.ui.setCountdown(0);
        this._captureNow({ fromTimer: true });
      } else {
        this.ui.setCountdown(this.countdownRemaining);
      }
    }, 1000);
  }

  _cancelCountdown() {
    clearInterval(this.countdownTimerId);
    this.countdownTimerId = null;
    this.countdownRemaining = 0;
    this.ui.setCountdown(0);
  }

  async _captureNow({ fromTimer = false } = {}) {
    if (this.isCapturing || this.pendingProcessCount >= this.maxPendingJobs) return;
    if (!this.camera.stream) {
      this.ui.showToast('カメラが準備できていません');
      return;
    }

    this.isCapturing = true;
    this.ui.setCapturing(true);
    this.ui.triggerSilentBlackout();

    const capturedAt = new Date();
    const totalStart = performance.now();
    const mode = 'hq';
    const format = this.settings.outputFormat === 'jpeg' ? 'jpeg' : 'avif';
    const aspectRatio = this.settings.aspectRatio;
    const softwareZoom = this.camera.softwareZoom;
    const outputMegapixels = this.settings.outputMegapixels;
    const colorProfile = this.settings.colorProfile;
    const isFront = this.camera.facingMode === 'user';
    const mirrorOutput = isFront && this.settings.mirrorFrontSave;
    const softwareEv = this.streamInfo?.supportsHardwareExposure
      ? 0
      : this.camera.exposureCompensation;
    const stabilizationMode = normalizeStabilizationMode(this.settings.stabilization);

    let queuedJob = null;
    try {
      const caps = this.pipeline.getCapabilities();
      const info = this.streamInfo || this.camera.getStreamInfo();
      const plan = selectHqCapturePlan({
        preferTakePhoto: this.platform.preferTakePhoto,
        hasImageCapture: Boolean(
          this.camera.imageCapture && typeof this.camera.imageCapture.takePhoto === 'function'
        ),
        streamWidth: info?.videoWidth || this.camera.video.videoWidth || 0,
        streamHeight: info?.videoHeight || this.camera.video.videoHeight || 0,
        photoMaxWidth: info?.photoMaxWidth || null,
        photoMaxHeight: info?.photoMaxHeight || null,
        aspectRatio,
        softwareZoom,
        outputMegapixels,
        outputFormat: format,
        maxTextureSize: caps.maxTextureSize,
        supportsNativeAvif: caps.supportsNativeAvif,
      });

      let frames = [];
      let captureSource = 'burstStream';
      if (plan.captureMethod === 'takePhoto') {
        const still = await this.camera.tryCaptureTakePhoto();
        if (still?.bitmap) {
          frames = [still.bitmap];
          captureSource = 'takePhoto';
        }
      }
      if (!frames.length) {
        const burst = await this.camera.captureBurstFrames(4, 220, { stabilizationMode });
        frames = burst.frames;
        captureSource = burst.sourceType;
      }

      this.lastCaptureSource = captureSource;
      queuedJob = {
        mode,
        frames,
        aspectRatio,
        softwareZoom,
        mirrorX: mirrorOutput,
        exposureEv: softwareEv,
        outputFormat: format,
        outputMegapixels,
        maxDimension: plan.maxDimension,
        stabilizationMode,
        colorProfile,
        fromTimer,
        capturedAt,
        totalStart,
        captureSource,
      };
      this._bgQueue.push(queuedJob);
      this.pendingProcessCount += 1;
    } catch (err) {
      this.ui.showToast(`撮影エラー: ${err?.message || '再試行してください'}`);
    } finally {
      // Unlock shutter immediately after frame acquisition so continuous shooting never waits on encode
      this.isCapturing = false;
      this._syncShutterState();
    }

    if (queuedJob) {
      this._drainProcessingQueue();
    }
  }

  async _drainProcessingQueue() {
    if (this._isDrainingQueue) return;
    this._isDrainingQueue = true;
    try {
      while (this._bgQueue.length > 0) {
        const job = this._bgQueue.shift();
        try {
          await this._processQueuedJob(job);
        } catch (err) {
          for (const frame of job?.frames || []) {
            try {
              frame?.close?.();
            } catch {
              // ignore
            }
          }
          this.ui.showToast(`撮影エラー: ${err?.message || '再試行してください'}`);
        } finally {
          this.pendingProcessCount = Math.max(0, this.pendingProcessCount - 1);
          this._syncShutterState();
        }
      }
    } finally {
      this._isDrainingQueue = false;
      if (this._bgQueue.length > 0) {
        this._drainProcessingQueue();
      }
    }
  }

  async _processQueuedJob(job) {
    const processed = await this.pipeline.process({
      mode: job.mode,
      frames: job.frames,
      aspectRatio: job.aspectRatio,
      softwareZoom: job.softwareZoom,
      mirrorX: job.mirrorX,
      exposureEv: job.exposureEv,
      outputFormat: job.outputFormat,
      outputMegapixels: job.outputMegapixels,
      maxDimension: job.maxDimension,
      stabilizationMode: job.stabilizationMode,
      colorProfile: job.colorProfile,
    });

    const totalTimeMs = Math.round(performance.now() - job.totalStart);
    this.lastProcessEngine = processed.engine;
    this.lastCaptureTimeMs = totalTimeMs;
    this.lastStabilizationInfo = processed.stabilizationInfo || null;
    this.lastCaptureSource = job.captureSource;

    const actualFormat = processed.format || job.outputFormat;
    const mimeType =
      processed.mimeType || (actualFormat === 'jpeg' ? 'image/jpeg' : 'image/avif');
    const formatLabel = actualFormat.toUpperCase();
    const filename = this._dedupeFilename(
      buildPhotoFilename(job.capturedAt || new Date(), job.mode, actualFormat)
    );
    const url = URL.createObjectURL(processed.blob);
    const photo = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      blob: processed.blob,
      url,
      filename,
      format: actualFormat,
      mimeType,
      width: processed.width,
      height: processed.height,
      mode: job.mode,
      engine: processed.engine,
      processTimeMs: processed.processTimeMs,
      totalTimeMs,
    };

    this.lastSavedInfo = {
      filename,
      mimeType,
      format: actualFormat,
      sizeBytes: processed.blob.size,
      method: 'pending',
    };

    this._addSessionPhoto(photo);

    // Invoke save/share immediately (synchronously up to first await) without blocking the next queued job
    void this._handleAutoSaveAfterProcess(photo, {
      fromTimer: job.fromTimer,
      totalTimeMs,
      actualFormat,
      formatLabel,
      isRapidFire: this.isCapturing || this._bgQueue.length > 0,
    });
  }

  async _handleAutoSaveAfterProcess(
    photo,
    { fromTimer = false, totalTimeMs = 0, actualFormat = 'avif', formatLabel = 'AVIF', isRapidFire = false }
  ) {
    if (this.platform.isIOS) {
      if (isRapidFire) {
        this.ui.showToast(
          actualFormat === 'avif'
            ? `AVIF 完了 (${totalTimeMs}ms) · タップで保存`
            : `${formatLabel} 完了 (${totalTimeMs}ms) · タップで保存`,
          {
            durationMs: 4200,
            onClick: () => this._invokeIOSShareOrModal(photo),
          }
        );
        return;
      }

      if (this.settings.autoSave && !fromTimer) {
        if (actualFormat === 'avif') {
          this.ui.showToast(
            'AVIF (.avif) 完了 · .avif 維持は「“ファイル”に保存」（「画像を保存」は JPEG 変換）',
            { durationMs: 4200 }
          );
        }
        // Attempt direct Web Share Sheet while shutter tap's transient user activation is still active.
        const shareRes = await shareOrSavePhoto(photo, this.platform, { preferShare: true });
        if (shareRes.method === 'web-share' && shareRes.completed) {
          if (this.lastSavedInfo && this.lastSavedInfo.filename === photo.filename) {
            this.lastSavedInfo.method = 'web-share';
          }
          if (actualFormat === 'avif') {
            this.ui.showToast(
              `AVIF (${totalTimeMs}ms) · 「“ファイル”に保存」で .avif 維持（写真アプリは JPEG 変換）`,
              { durationMs: 4200 }
            );
          } else {
            this.ui.showToast(`共有 /「写真」へ保存しました (${formatLabel} · ${totalTimeMs}ms)`, {
              durationMs: 2800,
            });
          }
        } else if (shareRes.cancelled) {
          if (this.lastSavedInfo && this.lastSavedInfo.filename === photo.filename) {
            this.lastSavedInfo.method = 'share-cancelled';
          }
          this.ui.showToast(
            actualFormat === 'avif'
              ? `AVIF 撮影完了 (${totalTimeMs}ms) · タップで「ファイル保存 / 直接DL」`
              : `${formatLabel} 撮影完了 (${totalTimeMs}ms) · タップで「写真」へ保存`,
            {
              durationMs: 5500,
              onClick: () => this._invokeIOSShareOrModal(photo),
            }
          );
        } else if (!shareRes.busy) {
          if (this.lastSavedInfo && this.lastSavedInfo.filename === photo.filename) {
            this.lastSavedInfo.method = shareRes.reason || shareRes.method;
          }
          // If user already started another shot while waiting on share rejection, avoid interrupting viewfinder
          if (this.isCapturing || this._bgQueue.length > 0) {
            this.ui.showToast(
              actualFormat === 'avif'
                ? `AVIF 撮影完了 (${totalTimeMs}ms) · タップで「ファイルに保存 / プレビュー」`
                : `${formatLabel} 撮影完了 (${totalTimeMs}ms) · タップで「写真」へ保存`,
              {
                durationMs: 5000,
                onClick: () => this._invokeIOSShareOrModal(photo),
              }
            );
            return;
          }
          // If transient user activation expired (e.g., slow HQ burst / encode) or Share Sheet unavailable,
          // open the Preview Modal so 1-tap Share Sheet or Safari direct download works immediately.
          const idx = this.photos.findIndex((p) => p.id === photo.id);
          this.currentGalleryIndex = idx >= 0 ? idx : 0;
          this.ui.openPreviewModal(this.photos, this.currentGalleryIndex, this.platform);
          if (actualFormat === 'avif') {
            this.ui.showToast(
              shareRes.gestureExpired
                ? '下の「共有で保存 (.avif)」→「“ファイル”に保存」で .avif 維持（長押しは JPEG 変換）'
                : '下のボタンで共有→「“ファイル”に保存」すると .avif のまま保存できます',
              { durationMs: 5500 }
            );
          } else {
            this.ui.showToast(
              shareRes.gestureExpired
                ? '下のボタンで「画像を保存」または写真を長押ししてください'
                : '写真を長押しして「“写真”に保存」を選択してください',
              { durationMs: 5000 }
            );
          }
        }
      } else if (this.settings.autoSave && fromTimer) {
        // Countdown timer runs after activation expires; open Preview Modal with 1-tap save CTA.
        this.ui.openPreviewModal(this.photos, this.currentGalleryIndex, this.platform);
        this.ui.showToast(
          actualFormat === 'avif'
            ? 'タイマー撮影完了 · 下のボタンから .avif 保存できます（写真保存は JPEG 変換）'
            : 'タイマー撮影完了 · 下のボタンから「写真」へ保存できます',
          { durationMs: 4800 }
        );
      } else {
        this.ui.showToast(
          actualFormat === 'avif'
            ? `AVIF 撮影完了 (${totalTimeMs}ms) · タップで「ファイルに保存 / プレビュー」`
            : `${formatLabel} 撮影完了 (${totalTimeMs}ms) · タップで「写真」へ保存`,
          {
            durationMs: 5500,
            onClick: () => this._invokeIOSShareOrModal(photo),
          }
        );
      }
    } else if (this.settings.autoSave) {
      triggerAnchorDownload(photo.url, photo.filename);
      if (this.lastSavedInfo && this.lastSavedInfo.filename === photo.filename) {
        this.lastSavedInfo.method = 'auto-download';
      }
      this.ui.showToast(`${formatLabel} を保存しました`, {
        durationMs: 1800,
      });
    }
  }

  async _invokeIOSShareOrModal(photo) {
    const isAvif = photo.format !== 'jpeg' && photo.mimeType !== 'image/jpeg';
    const res = await shareOrSavePhoto(photo, this.platform, { preferShare: true });
    if (res.method === 'web-share' && res.completed) {
      if (this.lastSavedInfo && this.lastSavedInfo.filename === photo.filename) {
        this.lastSavedInfo.method = 'web-share';
      }
      this.ui.showToast(
        isAvif
          ? 'AVIF 共有シート完了 · 「“ファイル”に保存」で .avif 維持（写真アプリは JPEG 変換）'
          : '共有 /「写真」へ保存しました'
      );
    } else if (!res.completed && !res.cancelled && !res.busy) {
      const idx = this.photos.findIndex((p) => p.id === photo.id);
      this.currentGalleryIndex = idx >= 0 ? idx : 0;
      this.ui.openPreviewModal(this.photos, this.currentGalleryIndex, this.platform);
    }
  }

  _addSessionPhoto(photo) {
    this.photos.unshift(photo);
    if (this.photos.length > MAX_SESSION_PHOTOS) {
      const removed = this.photos.pop();
      if (removed) URL.revokeObjectURL(removed.url);
    }
    this.currentGalleryIndex = 0;
    this.ui.updateThumbnail(this.photos[0], this.photos.length);
  }

  openGallery() {
    if (!this.photos.length) return;
    this.currentGalleryIndex = 0;
    this.ui.openPreviewModal(this.photos, this.currentGalleryIndex, this.platform);
  }

  selectGalleryIndex(idx) {
    if (idx < 0 || idx >= this.photos.length) return;
    this.currentGalleryIndex = idx;
    this.ui.openPreviewModal(this.photos, this.currentGalleryIndex, this.platform);
  }

  deleteCurrentPhoto() {
    const removed = this.photos.splice(this.currentGalleryIndex, 1)[0];
    if (removed) {
      URL.revokeObjectURL(removed.url);
    }
    if (!this.photos.length) {
      this.ui.closePreviewModal();
      this.ui.updateThumbnail(null, 0);
      return;
    }
    this.currentGalleryIndex = Math.min(this.currentGalleryIndex, this.photos.length - 1);
    this.ui.updateThumbnail(this.photos[0], this.photos.length);
    this.ui.openPreviewModal(this.photos, this.currentGalleryIndex, this.platform);
  }

  async saveCurrentPhoto(action = 'auto') {
    const photo = this.photos[this.currentGalleryIndex];
    if (!photo) return;
    const isAvif = photo.format !== 'jpeg' && photo.mimeType !== 'image/jpeg';
    const forceDownload = action === 'download' && this.platform.isIOS;
    const preferShare =
      action === 'share' || action === true || (action === 'auto' && this.platform.isIOS);

    const res = await shareOrSavePhoto(photo, this.platform, {
      preferShare,
      forceDownload,
    });
    if (this.lastSavedInfo && this.lastSavedInfo.filename === photo.filename) {
      this.lastSavedInfo.method = res.completed
        ? res.method
        : res.cancelled
        ? 'share-cancelled'
        : res.reason || res.method;
    }

    if (res.method === 'download' && res.completed) {
      this.ui.showToast(
        this.platform.isIOS
          ? `${photo.filename} のダウンロードを開始しました（「ファイル」アプリへ保存）`
          : '端末に保存しました'
      );
    } else if (res.method === 'web-share' && res.completed) {
      this.ui.showToast(
        this.platform.isIOS && isAvif
          ? 'AVIF 共有シート完了 · 「“ファイル”に保存」で .avif 維持（写真アプリは JPEG 変換）'
          : '共有 /「写真」へ保存しました'
      );
    } else if (res.method === 'ios-manual-hint') {
      if (isAvif && !this.platform.isStandalonePWA && this.platform.isSafari) {
        this.ui.showToast('「直接DL (.avif)」ボタンで .avif のまま保存できます');
      } else if (isAvif) {
        this.ui.showToast('長押し保存では iOS 仕様により JPEG に変換されます');
      } else {
        this.ui.showToast('プレビュー画像を長押しして「“写真”に保存」を選択してください');
      }
    }
  }

  updateSetting(key, val) {
    if (key === 'outputFormat') {
      const normalized = val === 'jpeg' ? 'jpeg' : 'avif';
      this.settings.outputFormat = normalized;
      this.ui.setOutputFormat(normalized);
      this._refreshQualityControls();
    } else {
      this.settings[key] = val;
    }
    if (key === 'autoSave') {
      this.settings.autoSaveExplicit = true;
    }
    this._persistSettings();
  }

  refreshDiagnostics() {
    const info = this.streamInfo || {};
    const { resolutionData, megapixelData } = this._refreshQualityControls();

    const permLabelMap = {
      granted: '許可済み（持続）',
      prompt: '都度確認（ブラウザ設定依存）',
      denied: '拒否',
      unknown: '取得中 / ブラウザ非公開',
    };
    const ultraWideLabel =
      this.camera.facingMode === 'user'
        ? 'アウトカメラ時のみ対応'
        : info.supportsUltraWide
        ? info.ultraWideMethod === 'hardware-zoom'
          ? `対応 (光学ズーム倍率制御 · 下限 ${(info.ultraWideZoom || 0.5).toFixed(1)}×)`
          : `対応 (超広角レンズ自動切替 · 検出レンズ ${info.backLenses?.length || 1} 個)`
        : '非対応（端末 / ブラウザが超広角レンズを未公開）';

    const saveFlowLabel = this.platform.preferWebShareSave
      ? this.settings.outputFormat === 'jpeg'
        ? 'Web Share API (「画像を保存」で写真アプリ)'
        : 'Web Share API (「“ファイル”に保存」で .avif / 写真アプリ保存時は JPEG 変換)'
      : '<a download> 直接保存';

    const lastFileLabel = this.lastSavedInfo
      ? `${this.lastSavedInfo.filename} (${this.lastSavedInfo.mimeType} · ${Math.max(1, Math.round(this.lastSavedInfo.sizeBytes / 1024))}KB)`
      : '未撮影';

    const selectedResOpt = resolutionData.options.find(
      (o) => o.id === resolutionData.effectiveSelected
    );
    const resPresetLabel = selectedResOpt
      ? selectedResOpt.label
      : resolutionData.effectiveSelected;
    const capLabel =
      resolutionData.capWidth && resolutionData.capHeight
        ? `${resolutionData.capWidth}×${resolutionData.capHeight}`
        : '未取得';
    const mpBaseLabel =
      megapixelData.plannedOutWidth && megapixelData.plannedOutHeight
        ? `${megapixelData.plannedOutWidth}×${megapixelData.plannedOutHeight} (${formatMegapixelsLabel(megapixelData.plannedOutMp)})`
        : '未取得';
    const mpLabel =
      megapixelData.isAspectCropped && megapixelData.uncropped43Mp
        ? `${mpBaseLabel} · 16:9切抜（4:3で最大 ${formatMegapixelsLabel(megapixelData.uncropped43Mp)}）`
        : mpBaseLabel;
    const isHighStab = this.settings.stabilization === STABILIZATION_MODES.HIGH;
    const burstDesc = isHighStab
      ? '5連写ベスト選別＋位置合わせ HDR'
      : '4連写位置合わせ + 高画質 HDR';
    const captureMethodLabel =
      this.lastCaptureSource === 'takePhoto'
        ? 'ImageCapture.takePhoto() + 高画質 HDR'
        : info.supportsTakePhoto
        ? `ImageCapture.takePhoto() / ${burstDesc}`
        : this.platform.isIOS
        ? `${burstDesc}（無音仕様）`
        : burstDesc;
    const takePhotoApiLabel = this.platform.isIOS
      ? info.photoMaxWidth && info.photoMaxHeight
        ? `無音維持のため無効 (${info.photoMaxWidth}×${info.photoMaxHeight} · ストリーム最高画素を使用)`
        : '無音維持のため無効（強制シャッター音回避 / ストリーム最高画素を使用）'
      : info.photoMaxWidth && info.photoMaxHeight
      ? `${info.photoMaxWidth}×${info.photoMaxHeight}`
      : 'ストリーム解像度';

    const stabilizationModeLabel =
      this.settings.stabilization === STABILIZATION_MODES.HIGH
        ? '高品質 (強 · 5連写ベスト選別＋回転/並進＋残像ゼロ)'
        : this.settings.stabilization === STABILIZATION_MODES.STANDARD
        ? '標準 (4連写位置合わせ＋残像除去)'
        : 'オフ (位置補正なし)';
    let lastStabLabel = '未撮影';
    if (this.lastCaptureSource === 'takePhoto') {
      lastStabLabel = '単写センサー静止画 (OIS/光学基準)';
    } else if (this.lastStabilizationInfo) {
      const st = this.lastStabilizationInfo;
      lastStabLabel =
        st.mode === STABILIZATION_MODES.OFF
          ? 'OFF (位置補正なし・直接合成)'
          : `採用 ${st.adoptedFrames}/${st.totalFrames}枚 · 基準#${(st.refIndex ?? 0) + 1} · シフト補正 ${st.maxShiftPx}px / 傾き ${st.maxAngleDeg}°`;
    }

    const lookLabel =
      this.settings.colorProfile === COLOR_PROFILES.VIVID
        ? 'ビビッド'
        : this.settings.colorProfile === COLOR_PROFILES.FILM
        ? 'フィルム調'
        : 'Pro ナチュラル';

    const entries = [
      ['アプリバージョン', `v${APP_VERSION}`],
      ['プラットフォーム', `${this.platform.osLabel} (${this.platform.browserLabel})`],
      ['PWA モード', this.platform.isStandalonePWA ? 'スタンドアロン (全画面)' : 'ブラウザ表示'],
      ['カメラ権限状態', permLabelMap[this.lastPermissionState] || this.lastPermissionState],
      ['撮影画質モード', '高画質 HDR (常時有効)'],
      ['仕上がりトーン', lookLabel],
      ['手ぶれ補正モード', stabilizationModeLabel],
      ['直近のブレ補正', lastStabLabel],
      ['解像度設定 / 上限', `${resPresetLabel} / ブラウザ取得上限 ${capLabel}`],
      ['保存画素数設定', mpLabel],
      ['超広角 (0.5×) カメラ', ultraWideLabel],
      [
        'プレビュー解像度',
        info.videoWidth && info.videoHeight ? `${info.videoWidth}×${info.videoHeight}` : '未取得',
      ],
      ['静止画 API (takePhoto)', takePhotoApiLabel],
      ['カメラ起動時間', info.startupTimeMs ? `${info.startupTimeMs} ms` : '--'],
      ['基本撮影方式', captureMethodLabel],
      [
        '保存フォーマット',
        this.settings.outputFormat === 'jpeg'
          ? 'JPEG (.jpg · 品質 0.96)'
          : 'AVIF (.avif · SharpYUV 高画質圧縮)',
      ],
      ['直近の生成ファイル', lastFileLabel],
      ['画像処理エンジン', this.lastProcessEngine],
      ['直近の処理合計', this.lastCaptureTimeMs !== null ? `${this.lastCaptureTimeMs} ms` : '--'],
      [
        'ズーム方式',
        info.supportsHardwareZoom ? 'ハードウェア + デジタル併用' : 'Canvas/WebGL デジタルズーム',
      ],
      [
        'タップフォーカス',
        info.supportsPointsOfInterest || info.supportsFocusMode ? '対応' : '端末自動制御',
      ],
      ['保存フロー', saveFlowLabel],
    ];
    this.ui.renderDiagnostics(entries);
  }

  _registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloadTriggered = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloadTriggered) return;
      const reloadKey = `qcam_sw_reloaded_${APP_VERSION}`;
      try {
        if (sessionStorage.getItem(reloadKey) === '1') return;
      } catch {
        // ignore
      }

      if (!this.isCapturing && this.pendingProcessCount === 0 && this.photos.length === 0) {
        reloadTriggered = true;
        try {
          sessionStorage.setItem(reloadKey, '1');
        } catch {
          // ignore
        }
        window.location.reload();
      } else {
        this.ui.showToast(`最新版 (v${APP_VERSION}) へ更新しました · タップして再読み込み`, {
          durationMs: 6500,
          onClick: () => window.location.reload(),
        });
      }
    });

    const register = () => {
      navigator.serviceWorker
        .register('./sw.js', { updateViaCache: 'none' })
        .then((reg) => {
          this._swRegistration = reg;
        })
        .catch(() => {
          // Non-fatal in environments without SW support
        });
    };
    if (document.readyState === 'complete') {
      register();
    } else {
      window.addEventListener('load', register, { once: true });
    }
  }

  _setupLifecycleHandlers() {
    // Keep camera track alive across brief OS overlays (Share Sheet, Control Center)
    // so iOS Safari does not re-prompt camera permission unnecessarily.
    // Only restart on return if OS actually ended the backgrounded track.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._cancelCountdown();
      } else {
        this._swRegistration?.update?.().catch(() => {});
        if (this.ui.els.cameraOverlay.hidden) {
          const trackEnded =
            !this.camera.stream ||
            !this.camera.track ||
            this.camera.track.readyState === 'ended';
          if (trackEnded) {
            this.startCamera();
          }
        }
      }
    });

    // Release hardware cleanly when leaving or reloading so next page load acquires immediately
    window.addEventListener('pagehide', () => {
      this._cancelCountdown();
      this._releaseQueuedJobs();
      this.camera.stop();
    });
  }
}

const app = new QcamApp();
window.__QCAM__ = app; // Helpful for debugging & automated verification
app.init();
