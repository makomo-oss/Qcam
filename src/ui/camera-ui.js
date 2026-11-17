import {
  computeViewfinderLayout,
  mapTapToNormalizedPoint,
} from '../utils/geometry.js';

export class CameraUI {
  constructor(handlers) {
    this.handlers = handlers;

    this.els = {
      topHud: document.getElementById('top-hud'),
      topBar: document.querySelector('.top-bar'),
      bottomDock: document.querySelector('.bottom-dock'),
      zoomBar: document.querySelector('.zoom-bar'),
      silentBadge: document.getElementById('silent-badge'),
      resolutionBadge: document.getElementById('resolution-badge'),
      btnAspect: document.getElementById('btn-aspect'),
      aspectLabel: document.getElementById('aspect-label'),
      btnGrid: document.getElementById('btn-grid'),
      btnTimer: document.getElementById('btn-timer'),
      timerLabel: document.getElementById('timer-label'),
      btnInfo: document.getElementById('btn-info'),
      permHintBanner: document.getElementById('perm-hint-banner'),
      btnPermHintOpen: document.getElementById('btn-perm-hint-open'),
      btnPermHintDismiss: document.getElementById('btn-perm-hint-dismiss'),

      stage: document.getElementById('viewfinder-stage'),
      frame: document.getElementById('viewfinder-frame'),
      video: document.getElementById('camera-video'),
      gridOverlay: document.getElementById('grid-overlay'),
      focusReticle: document.getElementById('focus-reticle'),
      evControl: document.getElementById('ev-control'),
      evSlider: document.getElementById('ev-slider'),
      evValue: document.getElementById('ev-value'),
      shutterBlackout: document.getElementById('shutter-blackout'),
      countdownOverlay: document.getElementById('countdown-overlay'),
      countdownNumber: document.getElementById('countdown-number'),
      zoomHudPill: document.getElementById('zoom-hud-pill'),

      cameraOverlay: document.getElementById('camera-overlay'),
      overlayTitle: document.getElementById('overlay-title'),
      overlayMessage: document.getElementById('overlay-message'),
      btnRetryCamera: document.getElementById('btn-retry-camera'),
      btnOverlayHelp: document.getElementById('btn-overlay-help'),

      saveToast: document.getElementById('save-toast'),
      zoomPresets: Array.from(document.querySelectorAll('.zoom-bar .zoom-preset')),
      zoomSlider: document.getElementById('zoom-slider'),
      zoomReadout: document.getElementById('zoom-readout'),

      modeTabs: Array.from(document.querySelectorAll('.mode-tab')),
      btnGallery: document.getElementById('btn-gallery'),
      thumbImg: document.getElementById('thumb-img'),
      thumbPlaceholder: document.getElementById('thumb-placeholder'),
      thumbCount: document.getElementById('thumb-count'),
      btnShutter: document.getElementById('btn-shutter'),
      btnSwitchCamera: document.getElementById('btn-switch-camera'),

      previewModal: document.getElementById('preview-modal'),
      btnModalClose: document.getElementById('btn-modal-close'),
      btnModalDelete: document.getElementById('btn-modal-delete'),
      previewMeta: document.getElementById('preview-meta'),
      previewStage: document.getElementById('preview-stage'),
      previewImage: document.getElementById('preview-image'),
      previewFilmstrip: document.getElementById('preview-filmstrip'),
      previewSaveHint: document.getElementById('preview-save-hint'),
      btnPreviewZoom1x: document.getElementById('btn-preview-zoom-1x'),
      btnPreviewZoom2x: document.getElementById('btn-preview-zoom-2x'),
      btnPreviewZoom4x: document.getElementById('btn-preview-zoom-4x'),
      btnModalShare: document.getElementById('btn-modal-share'),
      btnModalSave: document.getElementById('btn-modal-save'),

      infoModal: document.getElementById('info-modal'),
      btnInfoClose: document.getElementById('btn-info-close'),
      toggleAutoSave: document.getElementById('toggle-auto-save'),
      toggleMirrorFront: document.getElementById('toggle-mirror-front'),
      permissionGuide: document.getElementById('permission-guide'),
      diagnosticsList: document.getElementById('diagnostics-list'),
    };

    this.state = {
      aspectRatio: '4:3',
      gridVisible: false,
      timerSeconds: 0,
      mode: 'standard',
      mirroredPreview: false,
      softwareZoom: 1,
      totalZoom: 1,
      maxZoom: 5,
      previewZoom: 1,
    };

    this._frameTopInset = 0;
    this._frameBottomInset = 0;
    this._focusHideTimer = null;
    this._focusFadeTimer = null;
    this._toastTimer = null;
    this._zoomHudTimer = null;
    this._toastClickHandler = null;
    this._activePointers = new Map();
    this._pinchStartDist = 0;
    this._pinchStartZoom = 1;
    this._didPinch = false;
    this._pointerDownPos = null;

    this._bindEvents();
    this._setupResizeObserver();
  }

