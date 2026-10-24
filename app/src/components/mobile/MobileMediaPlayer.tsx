import { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft,
  DownloadCloud,
  Share2,
  AlertCircle,
  RefreshCw,
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Music,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  ExternalLink,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { TelegramFile } from '../../types';
import { isVideoFile, isAudioFile, formatBytes } from '../../utils';
import { thumbnailCache } from './TouchFileList';

interface MobileMediaPlayerProps {
  file: TelegramFile;
  activeFolderId: number | null;
  onClose: () => void;
  onDownload?: (file: TelegramFile) => void;
  onShare?: (file: TelegramFile) => void;
}

const mediaCache = new Map<string, { src: string; rawPath: string | null }>();

const getCacheKey = (fileId: number, folderId: number | null) => `${folderId ?? 'home'}:${fileId}`;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || isNaN(seconds) || seconds <= 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    case 'mkv':
      return 'video/x-matroska';
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'wav':
      return 'audio/wav';
    case 'flac':
      return 'audio/flac';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    default:
      return isVideoFile(filename) ? 'video/mp4' : 'audio/mpeg';
  }
}

export function MobileMediaPlayer({
  file,
  activeFolderId,
  onClose,
  onDownload,
  onShare,
}: MobileMediaPlayerProps) {
  const isVideo = isVideoFile(file.name);
  const isAudio = isAudioFile(file.name);

  const [src, setSrc] = useState<string | null>(null);
  const [rawPath, setRawPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOpeningNative, setIsOpeningNative] = useState(false);

  // Playback state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Video UI controls visibility & tap handling
  const [showControls, setShowControls] = useState(true);
  const hideControlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackAttemptedRef = useRef(false);
  const thumbnailSrc = thumbnailCache.get(file.id) || null;

  // Double-tap gesture state
  const lastTapTimeRef = useRef(0);
  const lastTapXRef = useRef(0);
  const [skipIndicator, setSkipIndicator] = useState<'left' | 'right' | null>(null);

  const resetControlsTimeout = useCallback(() => {
    if (hideControlsTimeoutRef.current) {
      clearTimeout(hideControlsTimeoutRef.current);
    }
    setShowControls(true);
    if (isPlaying) {
      hideControlsTimeoutRef.current = setTimeout(() => {
        setShowControls(false);
      }, 2200);
    }
  }, [isPlaying]);

  // Load media: tries on-demand chunk streaming first, falls back to preview cache if needed
  const loadMedia = useCallback(async () => {
    const key = getCacheKey(file.id, activeFolderId);
    const cached = mediaCache.get(key);

    if (cached) {
      setSrc(cached.src);
      setRawPath(cached.rawPath);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    fallbackAttemptedRef.current = false;

    // 1. Try on-demand chunk streaming via local loopback streaming server
    try {
      const streamInfo = await invoke<{ token: string; base_url: string }>('cmd_get_stream_info');
      if (streamInfo?.base_url && streamInfo?.token) {
        const folderParam = activeFolderId !== null ? activeFolderId.toString() : 'home';
        const streamUrl = `${streamInfo.base_url}/stream/${folderParam}/${file.id}?token=${streamInfo.token}`;
        setSrc(streamUrl);
        setRawPath(null);
        mediaCache.set(key, { src: streamUrl, rawPath: null });
        setLoading(false);
        return;
      }
    } catch {
      // Streaming info unavailable, proceed to preview cache download
    }

    // 2. Fallback to cache preview download
    try {
      const result = await invoke<string>('cmd_get_preview', {
        messageId: file.id,
        folderId: activeFolderId,
      });

      if (result) {
        if (result.startsWith('data:')) {
          setSrc(result);
          setRawPath(null);
          mediaCache.set(key, { src: result, rawPath: null });
        } else {
          // File path on disk
          setRawPath(result);
          const assetUrl = convertFileSrc(result);
          setSrc(assetUrl);
          mediaCache.set(key, { src: assetUrl, rawPath: result });
        }
      } else {
        setError('Media file is not available');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [file.id, activeFolderId]);

  useEffect(() => {
    loadMedia();
    return () => {
      if (hideControlsTimeoutRef.current) clearTimeout(hideControlsTimeoutRef.current);
    };
  }, [loadMedia]);

  // Fallback to in-memory Blob URL or cache preview if stream/asset throws an error in WebView
  const handleMediaError = useCallback(async () => {
    if (fallbackAttemptedRef.current) {
      setError('Unable to play directly in WebView. Open in your device video player.');
      return;
    }

    fallbackAttemptedRef.current = true;

    // If stream URL failed, fallback to cache preview download
    try {
      const result = await invoke<string>('cmd_get_preview', {
        messageId: file.id,
        folderId: activeFolderId,
      });
      if (result) {
        if (result.startsWith('data:')) {
          setSrc(result);
          setError(null);
          return;
        } else {
          setRawPath(result);
          // Try reading as blob
          try {
            const bytes = await invoke<number[]>('cmd_read_media_file', { path: result });
            if (bytes && bytes.length > 0) {
              const mime = getMimeType(file.name);
              const blob = new Blob([new Uint8Array(bytes)], { type: mime });
              const blobUrl = URL.createObjectURL(blob);
              setSrc(blobUrl);
              setError(null);
              return;
            }
          } catch {
            // Blob read failed
          }
        }
      }
    } catch {
      // Preview download failed
    }

    setError('Unable to decode video format in WebView. Please open with external player.');
  }, [file.id, file.name, activeFolderId]);

  // Launch native external app (VLC, MX Player, System Gallery, etc.)
  const handleOpenExternally = useCallback(async () => {
    setIsOpeningNative(true);
    try {
      if (src && (src.startsWith('http://') || src.startsWith('https://'))) {
        await invoke('cmd_open_file_externally', { path: src });
      } else {
        let targetPath = rawPath;
        if (!targetPath) {
          targetPath = await invoke<string>('cmd_get_preview', {
            messageId: file.id,
            folderId: activeFolderId,
          });
        }
        if (targetPath) {
          await invoke('cmd_open_file_externally', { path: targetPath });
        }
      }
    } catch (e) {
      setError(`Failed to open in external app: ${e}`);
    } finally {
      setIsOpeningNative(false);
    }
  }, [src, rawPath, file.id, activeFolderId]);

  // Capture video frame to create a persistent thumbnail in Grid view
  const handleVideoLoadedData = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;

    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 360 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);

      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        invoke('cmd_save_thumbnail', {
          messageId: file.id,
          folderId: activeFolderId,
          base64Data: dataUrl,
        }).catch(() => {});
      }
    } catch {
      // Best-effort thumbnail capture
    }
  }, [file.id, activeFolderId]);

  // Toggle play / pause
  const togglePlayPause = () => {
    navigator.vibrate?.(10);
    if (isVideo && videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play().catch(() => {});
        setIsPlaying(true);
      } else {
        videoRef.current.pause();
        setIsPlaying(false);
      }
    } else if (isAudio && audioRef.current) {
      if (audioRef.current.paused) {
        audioRef.current.play().catch(() => {});
        setIsPlaying(true);
      } else {
        audioRef.current.pause();
        setIsPlaying(false);
      }
    }
    resetControlsTimeout();
  };

  // Seek handler
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (isVideo && videoRef.current) {
      videoRef.current.currentTime = time;
    } else if (isAudio && audioRef.current) {
      audioRef.current.currentTime = time;
    }
    resetControlsTimeout();
  };

  // Skip relative seconds
  const handleSkip = (seconds: number) => {
    navigator.vibrate?.(10);
    const mediaEl = isVideo ? videoRef.current : audioRef.current;
    if (!mediaEl) return;
    const maxDur = Number.isFinite(duration) && duration > 0 ? duration : 999999;
    mediaEl.currentTime = Math.max(0, Math.min(maxDur, mediaEl.currentTime + seconds));
    resetControlsTimeout();
  };

  // Mute toggle
  const toggleMute = () => {
    navigator.vibrate?.(10);
    const mediaEl = isVideo ? videoRef.current : audioRef.current;
    if (!mediaEl) return;
    mediaEl.muted = !isMuted;
    setIsMuted(!isMuted);
    resetControlsTimeout();
  };

  // Fullscreen toggle for video
  const toggleFullscreen = () => {
    navigator.vibrate?.(10);
    const container = videoContainerRef.current;
    if (!container) return;

    if (!document.fullscreenElement) {
      container.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  };

  // Touch video tap / double-tap handling
  const handleVideoTouch = (e: React.MouseEvent<HTMLDivElement>) => {
    const now = Date.now();
    const rect = e.currentTarget.getBoundingClientRect();
    const touchX = e.clientX - rect.left;
    const isLeftHalf = touchX < rect.width / 2;

    if (now - lastTapTimeRef.current < 300 && Math.abs(touchX - lastTapXRef.current) < 80) {
      // Double-tap detected
      if (isLeftHalf) {
        handleSkip(-10);
        setSkipIndicator('left');
      } else {
        handleSkip(10);
        setSkipIndicator('right');
      }
      setTimeout(() => setSkipIndicator(null), 650);
      lastTapTimeRef.current = 0;
      return;
    }

    lastTapTimeRef.current = now;
    lastTapXRef.current = touchX;

    // Single tap toggles control bar
    setShowControls((prev) => !prev);
    if (!showControls) {
      resetControlsTimeout();
    }
  };

  return (
    <div
      ref={videoContainerRef}
      className="fixed inset-0 z-[200] bg-black flex flex-col justify-between select-none overflow-hidden touch-none"
    >
      {/* Top Header Bar */}
      <div
        className={`absolute top-0 left-0 right-0 z-50 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/90 via-black/50 to-transparent transition-opacity duration-300 ${
          isVideo ? (showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none') : 'opacity-100'
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
          <p className="text-[11px] text-white/60 font-mono">
            {file.sizeStr}
          </p>
        </div>

        <div className="flex items-center gap-1 -mr-1">
          <button
            onClick={handleOpenExternally}
            disabled={isOpeningNative}
            className="p-2 rounded-full text-white/90 active:bg-white/20 transition-all active:scale-95 flex items-center gap-1"
            title="Open in VLC / MX Player / System App"
            aria-label="Open with external player"
          >
            <ExternalLink className="w-5 h-5 text-telegram-primary" />
          </button>
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

      {/* Main Playback Center */}
      <div className="flex-1 w-full h-full flex items-center justify-center relative overflow-hidden">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden z-20">
            {thumbnailSrc && (
              <>
                <img
                  src={thumbnailSrc}
                  alt=""
                  className="w-full h-full object-contain filter blur-md opacity-60 scale-105 pointer-events-none"
                />
                <div className="absolute inset-0 overflow-hidden pointer-events-none">
                  <div className="w-full h-full bg-gradient-to-r from-transparent via-white/15 to-transparent animate-shimmer" />
                </div>
              </>
            )}
            <div className="relative px-5 py-3 rounded-full bg-black/70 backdrop-blur-md border border-white/15 flex items-center gap-3 text-white shadow-2xl">
              <div className="w-4 h-4 border-2 border-telegram-primary border-t-transparent rounded-full animate-spin flex-shrink-0" />
              <div className="flex flex-col text-left">
                <span className="text-xs font-semibold leading-tight">
                  {isVideo ? 'Loading video stream...' : 'Loading audio...'}
                </span>
                <span className="text-[10px] text-white/60 leading-tight">
                  Streaming on-demand
                </span>
              </div>
            </div>
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center max-w-xs text-center p-6 rounded-2xl bg-white/10 backdrop-blur-md border border-white/10 text-white gap-3 mx-4 z-20">
            <AlertCircle className="w-10 h-10 text-amber-400" />
            <p className="text-sm font-bold text-amber-300">Playback Note</p>
            <p className="text-xs text-white/70 break-words leading-relaxed">{error}</p>
            <div className="flex flex-col gap-2 mt-2 w-full">
              <button
                onClick={handleOpenExternally}
                disabled={isOpeningNative}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-xs font-bold bg-telegram-primary text-black transition-all active:scale-95 shadow-md shadow-telegram-primary/20"
              >
                <ExternalLink className="w-4 h-4" />
                {isOpeningNative ? 'Opening Player...' : 'Open in Phone Player'}
              </button>
              <button
                onClick={loadMedia}
                className="w-full flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold bg-white/15 active:bg-white/25 text-white transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry Web Player
              </button>
            </div>
          </div>
        )}

        {/* Video Mode */}
        {!loading && !error && src && isVideo && (
          <div
            onClick={handleVideoTouch}
            className="w-full h-full flex items-center justify-center bg-black relative cursor-pointer"
          >
            <video
              ref={videoRef}
              src={src}
              poster={thumbnailSrc || undefined}
              playsInline
              autoPlay
              onTimeUpdate={() => {
                if (videoRef.current) {
                  const ct = videoRef.current.currentTime;
                  if (Number.isFinite(ct) && !isNaN(ct)) setCurrentTime(ct);
                  const d = videoRef.current.duration;
                  if (Number.isFinite(d) && !isNaN(d) && d > 0 && d !== duration) setDuration(d);
                }
              }}
              onLoadedMetadata={() => {
                if (videoRef.current) {
                  const d = videoRef.current.duration;
                  if (Number.isFinite(d) && !isNaN(d) && d > 0) setDuration(d);
                }
              }}
              onDurationChange={() => {
                if (videoRef.current) {
                  const d = videoRef.current.duration;
                  if (Number.isFinite(d) && !isNaN(d) && d > 0) setDuration(d);
                }
              }}
              onLoadedData={handleVideoLoadedData}
              onError={handleMediaError}
              onEnded={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              className="w-full h-full object-contain pointer-events-none"
            />

            {/* Double Tap Skip Indicators */}
            {skipIndicator === 'left' && (
              <div className="absolute left-8 top-1/2 -translate-y-1/2 flex flex-col items-center justify-center w-20 h-20 rounded-full bg-black/60 backdrop-blur-md text-white animate-in zoom-in-75 duration-200">
                <RotateCcw className="w-7 h-7 text-telegram-primary" />
                <span className="text-[11px] font-bold mt-1">-10s</span>
              </div>
            )}
            {skipIndicator === 'right' && (
              <div className="absolute right-8 top-1/2 -translate-y-1/2 flex flex-col items-center justify-center w-20 h-20 rounded-full bg-black/60 backdrop-blur-md text-white animate-in zoom-in-75 duration-200">
                <RotateCw className="w-7 h-7 text-telegram-primary" />
                <span className="text-[11px] font-bold mt-1">+10s</span>
              </div>
            )}

            {/* Video Controls Overlay */}
            <div
              className={`absolute inset-0 flex flex-col justify-between pointer-events-none transition-opacity duration-300 ${
                showControls ? 'opacity-100' : 'opacity-0'
              }`}
            >
              <div className="w-full h-20 bg-gradient-to-b from-black/80 to-transparent pointer-events-none" />

              {/* Center Play/Pause Touch Target */}
              <div className="flex items-center justify-center pointer-events-auto">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlayPause();
                  }}
                  className="w-14 h-14 rounded-full bg-black/50 backdrop-blur-lg border border-white/20 flex items-center justify-center text-white active:scale-90 hover:scale-105 transition-all shadow-2xl"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <Pause className="w-7 h-7 fill-white" />
                  ) : (
                    <Play className="w-7 h-7 fill-white ml-0.5" />
                  )}
                </button>
              </div>

              {/* Bottom Video Scrubber & Toolbar */}
              <div
                onClick={(e) => e.stopPropagation()}
                className="w-full bg-gradient-to-t from-black/90 via-black/60 to-transparent px-4 pb-6 pt-4 pointer-events-auto flex flex-col gap-2"
                style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom, 0px))' }}
              >
                {/* Seek Slider */}
                <div className="flex items-center gap-3">
                  <span className="text-[11px] font-mono text-white/70 min-w-[2.5rem]">
                    {formatTime(currentTime)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Number.isFinite(duration) && duration > 0 ? duration : 100}
                    step={0.1}
                    value={Number.isFinite(currentTime) ? currentTime : 0}
                    disabled={!Number.isFinite(duration) || duration <= 0}
                    onChange={handleSeek}
                    className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-telegram-primary"
                  />
                  <span className="text-[11px] font-mono text-white/70 min-w-[2.5rem] text-right">
                    {Number.isFinite(duration) && duration > 0 ? formatTime(duration) : '--:--'}
                  </span>
                </div>

                {/* Sub-bar buttons */}
                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleSkip(-10)}
                      className="p-2 text-white/80 active:text-white active:scale-95 transition-all"
                      aria-label="Rewind 10 seconds"
                    >
                      <RotateCcw className="w-5 h-5" />
                    </button>
                    <button
                      onClick={() => handleSkip(10)}
                      className="p-2 text-white/80 active:text-white active:scale-95 transition-all"
                      aria-label="Forward 10 seconds"
                    >
                      <RotateCw className="w-5 h-5" />
                    </button>
                    <button
                      onClick={toggleMute}
                      className="p-2 text-white/80 active:text-white active:scale-95 transition-all"
                      aria-label={isMuted ? 'Unmute' : 'Mute'}
                    >
                      {isMuted ? (
                        <VolumeX className="w-5 h-5 text-red-400" />
                      ) : (
                        <Volume2 className="w-5 h-5" />
                      )}
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleOpenExternally}
                      className="text-[11px] font-medium text-telegram-primary bg-telegram-primary/10 border border-telegram-primary/20 px-2.5 py-1.5 rounded-lg flex items-center gap-1 active:scale-95 transition-all"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      Player
                    </button>
                    <button
                      onClick={toggleFullscreen}
                      className="p-2 text-white/80 active:text-white active:scale-95 transition-all"
                      aria-label={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
                    >
                      {isFullscreen ? (
                        <Minimize className="w-5 h-5" />
                      ) : (
                        <Maximize className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Audio Mode */}
        {!loading && !error && src && isAudio && (
          <div className="w-full h-full flex flex-col items-center justify-center px-6 relative">
            <audio
              ref={audioRef}
              src={src}
              autoPlay
              onTimeUpdate={() => {
                if (audioRef.current) {
                  const ct = audioRef.current.currentTime;
                  if (Number.isFinite(ct) && !isNaN(ct)) setCurrentTime(ct);
                  const d = audioRef.current.duration;
                  if (Number.isFinite(d) && !isNaN(d) && d > 0 && d !== duration) setDuration(d);
                }
              }}
              onLoadedMetadata={() => {
                if (audioRef.current) {
                  const d = audioRef.current.duration;
                  if (Number.isFinite(d) && !isNaN(d) && d > 0) setDuration(d);
                }
              }}
              onDurationChange={() => {
                if (audioRef.current) {
                  const d = audioRef.current.duration;
                  if (Number.isFinite(d) && !isNaN(d) && d > 0) setDuration(d);
                }
              }}
              onError={handleMediaError}
              onEnded={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />

            {/* Glowing Ambient Gradient */}
            <div className="absolute inset-0 bg-gradient-to-b from-telegram-primary/10 via-telegram-hover/5 to-black pointer-events-none" />

            {/* Vinyl Record Visualizer */}
            <div className="relative mb-8 z-10">
              <div
                className={`w-48 h-48 rounded-full bg-gradient-to-tr from-[#141424] to-[#252538] border-4 border-white/10 shadow-2xl flex items-center justify-center transition-transform duration-700 ${
                  isPlaying ? 'animate-[spin_6s_linear_infinite]' : ''
                }`}
              >
                <div className="w-36 h-36 rounded-full border border-white/5 flex items-center justify-center">
                  <div className="w-24 h-24 rounded-full border border-white/5 flex items-center justify-center">
                    <div className="w-16 h-16 rounded-full bg-telegram-primary/20 border border-telegram-primary/40 flex items-center justify-center shadow-inner">
                      <Music className="w-7 h-7 text-telegram-primary" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Audio Meta */}
            <div className="text-center max-w-xs mb-8 z-10">
              <h2 className="text-lg font-bold text-white truncate drop-shadow-md">
                {file.name}
              </h2>
              <p className="text-xs text-telegram-subtext mt-1">
                {file.created_at || 'Synchronized'} • {formatBytes(file.size)}
              </p>
            </div>

            {/* Audio Scrubber & Controls Card */}
            <div className="w-full max-w-sm bg-white/5 backdrop-blur-xl border border-white/10 rounded-3xl p-5 shadow-2xl z-10 flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <input
                  type="range"
                  min={0}
                  max={Number.isFinite(duration) && duration > 0 ? duration : 100}
                  step={0.1}
                  value={Number.isFinite(currentTime) ? currentTime : 0}
                  disabled={!Number.isFinite(duration) || duration <= 0}
                  onChange={handleSeek}
                  className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-telegram-primary"
                />
                <div className="flex justify-between text-[11px] font-mono text-white/60">
                  <span>{formatTime(currentTime)}</span>
                  <span>{Number.isFinite(duration) && duration > 0 ? formatTime(duration) : '--:--'}</span>
                </div>
              </div>

              {/* Playback Buttons */}
              <div className="flex items-center justify-between px-3">
                <button
                  onClick={toggleMute}
                  className="p-2.5 rounded-full text-white/70 active:text-white active:bg-white/10 transition-all"
                  aria-label={isMuted ? 'Unmute' : 'Mute'}
                >
                  {isMuted ? (
                    <VolumeX className="w-5 h-5 text-red-400" />
                  ) : (
                    <Volume2 className="w-5 h-5" />
                  )}
                </button>

                <button
                  onClick={() => handleSkip(-10)}
                  className="p-2.5 rounded-full text-white/80 active:text-white active:bg-white/10 transition-all active:scale-95"
                  aria-label="Skip backward 10 seconds"
                >
                  <RotateCcw className="w-5 h-5" />
                </button>

                <button
                  onClick={togglePlayPause}
                  className="w-14 h-14 rounded-full bg-telegram-primary text-black flex items-center justify-center shadow-lg shadow-telegram-primary/30 active:scale-90 transition-all"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <Pause className="w-6 h-6 fill-black" />
                  ) : (
                    <Play className="w-6 h-6 fill-black ml-0.5" />
                  )}
                </button>

                <button
                  onClick={() => handleSkip(10)}
                  className="p-2.5 rounded-full text-white/80 active:text-white active:bg-white/10 transition-all active:scale-95"
                  aria-label="Skip forward 10 seconds"
                >
                  <RotateCw className="w-5 h-5" />
                </button>

                <button
                  onClick={handleOpenExternally}
                  className="p-2.5 rounded-full text-white/70 active:text-white active:bg-white/10 transition-all"
                  title="Open in System Player"
                  aria-label="Open in external player"
                >
                  <ExternalLink className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
