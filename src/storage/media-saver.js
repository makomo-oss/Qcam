/**
 * OS-specific photo saving & sharing flow:
 * - Android Chrome / Desktop: direct storage download via <a download>
 * - iOS Safari: Web Share API (navigator.share with File) -> "Save Image" to Camera Roll,
 *   plus graceful fallback to preview long-press save or <a download>.
 */

export function buildPhotoFilename(date = new Date(), mode = 'hq', format = 'avif') {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const hh = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const suffix = mode === 'hq' ? '_HDR' : '';
  const ext = format === 'jpeg' ? 'jpg' : 'avif';
  return `Qcam_${y}${m}${d}_${hh}${mm}${ss}${suffix}.${ext}`;
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

let shareInFlight = false;

export async function shareOrSavePhoto(
  photo,
  platform,
  { preferShare = false, forceDownload = false } = {}
) {
  const { blob, url, filename } = photo;

  if (forceDownload) {
    triggerAnchorDownload(url, filename);
    return { method: 'download', completed: true };
  }

  const isIOS = Boolean(platform?.isIOS);
  const shouldUseWebShare =
    (preferShare || Boolean(platform?.preferWebShareSave) || isIOS) &&
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function';

  let shareUnavailableReason = 'web-share-unavailable';

  if (shouldUseWebShare) {
    if (shareInFlight) {
      return { method: 'web-share', completed: false, busy: true };
    }
    try {
      const mimeType =
        photo.mimeType ||
        blob?.type ||
        (/\.jpe?g$/i.test(filename || '') ? 'image/jpeg' : 'image/avif');
      const file = new File([blob], filename, {
        type: mimeType,
        lastModified: Date.now(),
      });
      // Pass strictly { files } on iOS/mobile: adding title/text can break Share Sheet actions
      const shareData = { files: [file] };
      const canShareFile =
        typeof navigator.canShare !== 'function' || navigator.canShare(shareData);

      if (canShareFile) {
        shareInFlight = true;
        await navigator.share(shareData);
        return { method: 'web-share', completed: true };
      }
      shareUnavailableReason = 'share-file-unsupported';
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { method: 'web-share', completed: false, cancelled: true };
      }
      if (isIOS) {
        return {
          method: 'ios-manual-hint',
          completed: false,
          gestureExpired: err?.name === 'NotAllowedError',
          reason: err?.name || 'share-failed',
        };
      }
    } finally {
      shareInFlight = false;
    }
  }

  // On iOS PWA / fallback, <a download> cannot target the Photos library and may fail inside standalone PWAs.
  // Surface manual save guidance (Share Sheet "Save to Files" for .avif, or Photos save) unless forceDownload was chosen.
  if (isIOS) {
    return {
      method: 'ios-manual-hint',
      completed: false,
      gestureExpired: false,
      reason: shareUnavailableReason,
    };
  }

  triggerAnchorDownload(url, filename);
  return { method: 'download', completed: true };
}
