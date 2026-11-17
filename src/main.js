import { detectPlatform } from './utils/platform.js';
import { CameraController } from './camera/camera-controller.js';
import { ImagePipeline } from './processing/image-pipeline.js';
import { buildPhotoFilename, shareOrSavePhoto, triggerAnchorDownload } from './storage/media-saver.js';
import { CameraUI } from './ui/camera-ui.js';

const MAX_SESSION_PHOTOS = 30;
const TIMER_CYCLE = [0, 3, 10];
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
      mode: saved.mode === 'hq' ? 'hq' : 'standard',
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
    this.lastCaptureTimeMs = null;
    this.lastPermissionState = 'unknown';

    this.ui = new CameraUI({
      onToggleAspect: () => this.toggleAspectRatio(),
      onToggleGrid: () => this.toggleGrid(),
      onCycleTimer: () => this.cycleTimer(),
      onRetryCamera: () => this.startCamera(),
      onShutterClick: () => this.handleShutter(),
      onSwitchCamera: () => this.switchCamera(),
      onSelectMode: (mode) => this.selectMode(mode),
      onZoomChange: (zoom) => this.applyZoom(zoom),
      onTapFocus: (normPoint) => this.applyFocus(normPoint),
      onExposureChange: (ev) => this.applyExposure(ev),
      onOpenGallery: () => this.openGallery(),
      onSelectGalleryIndex: (idx) => this.selectGalleryIndex(idx),
      onDeleteCurrentPhoto: () => this.deleteCurrentPhoto(),
      onSaveCurrentPhoto: (preferShare) => this.saveCurrentPhoto(preferShare),
      onSettingChange: (key, val) => this.updateSetting(key, val),
      onSelectBackLens: (deviceId) => this.selectBackLens(deviceId),
      onRefreshDiagnostics: () => this.refreshDiagnostics(),
      onOpenPermissionGuide: () => this.ui.openInfoModal({ scrollToPermissionGuide: true }),
      onDismissPermissionHint: () => this.dismissPermissionHint(),
    });

    this.camera = new CameraController(this.ui.els.video, this.platform);
    this.camera.facingMode = this.settings.facingMode;
    this.camera.onStreamInfo = (info) => {
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this.ui.updateLensControls(info);
      this._syncPreviewTransform();
    };

    this.pipeline = new ImagePipeline(this.platform);
  }

  _persistSettings() {
    writeJsonStorage(SETTINGS_STORAGE_KEY, {
      aspectRatio: this.settings.aspectRatio,
      gridVisible: this.settings.gridVisible,
      mode: this.settings.mode,
      autoSave: this.settings.autoSave,
      autoSaveExplicit: Boolean(this.settings.autoSaveExplicit),
      mirrorFrontSave: this.settings.mirrorFrontSave,
      facingMode: this.settings.facingMode,
    });
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
    this.ui.setCaptureMode(this.settings.mode);
    this.ui.els.toggleAutoSave.checked = this.settings.autoSave;
    this.ui.els.toggleMirrorFront.checked = this.settings.mirrorFrontSave;
    this.ui.renderPermissionGuide(this.platform);

    await this.startCamera({ fromInit: true });
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

      const info = await this.camera.start({ facingMode: this.settings.facingMode });
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this.ui.updateLensControls(info);
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();

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
    this.ui.animateSwitchCamera();
    try {
      const info = await this.camera.switchCamera();
      this.settings.facingMode = this.camera.facingMode;
      this._persistSettings();
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this.ui.updateLensControls(info);
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();
    } catch (err) {
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
      this.ui.updateStreamBadges(info);
      this.ui.updateLensControls(info);
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();
    } catch {
      const refreshed = this.camera.getStreamInfo();
      this.streamInfo = refreshed;
      this.ui.updateStreamBadges(refreshed);
      this.ui.updateLensControls(refreshed);
      this._syncPreviewTransform();
      this.ui.showToast('このレンズはブラウザから開けませんでした');
    } finally {
      this.isSwitchingCamera = false;
    }
  }

  toggleAspectRatio() {
    const next = this.settings.aspectRatio === '4:3' ? '16:9' : '4:3';
    this.settings.aspectRatio = next;
    this._persistSettings();
    this.ui.setAspectRatio(next);
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

  selectMode(mode) {
    if (mode !== 'standard' && mode !== 'hq') return;
    this.settings.mode = mode;
    this._persistSettings();
    this.ui.setCaptureMode(mode);
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
    const mode = this.settings.mode;
    const isFront = this.camera.facingMode === 'user';
    const mirrorOutput = isFront && this.settings.mirrorFrontSave;
    const softwareEv = this.streamInfo?.supportsHardwareExposure
      ? 0
      : this.camera.exposureCompensation;

    try {
      let frames = [];
      if (mode === 'hq') {
        const burst = await this.camera.captureBurstFrames(4, 200);
        frames = burst.frames;
      } else {
        const single = await this.camera.captureSingleFrame();
        frames = [single.bitmap];
      }

      const processed = await this.pipeline.process({
        mode,
        frames,
        aspectRatio: this.settings.aspectRatio,
        softwareZoom: this.camera.softwareZoom,
        mirrorX: mirrorOutput,
        exposureEv: softwareEv,
      });

      const totalTimeMs = Math.round(performance.now() - totalStart);
      this.lastProcessEngine = processed.engine;
      this.lastCaptureTimeMs = totalTimeMs;

      const filename = buildPhotoFilename(new Date(), mode);
      const url = URL.createObjectURL(processed.blob);
      const photo = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        blob: processed.blob,
        url,
        filename,
        width: processed.width,
        height: processed.height,
        mode,
        engine: processed.engine,
        processTimeMs: processed.processTimeMs,
        totalTimeMs,
      };

      this._addSessionPhoto(photo);

      if (this.platform.isIOS) {
        if (this.settings.autoSave && !fromTimer) {
          // Attempt direct Web Share Sheet while shutter tap's transient user activation is still active.
          const shareRes = await shareOrSavePhoto(photo, this.platform, { preferShare: true });
          if (shareRes.method === 'web-share' && shareRes.completed) {
            this.ui.showToast(`共有 /「写真」へ保存しました (${totalTimeMs}ms)`, {
              durationMs: 2800,
            });
          } else if (shareRes.cancelled) {
            this.ui.showToast(`撮影完了 (${totalTimeMs}ms) · タップで「写真」へ保存`, {
              durationMs: 5500,
              onClick: () => this._invokeIOSShareOrModal(photo),
            });
          } else if (!shareRes.busy) {
            // If transient user activation expired (e.g., slow HQ burst) or Share Sheet unavailable,
            // open the Preview Modal so 1-tap Share Sheet ("画像を保存") or long-press works immediately.
            const idx = this.photos.findIndex((p) => p.id === photo.id);
            this.currentGalleryIndex = idx >= 0 ? idx : 0;
            this.ui.openPreviewModal(this.photos, this.currentGalleryIndex, this.platform);
            this.ui.showToast(
              shareRes.gestureExpired
                ? '下のボタンで「画像を保存」または写真を長押ししてください'
                : '写真を長押しして「“写真”に保存」を選択してください',
              { durationMs: 5000 }
            );
          }
        } else if (this.settings.autoSave && fromTimer) {
          // Countdown timer runs after activation expires; open Preview Modal with 1-tap Photos save CTA.
          this.ui.openPreviewModal(this.photos, this.currentGalleryIndex, this.platform);
          this.ui.showToast('タイマー撮影完了 · 下のボタンから「写真」へ保存できます', {
            durationMs: 4500,
          });
        } else {
          this.ui.showToast(`撮影完了 (${totalTimeMs}ms) · タップで「写真」へ保存`, {
            durationMs: 5500,
            onClick: () => this._invokeIOSShareOrModal(photo),
          });
        }
      } else if (this.settings.autoSave) {
        triggerAnchorDownload(photo.url, photo.filename);
        this.ui.showToast(`保存しました (${totalTimeMs}ms)`, { durationMs: 2400 });
      } else {
        this.ui.showToast(`撮影完了 (${totalTimeMs}ms)`, { durationMs: 2400 });
      }
    } catch (err) {
      this.ui.showToast(`撮影エラー: ${err?.message || '再試行してください'}`);
    } finally {
      this.isCapturing = false;
      this.ui.setCapturing(false);
    }
  }

  async _invokeIOSShareOrModal(photo) {
    const res = await shareOrSavePhoto(photo, this.platform, { preferShare: true });
    if (res.method === 'web-share' && res.completed) {
      this.ui.showToast('共有 /「写真」へ保存しました');
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

  async saveCurrentPhoto(preferShare = false) {
    const photo = this.photos[this.currentGalleryIndex];
    if (!photo) return;
    const res = await shareOrSavePhoto(photo, this.platform, {
      preferShare: preferShare || this.platform.isIOS,
    });
    if (res.method === 'download' && res.completed) {
      this.ui.showToast('端末に保存しました');
    } else if (res.method === 'web-share' && res.completed) {
      this.ui.showToast('共有 /「写真」へ保存しました');
    } else if (res.method === 'ios-manual-hint') {
      this.ui.showToast('プレビュー画像を長押しして「“写真”に保存」を選択してください');
    }
  }

  updateSetting(key, val) {
    this.settings[key] = val;
    if (key === 'autoSave') {
      this.settings.autoSaveExplicit = true;
    }
    this._persistSettings();
  }

  refreshDiagnostics() {
    const info = this.streamInfo || {};
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

    const entries = [
      ['プラットフォーム', `${this.platform.osLabel} (${this.platform.browserLabel})`],
      ['PWA モード', this.platform.isStandalonePWA ? 'スタンドアロン (全画面)' : 'ブラウザ表示'],
      ['カメラ権限状態', permLabelMap[this.lastPermissionState] || this.lastPermissionState],
      ['超広角 (0.5×) カメラ', ultraWideLabel],
      [
        'プレビュー解像度',
        info.videoWidth && info.videoHeight ? `${info.videoWidth}×${info.videoHeight}` : '未取得',
      ],
      [
        '静止画センサー上限',
        info.photoMaxWidth && info.photoMaxHeight
          ? `${info.photoMaxWidth}×${info.photoMaxHeight}`
          : 'ストリーム解像度',
      ],
      ['カメラ起動時間', info.startupTimeMs ? `${info.startupTimeMs} ms` : '--'],
      [
        '基本撮影方式',
        info.supportsTakePhoto ? 'ImageCapture.takePhoto()' : '<video> 高解像度フレーム抽出',
      ],
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
      ['保存フロー', this.platform.preferWebShareSave ? 'Web Share API (カメラロール)' : '<a download> 直接保存'],
    ];
    this.ui.renderDiagnostics(entries);
  }

  _registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
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
      } else if (this.ui.els.cameraOverlay.hidden) {
        const trackEnded =
          !this.camera.stream ||
          !this.camera.track ||
          this.camera.track.readyState === 'ended';
        if (trackEnded) {
          this.startCamera();
        }
      }
    });

    // Release hardware cleanly when leaving or reloading so next page load acquires immediately
    window.addEventListener('pagehide', () => {
      this._cancelCountdown();
      this.camera.stop();
    });
  }
}

const app = new QcamApp();
window.__QCAM__ = app; // Helpful for debugging & automated verification
app.init();
