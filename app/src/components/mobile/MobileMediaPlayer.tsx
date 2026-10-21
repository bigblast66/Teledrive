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
  Film,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { TelegramFile } from '../../types';
import { isVideoFile, isAudioFile, formatBytes } from '../../utils';

interface MobileMediaPlayerProps {
  file: TelegramFile;
  activeFolderId: number | null;
  onClose: () => void;
  onDownload?: (file: TelegramFile) => void;
  onShare?: (file: TelegramFile) => void;
}

const mediaCache = new Map<string, string>();

const getCacheKey = (fileId: number, folderId: number | null) => `${folderId ?? 'home'}:${fileId}`;

function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Audio playback state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);

  // Video element ref
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Load and decrypt media via preview cache
  const loadMedia = useCallback(async () => {
    const key = getCacheKey(file.id, activeFolderId);
    const cached = mediaCache.get(key);

    if (cached) {
      setSrc(cached);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const resultPath = await invoke<string>('cmd_get_preview', {
        messageId: file.id,
        folderId: activeFolderId,
      });

      if (resultPath) {
        const resolved = resultPath.startsWith('data:') ? resultPath : convertFileSrc(resultPath);
        setSrc(resolved);
        mediaCache.set(key, resolved);
      } else {
        setError('Media file not available');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [file.id, activeFolderId]);

  useEffect(() => {
    loadMedia();
  }, [loadMedia]);

  // Capture video frame to create a persistent thumbnail
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

  // Audio handlers
  const togglePlayPause = () => {
    const audio = audioRef.current;
    if (!audio) return;
    navigator.vibrate?.(10);
    if (audio.paused) {
      audio.play().catch(() => {});
      setIsPlaying(true);
    } else {
      audio.pause();
      setIsPlaying(false);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  };

  const handleSkip = (seconds: number) => {
    if (!audioRef.current) return;
    navigator.vibrate?.(10);
    audioRef.current.currentTime = Math.max(0, Math.min(duration, audioRef.current.currentTime + seconds));
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    audioRef.current.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  return (
    <div className="fixed inset-0 z-[200] bg-black flex flex-col justify-between select-none overflow-hidden touch-none">
      {/* Top Header Bar */}
      <div
        className="absolute top-0 left-0 right-0 z-40 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/85 via-black/40 to-transparent"
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

      {/* Main Content Area */}
      <div className="flex-1 w-full h-full flex items-center justify-center overflow-hidden">
        {loading && (
          <div className="flex flex-col items-center gap-4 text-white p-6 max-w-xs text-center">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-telegram-primary/10 border-2 border-telegram-primary/30 flex items-center justify-center animate-pulse">
                {isVideo ? <Film className="w-8 h-8 text-telegram-primary" /> : <Music className="w-8 h-8 text-telegram-primary" />}
              </div>
              <div className="absolute inset-0 rounded-full border-2 border-telegram-primary border-t-transparent animate-spin" />
            </div>
            <div>
              <p className="text-sm font-bold text-white">
                Preparing {isVideo ? 'video' : 'audio'}...
              </p>
              <p className="text-xs text-white/60 mt-1">
                Decrypting and buffering from Telegram
              </p>
            </div>
          </div>
        )}

        {error && !loading && (
          <div className="flex flex-col items-center max-w-xs text-center p-6 rounded-2xl bg-white/10 backdrop-blur-md border border-white/10 text-white gap-3 mx-4">
            <AlertCircle className="w-10 h-10 text-red-400" />
            <p className="text-sm font-bold text-red-300">Unable to play media</p>
            <p className="text-xs text-white/70 break-words leading-relaxed">{error}</p>
            <div className="flex gap-2 mt-2 w-full">
              <button
                onClick={loadMedia}
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

        {!loading && !error && src && isVideo && (
          <div className="w-full h-full flex items-center justify-center bg-black">
            <video
              ref={videoRef}
              src={src}
              controls
              autoPlay
              playsInline
              controlsList="nodownload"
              onLoadedData={handleVideoLoadedData}
              className="w-full h-full object-contain"
            />
          </div>
        )}

        {!loading && !error && src && isAudio && (
          <div className="w-full h-full flex flex-col items-center justify-center px-6 relative">
            <audio
              ref={audioRef}
              src={src}
              autoPlay
              onTimeUpdate={() => {
                if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
              }}
              onLoadedMetadata={() => {
                if (audioRef.current) setDuration(audioRef.current.duration);
              }}
              onEnded={() => setIsPlaying(false)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
            />

            {/* Glowing Ambient Background */}
            <div className="absolute inset-0 bg-gradient-to-b from-telegram-primary/10 via-telegram-hover/5 to-black pointer-events-none" />

            {/* Vinyl Record / Album Art Visualizer */}
            <div className="relative mb-8 z-10">
              <div
                className={`w-48 h-48 rounded-full bg-gradient-to-tr from-[#1a1a2e] to-[#252538] border-4 border-white/10 shadow-2xl flex items-center justify-center transition-transform duration-700 ${
                  isPlaying ? 'animate-[spin_6s_linear_infinite]' : ''
                }`}
              >
                {/* Grooves */}
                <div className="w-36 h-36 rounded-full border border-white/5 flex items-center justify-center">
                  <div className="w-24 h-24 rounded-full border border-white/5 flex items-center justify-center">
                    {/* Vinyl Center Sticker */}
                    <div className="w-16 h-16 rounded-full bg-telegram-primary/20 border border-telegram-primary/40 flex items-center justify-center shadow-inner">
                      <Music className="w-7 h-7 text-telegram-primary" />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Song Meta */}
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
              {/* Progress Slider */}
              <div className="flex flex-col gap-1.5">
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  step={0.1}
                  value={currentTime}
                  onChange={handleSeek}
                  className="w-full h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-telegram-primary"
                />
                <div className="flex justify-between text-[11px] font-mono text-white/60">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>

              {/* Main Playback Buttons */}
              <div className="flex items-center justify-between px-3">
                <button
                  onClick={toggleMute}
                  className="p-2.5 rounded-full text-white/70 active:text-white active:bg-white/10 transition-all"
                  aria-label={isMuted ? 'Unmute' : 'Mute'}
                >
                  {isMuted ? <VolumeX className="w-5 h-5 text-red-400" /> : <Volume2 className="w-5 h-5" />}
                </button>

                <button
                  onClick={() => handleSkip(-10)}
                  className="p-2.5 rounded-full text-white/80 active:text-white active:bg-white/10 transition-all active:scale-95"
                  aria-label="Skip backward 10 seconds"
                >
                  <RotateCcw className="w-5 h-5" />
                </button>

                {/* Big Center Play/Pause */}
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

                <div className="w-10" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
