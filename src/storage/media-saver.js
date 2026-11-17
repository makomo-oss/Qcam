/**
 * OS-specific photo saving & sharing flow:
 * - Android Chrome / Desktop: direct storage download via <a download>
 * - iOS Safari: Web Share API (navigator.share with File) -> "Save Image" to Camera Roll,
 *   plus graceful fallback to preview long-press save or <a download>.
 */

export function buildPhotoFilename(date = new Date(), mode = 'standard') {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const suffix = mode === 'hq' ? '_HDR' : '';
  return `Qcam_${y}${m}${d}_${hh}${mm}${ss}${suffix}.jpg`;
}

export function triggerAnchorDownload(blobUrl, filename) {
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
  }, 150);
}

export async function shareOrSavePhoto(photo, platform, { preferShare = false } = {}) {
  const { blob, url, filename } = photo;
  const shouldUseWebShare =
    (preferShare || platform.preferWebShareSave) &&
    typeof navigator.share === 'function';

  if (shouldUseWebShare) {
    try {
      const file = new File([blob], filename, {
        type: 'image/jpeg',
        lastModified: Date.now(),
      });
      const canShareFile =
        typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] });

      if (canShareFile) {
        await navigator.share({
          files: [file],
          title: filename,
        });
        return { method: 'web-share', completed: true };
      }
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { method: 'web-share', completed: false, cancelled: true };
      }
      // If NotAllowedError (transient activation expired) or unsupported, fall through cleanly
      if (platform.isIOS) {
        return {
          method: 'ios-manual-hint',
          completed: false,
          reason: err?.name || 'share-failed',
        };
      }
    }
  }

  triggerAnchorDownload(url, filename);
  return { method: 'download', completed: true };
}
