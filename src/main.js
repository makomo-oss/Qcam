import { detectPlatform } from './utils/platform.js';
import { CameraController } from './camera/camera-controller.js';
import { ImagePipeline } from './processing/image-pipeline.js';
import { buildPhotoFilename, shareOrSavePhoto, triggerAnchorDownload } from './storage/media-saver.js';
import { CameraUI } from './ui/camera-ui.js';

const MAX_SESSION_PHOTOS = 30;
const TIMER_CYCLE = [0, 3, 10];

class QcamApp {
  constructor() {
    this.platform = detectPlatform(window);
    this.settings = {
      aspectRatio: '4:3',
      gridVisible: false,
      timerSeconds: 0,
      mode: 'standard',
      autoSave: !this.platform.isIOS,
      mirrorFrontSave: false,
    };

    this.photos = [];
    this.currentGalleryIndex = 0;
    this.isCapturing = false;
    this.countdownTimerId = null;
    this.countdownRemaining = 0;
    this.streamInfo = null;
    this.lastProcessEngine = '--';
    this.lastCaptureTimeMs = null;

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
      onRefreshDiagnostics: () => this.refreshDiagnostics(),
    });

    this.camera = new CameraController(this.ui.els.video, this.platform);
    this.camera.onStreamInfo = (info) => {
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this._syncPreviewTransform();
    };

    this.pipeline = new ImagePipeline(this.platform);
  }

  async init() {
    this.ui.setAspectRatio(this.settings.aspectRatio);
    this.ui.setGridVisible(this.settings.gridVisible);
    this.ui.setTimerSeconds(this.settings.timerSeconds);
    this.ui.setCaptureMode(this.settings.mode);
    this.ui.els.toggleAutoSave.checked = this.settings.autoSave;
    this.ui.els.toggleMirrorFront.checked = this.settings.mirrorFrontSave;

    await this.startCamera();
    this._registerServiceWorker();
    this._setupLifecycleHandlers();
  }

  async startCamera() {
    this.ui.hideCameraOverlay();
    try {
      const info = await this.camera.start();
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();
    } catch (err) {
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        this.ui.showCameraOverlay(
          'カメラの使用が許可されていません',
          'ブラウザまたは端末の設定からこのサイトのカメラアクセスを許可して「カメラを起動」を押してください。'
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
    if (this.isCapturing || this.countdownRemaining > 0) return;
    this.ui.animateSwitchCamera();
    try {
      const info = await this.camera.switchCamera();
      this.streamInfo = info;
      this.ui.updateStreamBadges(info);
      this.ui.setExposureDisplay(0);
      this._syncPreviewTransform();
    } catch (err) {
      this.ui.showToast('カメラの切り替えに失敗しました');
    }
  }

  toggleAspectRatio() {
    const next = this.settings.aspectRatio === '4:3' ? '16:9' : '4:3';
    this.settings.aspectRatio = next;
    this.ui.setAspectRatio(next);
  }

  toggleGrid() {
    this.settings.gridVisible = !this.settings.gridVisible;
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
    this.ui.setCaptureMode(mode);
  }

  async applyZoom(zoom) {
    const res = await this.camera.setZoom(zoom);
    this._syncPreviewTransform(res);
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

    this._captureNow();
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
        this._captureNow();
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

  async _captureNow() {
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
        // On iOS Safari, navigator.share requires a synchronous user gesture.
        // Offer a crisp clickable toast pill + thumbnail so one tap invokes the native Save Sheet.
        this.ui.showToast(`撮影完了 (${totalTimeMs}ms) · タップして保存`, {
          durationMs: 4800,
          onClick: () => this._invokeIOSShareOrModal(photo),
        });
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
    if (!res.completed && !res.cancelled) {
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
    const res = await shareOrSavePhoto(photo, this.platform, { preferShare });
    if (res.method === 'download' && res.completed) {
      this.ui.showToast('端末に保存しました');
    } else if (res.method === 'ios-manual-hint') {
      this.ui.showToast('画像を長押しして「写真に保存」を選択してください');
    }
  }

  updateSetting(key, val) {
    this.settings[key] = val;
  }

  refreshDiagnostics() {
    const info = this.streamInfo || {};
    const entries = [
      ['プラットフォーム', `${this.platform.osLabel} (${this.platform.browserLabel})`],
      ['PWA モード', this.platform.isStandalonePWA ? 'スタンドアロン (全画面)' : 'ブラウザ表示'],
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
    // Pause camera cleanly when backgrounded and resume when visible (mobile battery & iOS stream recovery)
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this._cancelCountdown();
        this.camera.stop();
      } else if (!this.camera.stream && this.ui.els.cameraOverlay.hidden) {
        this.startCamera();
      }
    });
  }
}

const app = new QcamApp();
window.__QCAM__ = app; // Helpful for debugging & automated verification
app.init();
