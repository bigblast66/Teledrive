import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, DownloadCloud, Share2, AlertCircle, RefreshCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { TelegramFile } from '../../types';
import { isImageFile } from '../../utils';

interface MobilePreviewModalProps {
  file: TelegramFile;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  currentIndex?: number;
  totalItems?: number;
  nextFile?: TelegramFile | null;
  prevFile?: TelegramFile | null;
  activeFolderId: number | null;
  onDownload?: (file: TelegramFile) => void;
  onShare?: (file: TelegramFile) => void;
}

const previewCache = new Map<string, string>();
const pendingPrefetches = new Set<string>();

const getCacheKey = (fileId: number, folderId: number | null) => `${folderId ?? 'home'}:${fileId}`;

export function MobilePreviewModal({
  file,
  onClose,
  onNext,
  onPrev,
  currentIndex,
  totalItems,
  nextFile,
  prevFile,
  activeFolderId,
  onDownload,
  onShare,
}: MobilePreviewModalProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);

  // Zoom and pan state
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // Touch gesture tracking
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const touchCurrentRef = useRef<{ x: number; y: number } | null>(null);
  const lastTapRef = useRef<number>(0);
  const isDraggingRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });

  const latestReqIdRef = useRef(0);

  // Load preview data
  const loadPreview = useCallback(async (targetFile: TelegramFile) => {
    const key = getCacheKey(targetFile.id, activeFolderId);
    const reqId = ++latestReqIdRef.current;

    const cached = previewCache.get(key);
    if (cached) {
      if (reqId === latestReqIdRef.current) {
        setSrc(cached);
        setLoading(false);
        setError(null);
      }
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await invoke<string>('cmd_get_preview', {
        messageId: targetFile.id,
        folderId: activeFolderId,
      });

      if (reqId !== latestReqIdRef.current) return;

      if (result) {
        const resolvedSrc = result.startsWith('data:') ? result : convertFileSrc(result);
        setSrc(resolvedSrc);
        previewCache.set(key, resolvedSrc);
      } else {
        setError('Preview not available');
      }
    } catch (err) {
      if (reqId !== latestReqIdRef.current) return;
      setError(String(err));
    } finally {
      if (reqId === latestReqIdRef.current) {
        setLoading(false);
      }
    }
  }, [activeFolderId]);

  // Reset zoom & pan when file changes
  useEffect(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    loadPreview(file);
  }, [file, loadPreview]);

  // Prefetch adjacent images for instant swiping
  useEffect(() => {
    const toPrefetch = [nextFile, prevFile].filter(
      (f): f is TelegramFile => !!f && isImageFile(f.name)
    );

    toPrefetch.forEach((item) => {
      const key = getCacheKey(item.id, activeFolderId);
      if (previewCache.has(key) || pendingPrefetches.has(key)) return;

      pendingPrefetches.add(key);
      invoke<string>('cmd_get_preview', {
        messageId: item.id,
        folderId: activeFolderId,
      })
        .then((res) => {
          if (res) {
            const resolved = res.startsWith('data:') ? res : convertFileSrc(res);
            previewCache.set(key, resolved);
          }
        })
        .catch(() => {})
        .finally(() => {
          pendingPrefetches.delete(key);
        });
    });
  }, [nextFile, prevFile, activeFolderId]);

  // Touch handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
      touchCurrentRef.current = { x: t.clientX, y: t.clientY };
      panStartRef.current = { ...pan };
      isDraggingRef.current = true;
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDraggingRef.current || e.touches.length !== 1 || !touchStartRef.current) return;
    const t = e.touches[0];
    touchCurrentRef.current = { x: t.clientX, y: t.clientY };

    if (scale > 1) {
      // Pan image
      const dx = t.clientX - touchStartRef.current.x;
      const dy = t.clientY - touchStartRef.current.y;
      setPan({
        x: panStartRef.current.x + dx,
        y: panStartRef.current.y + dy,
      });
    }
  };

  const handleTouchEnd = () => {
    if (!touchStartRef.current || !touchCurrentRef.current) {
      isDraggingRef.current = false;
      return;
    }

    const start = touchStartRef.current;
    const end = touchCurrentRef.current;
    const duration = Date.now() - start.time;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dist = Math.hypot(dx, dy);

    isDraggingRef.current = false;
    touchStartRef.current = null;
    touchCurrentRef.current = null;

    // Check for tap (minimal movement & fast)
    if (dist < 10 && duration < 250) {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        // Double tap: toggle zoom
        lastTapRef.current = 0;
        setScale((prev) => {
          const next = prev === 1 ? 2.5 : 1;
          if (next === 1) setPan({ x: 0, y: 0 });
          return next;
        });
      } else {
        // Single tap: toggle UI chrome after a short delay to allow double-tap
        lastTapRef.current = now;
        setTimeout(() => {
          if (Date.now() - lastTapRef.current >= 280 && lastTapRef.current !== 0) {
            setShowControls((prev) => !prev);
          }
        }, 290);
      }
      return;
    }

    // Check for swipe gesture (only when not zoomed in)
    if (scale === 1 && Math.abs(dx) > 50 && Math.abs(dy) < 60 && duration < 500) {
      if (dx < 0 && onNext) {
        // Swiped left -> Next
        navigator.vibrate?.(10);
        onNext();
      } else if (dx > 0 && onPrev) {
        // Swiped right -> Previous
        navigator.vibrate?.(10);
        onPrev();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] bg-black flex flex-col justify-between select-none overflow-hidden touch-none"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Top Header Bar */}
      <div
        className={`absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 via-black/40 to-transparent transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{ paddingTop: 'calc(0.75rem + env(safe-area-inset-top, 0px))' }}
      >
        <button
          onClick={onClose}
          className="p-2 -ml-2 rounded-full text-white/90 active:bg-white/20 transition-all active:scale-95"
          aria-label="Back"
        >
          <ArrowLeft className="w-6 h-6" />
        </button>

        <div className="flex-1 mx-3 min-w-0 text-center">
          <p className="text-sm font-semibold text-white truncate drop-shadow-md">
            {file.name}
          </p>
          {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
            <p className="text-[11px] text-white/70 font-mono">
              {currentIndex + 1} of {totalItems}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1.5 -mr-1">
          {onShare && (
            <button
              onClick={() => onShare(file)}
              className="p-2 rounded-full text-white/90 active:bg-white/20 transition-all active:scale-95"
              aria-label="Share"
            >
              <Share2 className="w-5 h-5" />
            </button>
          )}
          {onDownload && (
            <button
              onClick={() => onDownload(file)}
              className="p-2 rounded-full text-white/90 active:bg-white/20 transition-all active:scale-95"
              aria-label="Download"
            >
              <DownloadCloud className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Main Preview Area */}
      <div className="flex-1 w-full h-full flex items-center justify-center overflow-hidden">
        {loading && (
          <div className="flex flex-col items-center gap-3 text-white">
            <div className="w-9 h-9 border-3 border-telegram-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-white/80 font-medium">Decrypting preview...</p>
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center max-w-xs text-center p-6 rounded-2xl bg-white/10 backdrop-blur-md border border-white/10 text-white gap-3 mx-4">
            <AlertCircle className="w-10 h-10 text-red-400" />
            <p className="text-sm font-bold text-red-300">Unable to preview file</p>
            <p className="text-xs text-white/70 break-words leading-relaxed">{error}</p>
            <div className="flex gap-2 mt-2 w-full">
              <button
                onClick={() => loadPreview(file)}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold bg-white/20 active:bg-white/30 text-white transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry
              </button>
              {onDownload && (
                <button
                  onClick={() => onDownload(file)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold bg-telegram-primary text-black transition-all"
                >
                  <DownloadCloud className="w-3.5 h-3.5" />
                  Download
                </button>
              )}
            </div>
          </div>
        )}

        {!loading && !error && src && (
          <div
            className="w-full h-full flex items-center justify-center transition-transform duration-100 ease-out"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            }}
          >
            <img
              src={src}
              alt={file.name}
              className="max-w-full max-h-full object-contain pointer-events-none"
              draggable={false}
              onError={() => setError('Failed to display preview image')}
            />
          </div>
        )}
      </div>

      {/* Bottom Information Footer */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-30 px-5 py-3 bg-gradient-to-t from-black/85 via-black/40 to-transparent flex items-center justify-between text-xs text-white/80 transition-opacity duration-300 ${
          showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
      >
        <span className="font-mono text-[11px] text-white/70">{file.sizeStr}</span>
        <span className="text-[11px] text-white/50">{file.created_at || 'Synchronized'}</span>
      </div>
    </div>
  );
}
