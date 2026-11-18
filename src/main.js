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
  rgbaToLuma,
} from './processing/frame-aligner.js';

const MAX_SESSION_PHOTOS = 30;
const TIMER_CYCLE = [0, 3, 10];
const STABILIZATION_CYCLE = [
  STABILIZATION_MODES.HIGH,
  STABILIZATION_MODES.STANDARD,
  STABILIZATION_MODES.OFF,
];
const SETTINGS_STORAGE_KEY = 'qcam_settings_v1';
const PERM_GRANTED_KEY = 'qcam_perm_granted_once';
const PERM_HINT_DISMISSED_KEY = 'qcam_perm_hint_dismissed';

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

function readStringStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStringStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
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
    this._shakeCanvas = null;
    this._shakeCtx = null;
    this._prevLumaSample = null;
    this._shakeHighCount = 0;
    this._shakeMonitorTimer = null;
    this._lastGyroRate = 0;
    this._lastGyroTs = 0;
    this._deviceMotionListener = null;

    this.ui = new CameraUI({
      onCycleStabilization: () => this.cycleStabilization(),
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
      onDismissPermissionHint: () => this.dismissPermissionHint(),
    });

    this.camera = new CameraController(this.ui.els.video, this.platform);
    this.camera.facingMode = this.settings.facingMode;
    this.camera.resolutionPreset = this.settings.cameraResolution;
    this.camera.aspectRatio = this.settings.aspectRatio;
    this.camera.onStreamInfo = (info) => {
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
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

    await this.startCamera({ fromInit: true });
    this._startShakeMonitor();
    this._registerServiceWorker();
    this._setupLifecycleHandlers();
    setTimeout(() => this.pipeline.warmup(), 120);
  }

  async startCamera({ fromInit = false } = {}) {
    this.ui.hideCameraOverlay();

    const permBefore = await this.camera.checkPermissionState();
    this.lastPermissionState = permBefore.state;

    if (permBefore.state === 'denied') {
      this.ui.hidePermissionHintBanner();
      this.ui.showCameraOverlay(
        'カメラの使用が許可されていません',
        'ブラウザまたは端末のサイト設定からカメラへのアクセスを「許可」に変更し、「カメラを起動」を押してください。',
        { showRetry: true, showHelp: true }
      );
      return;
    }

    try {
      const hadGrantedOnce = readStringStorage(PERM_GRANTED_KEY) === '1';
      const hintDismissed = readStringStorage(PERM_HINT_DISMISSED_KEY) === '1';

      const info = await this.camera.start({
        facingMode: this.settings.facingMode,
        resolutionPreset: this.settings.cameraResolution,
        aspectRatio: this.settings.aspectRatio,
      });
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this.ui.updateLensControls(info);
      this._refreshQualityControls();
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();
      this._resetShakeState();

      writeStringStorage(PERM_GRANTED_KEY, '1');
      const permAfter = await this.camera.checkPermissionState();
      this.lastPermissionState = permAfter.state !== 'unknown' ? permAfter.state : 'granted';

      if (fromInit && permBefore.state === 'prompt' && hadGrantedOnce && !hintDismissed) {
        this.ui.showPermissionHintBanner();
      } else if (permBefore.state === 'granted') {
        this.ui.hidePermissionHintBanner();
      }
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

  dismissPermissionHint() {
    writeStringStorage(PERM_HINT_DISMISSED_KEY, '1');
    this.ui.hidePermissionHintBanner();
  }

  async switchCamera() {
    if (this.isCapturing || this.countdownRemaining > 0 || this.isSwitchingCamera) return;
    this.isSwitchingCamera = true;
    this._resetShakeState();
    this.ui.animateSwitchCamera();
    try {
      const info = await this.camera.switchCamera();
      this.settings.facingMode = this.camera.facingMode;
      this._persistSettings();
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this.ui.updateLensControls(info);
      this._refreshQualityControls();
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();
      this._resetShakeState();
    } catch (err) {
      this.ui.showToast('カメラの切り替えに失敗しました');
    } finally {
      this.isSwitchingCamera = false;
    }
  }

  async selectBackLens(deviceId) {
    if (this.isCapturing || this.countdownRemaining > 0 || this.isSwitchingCamera) return;
    this.isSwitchingCamera = true;
    this._resetShakeState();
    try {
      const info = await this.camera.selectBackLens(deviceId);
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this.ui.updateLensControls(info);
      this._refreshQualityControls();
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();
      this._resetShakeState();
    } catch {
      const refreshed = this.camera.getStreamInfo();
      this.streamInfo = refreshed;
      this.ui.updateStreamBadges(refreshed);
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
    this._resetShakeState();
    try {
      const info = await this.camera.setResolutionPreset(next, {
        aspectRatio: this.settings.aspectRatio,
        allowReacquire: true,
      });
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this.ui.updateLensControls(info);
      this._syncPreviewTransform();
      this._refreshQualityControls();
      this._resetShakeState();
      if (info?.videoWidth && info?.videoHeight) {
        this.ui.showToast(`解像度を設定しました (${info.videoWidth}×${info.videoHeight})`);
      }
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
    const { megapixelData } = this._refreshQualityControls();
    if (megapixelData.plannedOutWidth && megapixelData.plannedOutHeight) {
      this.ui.showToast(
        `保存画素数: ${formatMegapixelsLabel(megapixelData.plannedOutMp)} (${megapixelData.plannedOutWidth}×${megapixelData.plannedOutHeight})`
      );
    }
  }

  toggleAspectRatio() {
    const next = this.settings.aspectRatio === '4:3' ? '16:9' : '4:3';
    this.settings.aspectRatio = next;
    this._persistSettings();
    this.ui.setAspectRatio(next);
    this._resetShakeState();
    if (this.camera.track && this.camera.track.readyState === 'live') {
      this.camera
        .setResolutionPreset(this.settings.cameraResolution, {
          aspectRatio: next,
          allowReacquire: false,
        })
        .then((info) => {
          this.streamInfo = info;
          this.ui.updateStreamBadges(info);
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

  selectStabilizationMode(mode, { silent = false } = {}) {
    const next = normalizeStabilizationMode(mode);
    this.settings.stabilization = next;
    this._persistSettings();
    this.ui.setStabilizationMode(next);
    if (next === STABILIZATION_MODES.OFF) {
      this._resetShakeState();
    }
    if (!silent) {
      const label =
        next === STABILIZATION_MODES.HIGH
          ? '手ぶれ補正: 高品質 (強 · 5連写位置合わせ＋残像ゼロ)'
          : next === STABILIZATION_MODES.STANDARD
          ? '手ぶれ補正: 標準 (位置合わせ＋残像除去)'
          : '手ぶれ補正: オフ (三脚固定向け)';
      this.ui.showToast(label, { durationMs: 2200 });
    }
  }

  cycleStabilization() {
    const idx = STABILIZATION_CYCLE.indexOf(this.settings.stabilization);
    const next = STABILIZATION_CYCLE[(idx + 1) % STABILIZATION_CYCLE.length];
    this.selectStabilizationMode(next);
  }

  selectColorProfile(profile, { silent = true } = {}) {
    const next = normalizeColorProfile(profile);
    this.settings.colorProfile = next;
    this._persistSettings();
    this.ui.setColorProfile(next);
    if (!silent) {
      const label =
        next === COLOR_PROFILES.VIVID
          ? '仕上がりトーン: ビビッド'
          : next === COLOR_PROFILES.FILM
          ? '仕上がりトーン: フィルム調'
          : '仕上がりトーン: Pro ナチュラル';
      this.ui.showToast(label, { durationMs: 2000 });
    }
  }

  async applyZoom(zoom) {
    try {
      const res = await this.camera.setZoom(zoom);
      this._syncPreviewTransform(res);
    } catch {
      const refreshed = this.camera.getStreamInfo();
      this.streamInfo = refreshed;
      this.ui.updateStreamBadges(refreshed);
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

  handleShutter() {
    if (this.isCapturing) return;

    // Cancel active countdown if shutter clicked again
    if (this.countdownRemaining > 0) {
      this._cancelCountdown();
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
    if (this.isCapturing) return;
    if (!this.camera.stream) {
      this.ui.showToast('カメラが準備できていません');
      return;
    }

    this.isCapturing = true;
    this.ui.setCapturing(true);
    this.ui.triggerSilentBlackout();

    const totalStart = performance.now();
    const mode = 'hq';
    const format = this.settings.outputFormat === 'jpeg' ? 'jpeg' : 'avif';
    const isFront = this.camera.facingMode === 'user';
    const mirrorOutput = isFront && this.settings.mirrorFrontSave;
    const softwareEv = this.streamInfo?.supportsHardwareExposure
      ? 0
      : this.camera.exposureCompensation;

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
        aspectRatio: this.settings.aspectRatio,
        softwareZoom: this.camera.softwareZoom,
        outputMegapixels: this.settings.outputMegapixels,
        outputFormat: format,
        maxTextureSize: caps.maxTextureSize,
        supportsNativeAvif: caps.supportsNativeAvif,
      });

      const stabilizationMode = normalizeStabilizationMode(this.settings.stabilization);
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

      const processed = await this.pipeline.process({
        mode,
        frames,
        aspectRatio: this.settings.aspectRatio,
        softwareZoom: this.camera.softwareZoom,
        mirrorX: mirrorOutput,
        exposureEv: softwareEv,
        outputFormat: format,
        outputMegapixels: this.settings.outputMegapixels,
        maxDimension: plan.maxDimension,
        stabilizationMode,
        colorProfile: this.settings.colorProfile,
      });

      const totalTimeMs = Math.round(performance.now() - totalStart);
      this.lastProcessEngine = processed.engine;
      this.lastCaptureTimeMs = totalTimeMs;
      this.lastStabilizationInfo = processed.stabilizationInfo || null;

      const actualFormat = processed.format || format;
      const mimeType =
        processed.mimeType || (actualFormat === 'jpeg' ? 'image/jpeg' : 'image/avif');
      const formatLabel = actualFormat.toUpperCase();
      const filename = buildPhotoFilename(new Date(), mode, actualFormat);
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
        mode,
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

      if (this.platform.isIOS) {
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
            this.lastSavedInfo.method = 'web-share';
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
            this.lastSavedInfo.method = 'share-cancelled';
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
            this.lastSavedInfo.method = shareRes.reason || shareRes.method;
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
      } else {
        const stabSuffix =
          this.lastStabilizationInfo &&
          this.lastStabilizationInfo.mode !== STABILIZATION_MODES.OFF &&
          this.lastStabilizationInfo.maxShiftPx >= 1.5
            ? ` · ブレ補正 ${this.lastStabilizationInfo.maxShiftPx}px`
            : '';
        if (this.settings.autoSave) {
          triggerAnchorDownload(photo.url, photo.filename);
          this.lastSavedInfo.method = 'auto-download';
          this.ui.showToast(`${formatLabel} で保存しました (${totalTimeMs}ms${stabSuffix})`, {
            durationMs: 2400,
          });
        } else {
          this.ui.showToast(`${formatLabel} 撮影完了 (${totalTimeMs}ms${stabSuffix})`, {
            durationMs: 2400,
          });
        }
      }
    } catch (err) {
      this.ui.showToast(`撮影エラー: ${err?.message || '再試行してください'}`);
    } finally {
      this.isCapturing = false;
      this.ui.setCapturing(false);
      this._resetShakeState();
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

  _resetShakeState() {
    this._prevLumaSample = null;
    this._shakeHighCount = 0;
    this.ui.setShakeWarning(false);
  }

  _startShakeMonitor() {
    this._stopShakeMonitor();

    // Never call DeviceMotionEvent.requestPermission() so iOS never shows unsolicited dialogs.
    if (
      typeof window.DeviceMotionEvent === 'function' &&
      typeof window.DeviceMotionEvent.requestPermission !== 'function'
    ) {
      this._deviceMotionListener = (ev) => {
        const rr = ev?.rotationRate;
        if (!rr) return;
        const rate = Math.hypot(rr.alpha || 0, rr.beta || 0, rr.gamma || 0);
        if (Number.isFinite(rate)) {
          this._lastGyroRate = rate;
          this._lastGyroTs = performance.now();
        }
      };
      window.addEventListener('devicemotion', this._deviceMotionListener, { passive: true });
    }

    this._shakeMonitorTimer = setInterval(() => this._samplePreviewShake(), 220);
  }

  _stopShakeMonitor() {
    if (this._shakeMonitorTimer !== null) {
      clearInterval(this._shakeMonitorTimer);
      this._shakeMonitorTimer = null;
    }
    if (this._deviceMotionListener) {
      window.removeEventListener('devicemotion', this._deviceMotionListener);
      this._deviceMotionListener = null;
    }
    if (this._shakeCanvas) {
      this._shakeCanvas.width = 1;
      this._shakeCanvas.height = 1;
      this._shakeCanvas = null;
      this._shakeCtx = null;
    }
    this._lastGyroRate = 0;
    this._lastGyroTs = 0;
    this._resetShakeState();
  }

  _samplePreviewShake() {
    if (
      document.hidden ||
      this.isCapturing ||
      this.isSwitchingCamera ||
      this.settings.stabilization === STABILIZATION_MODES.OFF ||
      !this.ui.els.infoModal.hidden ||
      !this.ui.els.previewModal.hidden ||
      !this.ui.els.cameraOverlay.hidden
    ) {
      if (this._shakeHighCount > 0 || !this.ui.els.shakeWarningPill?.hidden) {
        this._resetShakeState();
      }
      return;
    }

    const video = this.ui.els.video;
    if (!video || video.readyState < 2 || video.videoWidth < 16 || video.videoHeight < 16) {
      return;
    }

    const w = 48;
    const h = 36;
    if (!this._shakeCtx) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      this._shakeCanvas = c;
      this._shakeCtx = c.getContext('2d', { willReadFrequently: true });
      if (!this._shakeCtx) return;
    }
    if (this._shakeCanvas.width !== w || this._shakeCanvas.height !== h) {
      this._shakeCanvas.width = w;
      this._shakeCanvas.height = h;
    }

    try {
      this._shakeCtx.drawImage(video, 0, 0, w, h);
      const rgba = this._shakeCtx.getImageData(0, 0, w, h).data;
      const curLuma = rgbaToLuma(rgba, w, h);

      let shaky = false;
      const recentGyro =
        performance.now() - this._lastGyroTs < 450 && this._lastGyroRate > 55;

      if (this._prevLumaSample && this._prevLumaSample.length === curLuma.length) {
        let diffSum = 0;
        let changedCount = 0;
        let samples = 0;
        for (let y = 4; y < h - 4; y++) {
          const row = y * w;
          for (let x = 4; x < w - 4; x++) {
            const d = Math.abs(curLuma[row + x] - this._prevLumaSample[row + x]);
            diffSum += d;
            if (d > 16) changedCount++;
            samples++;
          }
        }
        const mad = samples > 0 ? diffSum / samples : 0;
        const changedFrac = samples > 0 ? changedCount / samples : 0;
        if ((changedFrac > 0.32 && mad > 12) || recentGyro) {
          shaky = true;
        }
      } else if (recentGyro) {
        shaky = true;
      }

      this._prevLumaSample = curLuma;

      if (shaky) {
        this._shakeHighCount = Math.min(4, this._shakeHighCount + 1);
        if (this._shakeHighCount >= 2) {
          this.ui.setShakeWarning(true);
        }
      } else {
        this._shakeHighCount = 0;
        this.ui.setShakeWarning(false);
      }
    } catch {
      // Ignore transient drawImage errors while stream reconfigures
    }
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

      if (!this.isCapturing && this.photos.length === 0) {
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
        this._resetShakeState();
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
      this._stopShakeMonitor();
      this.camera.stop();
    });
  }
}

const app = new QcamApp();
window.__QCAM__ = app; // Helpful for debugging & automated verification
app.init();