  _bindEvents() {
    this.els.btnAspect.addEventListener('click', () => this.handlers.onToggleAspect());
    this.els.btnGrid.addEventListener('click', () => this.handlers.onToggleGrid());
    this.els.btnTimer.addEventListener('click', () => this.handlers.onCycleTimer());
    this.els.btnInfo.addEventListener('click', () => this.openInfoModal());
    this.els.btnInfoClose.addEventListener('click', () => this.closeInfoModal());
    this.els.infoModal.addEventListener('click', (e) => {
      if (e.target === this.els.infoModal) this.closeInfoModal();
    });

    this.els.btnPermHintOpen?.addEventListener('click', () => {
      this.handlers.onOpenPermissionGuide?.();
    });
    this.els.btnPermHintDismiss?.addEventListener('click', () => {
      this.handlers.onDismissPermissionHint?.();
    });
    this.els.btnOverlayHelp?.addEventListener('click', () => {
      this.handlers.onOpenPermissionGuide?.();
    });

    this.els.btnRetryCamera.addEventListener('click', () => this.handlers.onRetryCamera());
    this.els.btnShutter.addEventListener('click', () => this.handlers.onShutterClick());
    this.els.btnSwitchCamera.addEventListener('click', () => this.handlers.onSwitchCamera());
    this.els.btnGallery.addEventListener('click', () => this.handlers.onOpenGallery());

    for (const tab of this.els.modeTabs) {
      tab.addEventListener('click', () => {
        this.handlers.onSelectMode(tab.dataset.mode);
      });
    }

    for (const preset of this.els.zoomPresets) {
      preset.addEventListener('click', () => {
        this.handlers.onZoomChange(Number(preset.dataset.zoom));
      });
    }

    this.els.zoomSlider.addEventListener('input', (e) => {
      this.handlers.onZoomChange(Number(e.target.value));
    });

    this.els.evSlider.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      this.els.evValue.textContent = (val > 0 ? `+${val.toFixed(1)}` : val.toFixed(1));
      this._resetFocusTimers();
      this.handlers.onExposureChange(val);
    });

    this.els.evControl.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.els.evControl.addEventListener('click', (e) => e.stopPropagation());

    // Viewfinder gesture handling (pinch zoom + tap-to-focus)
    this.els.frame.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.els.frame.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.els.frame.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.els.frame.addEventListener('pointercancel', (e) => this._onPointerCancel(e));

    // Save toast clickable action (crucial for synchronous iOS Share Sheet trigger)
    this.els.saveToast.addEventListener('click', () => {
      if (typeof this._toastClickHandler === 'function') {
        this._toastClickHandler();
      }
    });

    // Preview Modal events
    this.els.btnModalClose.addEventListener('click', () => this.closePreviewModal());
    this.els.btnModalDelete.addEventListener('click', () => this.handlers.onDeleteCurrentPhoto());
    this.els.btnModalSave.addEventListener('click', () => this.handlers.onSaveCurrentPhoto(false));
    this.els.btnModalShare.addEventListener('click', () => this.handlers.onSaveCurrentPhoto(true));

    this.els.btnPreviewZoom1x.addEventListener('click', () => this.setPreviewZoom(1));
    this.els.btnPreviewZoom2x.addEventListener('click', () => this.setPreviewZoom(2));
    this.els.btnPreviewZoom4x.addEventListener('click', () => this.setPreviewZoom(4));
    this.els.previewImage.addEventListener('dblclick', () => {
      this.setPreviewZoom(this.state.previewZoom > 1 ? 1 : 2);
    });

    // Settings toggles
    this.els.toggleAutoSave.addEventListener('change', (e) => {
      this.handlers.onSettingChange('autoSave', Boolean(e.target.checked));
    });
    this.els.toggleMirrorFront.addEventListener('change', (e) => {
      this.handlers.onSettingChange('mirrorFrontSave', Boolean(e.target.checked));
    });

    // Keyboard shortcuts (Space/Enter to shoot when modal closed, Esc to close modals)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!this.els.previewModal.hidden) this.closePreviewModal();
        if (!this.els.infoModal.hidden) this.closeInfoModal();
      } else if (
        (e.code === 'Space' || e.key === 'Enter') &&
        this.els.previewModal.hidden &&
        this.els.infoModal.hidden &&
        this.els.cameraOverlay.hidden &&
        document.activeElement === document.body
      ) {
        e.preventDefault();
        this.handlers.onShutterClick();
      }
    });
  }

  _setupResizeObserver() {
    const updateSize = () => this.fitViewfinderFrame();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(updateSize);
      ro.observe(this.els.stage);
      if (this.els.topBar) ro.observe(this.els.topBar);
      if (this.els.bottomDock) ro.observe(this.els.bottomDock);
    }
    window.addEventListener('resize', updateSize);
    window.addEventListener('orientationchange', updateSize);
    window.visualViewport?.addEventListener('resize', updateSize);
    requestAnimationFrame(updateSize);
  }

  fitViewfinderFrame() {
    const stageRect = this.els.stage.getBoundingClientRect();
    const topRect = this.els.topBar?.getBoundingClientRect();
    const dockRect = this.els.bottomDock?.getBoundingClientRect();

    const layout = computeViewfinderLayout({
      stageWidth: stageRect.width,
      stageHeight: stageRect.height,
      topBarBottom: topRect ? topRect.bottom - stageRect.top : 0,
      dockTop: dockRect ? dockRect.top - stageRect.top : stageRect.height,
      dockLeft: dockRect ? dockRect.left - stageRect.left : stageRect.width,
      dockWidth: dockRect ? dockRect.width : 0,
      dockHeight: dockRect ? dockRect.height : 0,
      aspectRatio: this.state.aspectRatio,
    });

    this._frameTopInset = layout.topInset;
    this._frameBottomInset = layout.bottomInset;

    this.els.frame.style.left = `${layout.left}px`;
    this.els.frame.style.top = `${layout.top}px`;
    this.els.frame.style.width = `${layout.width}px`;
    this.els.frame.style.height = `${layout.height}px`;
    this.els.frame.style.setProperty('--frame-top-inset', `${layout.topInset}px`);
    this.els.frame.style.setProperty('--frame-bottom-inset', `${layout.bottomInset}px`);
    this.els.frame.classList.toggle('is-edge-to-edge', layout.edgeToEdge);
  }

  _onPointerDown(e) {
    if (!this.els.cameraOverlay.hidden || !this.els.countdownOverlay.hidden) return;
    if (e.target.closest('#ev-control')) return;

    this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._activePointers.size === 1) {
      this._didPinch = false;
      this._pointerDownPos = { x: e.clientX, y: e.clientY };
    } else if (this._activePointers.size === 2) {
      this._didPinch = true;
      const pts = Array.from(this._activePointers.values());
      this._pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      this._pinchStartZoom = this.state.totalZoom;
    }
  }

  _onPointerMove(e) {
    if (!this._activePointers.has(e.pointerId)) return;
    this._activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._activePointers.size === 2 && this._pinchStartDist > 10) {
      const pts = Array.from(this._activePointers.values());
      const currentDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const scale = currentDist / this._pinchStartDist;
      const nextZoom = Math.max(
        1.0,
        Math.min(this.state.maxZoom, this._pinchStartZoom * scale)
      );
      this._showZoomHud(nextZoom);
      this.handlers.onZoomChange(nextZoom);
    }
  }

  _onPointerUp(e) {
    const hadSinglePointer = this._activePointers.size === 1;
    this._activePointers.delete(e.pointerId);

    if (
      hadSinglePointer &&
      !this._didPinch &&
      this._pointerDownPos &&
      !e.target.closest('#ev-control')
    ) {
      const moveDist = Math.hypot(
        e.clientX - this._pointerDownPos.x,
        e.clientY - this._pointerDownPos.y
      );
      if (moveDist < 12) {
        this._handleTapFocus(e.clientX, e.clientY);
      }
    }

    if (this._activePointers.size === 0) {
      this._pointerDownPos = null;
    }
  }

  _onPointerCancel(e) {
    this._activePointers.delete(e.pointerId);
    if (this._activePointers.size === 0) {
      this._pointerDownPos = null;
    }
  }

  _handleTapFocus(clientX, clientY) {
    const rect = this.els.frame.getBoundingClientRect();
    const minY = Math.max(44, (this._frameTopInset || 0) + 38);
    const maxY = Math.max(minY, rect.height - Math.max(44, (this._frameBottomInset || 0) + 38));
    const relX = Math.max(44, Math.min(rect.width - 44, clientX - rect.left));
    const relY = Math.max(minY, Math.min(maxY, clientY - rect.top));

    this.els.focusReticle.style.left = `${relX}px`;
    this.els.focusReticle.style.top = `${relY}px`;
    this.els.focusReticle.classList.toggle('is-ev-left', relX > rect.width - 96);
    this.els.focusReticle.classList.remove('is-fading');
    this.els.focusReticle.hidden = false;
    this._resetFocusTimers();

    const norm = mapTapToNormalizedPoint(
      clientX,
      clientY,
      rect,
      this.els.video.videoWidth,
      this.els.video.videoHeight,
      {
        mirrored: this.state.mirroredPreview,
        softwareZoom: this.state.softwareZoom,
      }
    );
    this.handlers.onTapFocus(norm);
  }

  _resetFocusTimers() {
    clearTimeout(this._focusFadeTimer);
    clearTimeout(this._focusHideTimer);
    this.els.focusReticle.classList.remove('is-fading');
    this._focusFadeTimer = setTimeout(() => {
      this.els.focusReticle.classList.add('is-fading');
    }, 2400);
    this._focusHideTimer = setTimeout(() => {
      this.els.focusReticle.hidden = true;
    }, 4400);
  }

  _showZoomHud(zoom) {
    this.els.zoomHudPill.textContent = `${zoom.toFixed(1)}×`;
    this.els.zoomHudPill.hidden = false;
    clearTimeout(this._zoomHudTimer);
    this._zoomHudTimer = setTimeout(() => {
      this.els.zoomHudPill.hidden = true;
    }, 900);
  }

  setAspectRatio(aspectRatio) {
    this.state.aspectRatio = aspectRatio;
    this.els.aspectLabel.textContent = aspectRatio;
    this.fitViewfinderFrame();
  }

  setGridVisible(visible) {
    this.state.gridVisible = visible;
    this.els.gridOverlay.hidden = !visible;
    this.els.btnGrid.setAttribute('aria-pressed', String(visible));
  }

  setTimerSeconds(seconds) {
    this.state.timerSeconds = seconds;
    this.els.timerLabel.textContent = seconds > 0 ? `${seconds}s` : 'OFF';
    this.els.btnTimer.classList.toggle('is-active', seconds > 0);
  }

  setCaptureMode(mode) {
    this.state.mode = mode;
    for (const tab of this.els.modeTabs) {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    this.els.btnShutter.classList.toggle('is-hq', mode === 'hq');
  }

  setVideoTransform({ mirroredPreview, softwareZoom, totalZoom, maxZoom, softwareEv = 0 }) {
    this.state.mirroredPreview = mirroredPreview;
    this.state.softwareZoom = softwareZoom;
    this.state.totalZoom = totalZoom;
    if (maxZoom) {
      this.state.maxZoom = maxZoom;
      this.els.zoomSlider.max = String(maxZoom);
    }

    const scaleX = (mirroredPreview ? -1 : 1) * softwareZoom;
    const scaleY = softwareZoom;
    this.els.video.style.transform = `scale(${scaleX}, ${scaleY})`;

    const brightness = Math.pow(2, softwareEv * 0.45);
    this.els.video.style.filter =
      Math.abs(softwareEv) > 0.01 ? `brightness(${brightness.toFixed(3)})` : '';

    this.els.zoomSlider.value = String(totalZoom);
    this.els.zoomReadout.textContent = `${totalZoom.toFixed(1)}×`;

    for (const preset of this.els.zoomPresets) {
      const pz = Number(preset.dataset.zoom);
      const isClose = Math.abs(totalZoom - pz) < 0.15;
      preset.classList.toggle('is-active', isClose);
    }
  }

  setExposureDisplay(ev) {
    this.els.evSlider.value = String(ev);
    this.els.evValue.textContent = ev > 0 ? `+${ev.toFixed(1)}` : ev.toFixed(1);
  }

  animateSwitchCamera() {
    this.els.btnSwitchCamera.classList.toggle('is-flipped');
  }

  triggerSilentBlackout() {
    const el = this.els.shutterBlackout;
    el.classList.remove('is-active');
    void el.offsetWidth;
    el.classList.add('is-active');
  }

  setCapturing(isCapturing) {
    this.els.btnShutter.classList.toggle('is-capturing', isCapturing);
    this.els.btnShutter.disabled = isCapturing;
  }

  setCountdown(remainingSeconds) {
    if (remainingSeconds > 0) {
      this.els.countdownOverlay.hidden = false;
      this.els.countdownNumber.textContent = String(remainingSeconds);
      this.els.btnShutter.classList.add('is-countdown');
    } else {
      this.els.countdownOverlay.hidden = true;
      this.els.btnShutter.classList.remove('is-countdown');
    }
  }

  updateStreamBadges(info) {
    if (!info) return;
    const resText =
      info.videoWidth && info.videoHeight
        ? `${info.videoWidth}×${info.videoHeight}`
        : '--×--';
    this.els.resolutionBadge.textContent = resText;
  }

  showCameraOverlay(title, message, options = true) {
    const { showRetry = true, showHelp = false } =
      typeof options === 'boolean' ? { showRetry: options } : options || {};
    this.els.overlayTitle.textContent = title;
    this.els.overlayMessage.textContent = message;
    this.els.btnRetryCamera.hidden = !showRetry;
    if (this.els.btnOverlayHelp) {
      this.els.btnOverlayHelp.hidden = !showHelp;
    }
    this.els.cameraOverlay.hidden = false;
  }

  hideCameraOverlay() {
    this.els.cameraOverlay.hidden = true;
  }

  showPermissionHintBanner() {
    if (this.els.permHintBanner) {
      this.els.permHintBanner.hidden = false;
    }
  }

  hidePermissionHintBanner() {
    if (this.els.permHintBanner) {
      this.els.permHintBanner.hidden = true;
    }
  }

  updateThumbnail(latestPhoto, totalCount) {
    if (!latestPhoto) {
      this.els.thumbImg.hidden = true;
      this.els.thumbImg.removeAttribute('src');
      this.els.thumbPlaceholder.hidden = false;
      this.els.thumbCount.hidden = true;
      this.els.btnGallery.disabled = true;
      return;
    }

    this.els.thumbImg.src = latestPhoto.url;
    this.els.thumbImg.hidden = false;
    this.els.thumbPlaceholder.hidden = true;
    this.els.btnGallery.disabled = false;
    if (totalCount > 1) {
      this.els.thumbCount.textContent = String(totalCount);
      this.els.thumbCount.hidden = false;
    } else {
      this.els.thumbCount.hidden = true;
    }
  }

  showToast(message, { durationMs = 2800, onClick = null } = {}) {
    clearTimeout(this._toastTimer);
    this._toastClickHandler = onClick;
    this.els.saveToast.textContent = message;
    this.els.saveToast.hidden = false;
    this.els.saveToast.style.cursor = onClick ? 'pointer' : 'default';
    this._toastTimer = setTimeout(() => {
      this.els.saveToast.hidden = true;
      this._toastClickHandler = null;
    }, durationMs);
  }

  openPreviewModal(photos, currentIndex, platform) {
    const photo = photos[currentIndex];
    if (!photo) return;

    this.els.previewImage.src = photo.url;
    this.setPreviewZoom(1);

    const kb = Math.round(photo.blob.size / 1024);
    const sizeText = kb >= 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb} KB`;
    const modeLabel = photo.mode === 'hq' ? '高画質 HDR' : '標準';
    this.els.previewMeta.textContent = `${photo.width}×${photo.height} · ${modeLabel} · ${photo.totalTimeMs}ms · ${sizeText}`;

    // OS-specific save UI guidance
    this.els.previewSaveHint.hidden = !platform.isIOS;
    this.els.btnModalSave.textContent = platform.isIOS
      ? 'カメラロールへ保存 / 共有'
      : '端末に保存 (JPEG)';
    this.els.btnModalShare.hidden = platform.isIOS || !platform.supportsWebShareFiles;

    // Render filmstrip
    this.els.previewFilmstrip.innerHTML = '';
    if (photos.length > 1) {
      this.els.previewFilmstrip.hidden = false;
      photos.forEach((p, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `filmstrip-item${idx === currentIndex ? ' is-active' : ''}`;
        btn.setAttribute('aria-label', `写真 ${idx + 1}`);
        const img = document.createElement('img');
        img.src = p.url;
        img.alt = p.filename;
        btn.appendChild(img);
        btn.addEventListener('click', () => this.handlers.onSelectGalleryIndex(idx));
        this.els.previewFilmstrip.appendChild(btn);
      });
    } else {
      this.els.previewFilmstrip.hidden = true;
    }

    this.els.previewModal.hidden = false;
  }

  closePreviewModal() {
    this.els.previewModal.hidden = true;
    this.setPreviewZoom(1);
  }

  setPreviewZoom(zoom) {
    this.state.previewZoom = zoom;
    const img = this.els.previewImage;
    const stage = this.els.previewStage;

    this.els.btnPreviewZoom1x.classList.toggle('is-active', zoom === 1);
    this.els.btnPreviewZoom2x.classList.toggle('is-active', zoom === 2);
    this.els.btnPreviewZoom4x.classList.toggle('is-active', zoom === 4);

    if (zoom <= 1) {
      img.style.width = '';
      img.style.height = '';
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
      stage.style.alignItems = 'center';
      stage.style.justifyContent = 'center';
      stage.scrollTo(0, 0);
      return;
    }

    // Measure natural fitted size inside stage, then multiply cleanly for full-pan inspection
    const stageRect = stage.getBoundingClientRect();
    const natW = img.naturalWidth || stageRect.width;
    const natH = img.naturalHeight || stageRect.height;
    const fitScale = Math.min(
      (stageRect.width - 24) / natW,
      (stageRect.height - 24) / natH
    );
    const targetW = Math.round(natW * fitScale * zoom);
    const targetH = Math.round(natH * fitScale * zoom);

    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.width = `${targetW}px`;
    img.style.height = `${targetH}px`;
    stage.style.alignItems = 'flex-start';
    stage.style.justifyContent = 'flex-start';

    requestAnimationFrame(() => {
      stage.scrollTo(
        Math.max(0, (targetW - stageRect.width) / 2),
        Math.max(0, (targetH - stageRect.height) / 2)
      );
    });
  }

  openInfoModal({ scrollToPermissionGuide = false } = {}) {
    this.handlers.onRefreshDiagnostics();
    this.els.infoModal.hidden = false;
    if (scrollToPermissionGuide && this.els.permissionGuide) {
      requestAnimationFrame(() => {
        this.els.permissionGuide.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }

  closeInfoModal() {
    this.els.infoModal.hidden = true;
  }

  renderPermissionGuide(platform) {
    const container = this.els.permissionGuide;
    if (!container) return;

    const guides = [
      {
        id: 'ios',
        isCurrent: Boolean(platform?.isIOS),
        title: 'iPhone / iPad (iOS Safari)',
        steps: [
          'アドレスバー左側の「ぁあ」（またはサイト設定アイコン）をタップし、「Webサイトの設定」→「カメラ」を「許可」に変更すると次回から確認が省略されます。',
          '「ホーム画面に追加」した PWA として起動している場合、iOS の仕様上起動ごとに確認が表示されることがあります（省略したい場合は通常の Safari でご利用ください）。',
        ],
      },
      {
        id: 'android',
        isCurrent: Boolean(platform?.isAndroid),
        title: 'Android (Chrome)',
        steps: [
          'カメラ許可ダイアログで「今回のみ」ではなく「サイトにアクセスするたびに許可」を選択してください。',
          'あとから変更する場合はアドレスバー左のアイコン →「権限」→「カメラ」→「許可」に設定し直します。',
        ],
      },
      {
        id: 'desktop',
        isCurrent: Boolean(!platform?.isIOS && !platform?.isAndroid),
        title: 'PC ブラウザ (Chrome / Safari / Edge)',
        steps: [
          'アドレスバー左側のサイト情報アイコンから、カメラ権限を「許可（常に許可）」へ設定すると再読み込み時も維持されます。',
        ],
      },
    ];

    guides.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
    container.innerHTML = '';

    for (const g of guides) {
      const card = document.createElement('div');
      card.className = `perm-guide-card${g.isCurrent ? ' is-current' : ''}`;

      const h4 = document.createElement('h4');
      h4.className = 'perm-guide-title';
      h4.textContent = g.title;
      if (g.isCurrent) {
        const badge = document.createElement('span');
        badge.className = 'perm-guide-badge';
        badge.textContent = '現在の端末';
        h4.appendChild(badge);
      }
      card.appendChild(h4);

      const ol = document.createElement('ol');
      ol.className = 'perm-guide-steps';
      for (const text of g.steps) {
        const li = document.createElement('li');
        li.textContent = text;
        ol.appendChild(li);
      }
      card.appendChild(ol);
      container.appendChild(card);
    }
  }

  renderDiagnostics(entries) {
    const dl = this.els.diagnosticsList;
    dl.innerHTML = '';
    for (const [label, value] of entries) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }
  }
}
