import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  Folder, Download, Menu, LogOut, RefreshCw, UploadCloud, MoreVertical, Trash2, Pencil,
  Globe, Shield, Lock, ChevronDown, Share2, Link, Copy, Check, X, Loader2, Wifi, Activity,
  Zap, Eye, EyeOff, RotateCcw, Search, Plus, FolderPlus, ArrowLeft, Image as ImageIcon,
  Video, FileText, Music, Archive, CheckCircle2
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { listen } from '@tauri-apps/api/event';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BottomNavBar } from './BottomNavBar';
import { TouchFileList } from './TouchFileList';
import { ThemeToggle } from '../shared/ThemeToggle';
import { ActionPopover, ActionItem } from './ActionPopover';
import { ShareDialog } from '../desktop/dashboard/ShareDialog';
import { RenameFolderSheet } from './RenameFolderSheet';
import { usePlatform } from '../../hooks/usePlatform';
import { useTelegramConnection } from '../../hooks/useTelegramConnection';
import { useFileUpload } from '../../hooks/useFileUpload';
import { useFileDownload } from '../../hooks/useFileDownload';
import { useFileOperations } from '../../hooks/useFileOperations';
import {
  formatBytes, isMediaFile, isPdfFile, isImageFile, isTextFile,
  isVideoFile, isAudioFile, isArchiveFile,
  nativeShareOrCopy, copyToClipboard
} from '../../utils';
import { MobileMediaPlayer } from './MobileMediaPlayer';
import { PdfViewer } from '../desktop/dashboard/PdfViewer';
import { MobilePreviewModal } from './MobilePreviewModal';
import { TextViewer } from '../desktop/dashboard/TextViewer';
import { TelegramFile, TelegramFolder, ShareInfo, BandwidthStats } from '../../types';
import { useSettings } from '../../context/SettingsContext';
import { version as appVersion } from '../../../package.json';
import { LANGUAGES } from '../../i18n/languages';
import { useTranslation } from 'react-i18next';

export default function MobileDashboard({ onLogout }: { onLogout?: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'files' | 'downloads' | 'settings'>('files');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const mainScrollRef = useRef<HTMLElement>(null);
  const { isAndroid } = usePlatform();
  const { settings, updateSetting } = useSettings();

  // ── Android permissions request on mount ────────────────────────────
  useEffect(() => {
    if (!isAndroid) return;
    invoke('cmd_request_android_permissions').catch((err) => {
      console.warn('[Permissions] Failed to request permissions:', err);
    });
  }, [isAndroid]);

  // ── Android deep-link listener (https://t.me/ links) ──────────────────
  useEffect(() => {
    if (!isAndroid) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await onOpenUrl((urls) => {
          if (urls.length > 0) {
            const url = urls[0];
            toast.success(`Telegram link received: ${url}`, { duration: 5000 });
          }
        });
      } catch (e) {
        console.warn('[DeepLink] Failed to register listener:', e);
      }
    })();
    return () => { unlisten?.(); };
  }, [isAndroid]);

  // ── Android share-received listener (warm start) ──────────────────────
  useEffect(() => {
    if (!isAndroid) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listen<{ count: number }>('share-received', (event) => {
          const count = event.payload?.count ?? 0;
          if (count > 0) {
            const label = count === 1 ? '1 file' : `${count} files`;
            toast.success(`${label} received! Ready to upload.`, { duration: 4000 });
          }
        });
      } catch (e) {
        console.warn('[Share] Failed to register listener:', e);
      }
    })();
    return () => { unlisten?.(); };
  }, [isAndroid]);

  // ── Android cold-start share check ────────────────────────────────────
  useEffect(() => {
    if (!isAndroid) return;
    (async () => {
      try {
        const count = await invoke<number>('cmd_get_pending_share_count');
        if (count > 0) {
          const label = count === 1 ? '1 file' : `${count} files`;
          toast.success(`${label} received! Ready to upload.`, { duration: 4000 });
        }
      } catch (e) {
        // Best-effort; JNI cache may not be ready on very early mount
        console.warn('[Share] Cold-start check failed (may be expected):', e);
      }
    })();
  }, [isAndroid]);

  // Sync proxy settings to backend whenever they change
  useEffect(() => {
    const applyProxy = async () => {
      try {
        await invoke('cmd_apply_proxy_settings', {
          enabled: settings.proxyEnabled,
          proxyType: settings.proxyType,
          host: settings.proxyHost,
          port: settings.proxyPort,
          username: settings.proxyUsername,
          password: settings.proxyPassword,
        });
      } catch {
        // best-effort sync
      }
    };
    applyProxy();
  }, [
    settings.proxyEnabled, settings.proxyType, settings.proxyHost,
    settings.proxyPort, settings.proxyUsername, settings.proxyPassword,
  ]);

  const logoutHandler = useMemo(() => onLogout || (() => {}), [onLogout]);

  const {
    store, folders, activeFolderId, setActiveFolderId, isSyncing, isConnected,
    handleLogout, handleSyncFolders, handleCreateFolder, handleFolderDelete,
    handleFolderRename, handleFolderToggleVisibility, handleExportFolderInvite
  } = useTelegramConnection(logoutHandler);

  const {
    uploadQueue,
    handleManualUpload,
    clearFinished: clearUploads,
    cancelAll: cancelUploads,
    cancelItem: cancelUploadItem,
    retryItem: retryUploadItem,
  } = useFileUpload(activeFolderId, store);

  const {
    downloadQueue,
    queueDownload,
    queueBulkDownload,
    clearFinished: clearDownloads,
    cancelAll: cancelDownloads,
    cancelItem: cancelDownloadItem,
    retryItem: retryDownloadItem,
  } = useFileDownload(store);

  const [transfersFilter, setTransfersFilter] = useState<'all' | 'uploads' | 'downloads'>('all');

  const activeUploadsCount = useMemo(() =>
    uploadQueue.filter(i => i.status === 'uploading' || i.status === 'pending' || i.status === 'downloading').length,
    [uploadQueue]
  );
  const activeDownloadsCount = useMemo(() =>
    downloadQueue.filter(i => i.status === 'downloading' || i.status === 'pending').length,
    [downloadQueue]
  );
  const totalActiveTransfers = activeUploadsCount + activeDownloadsCount;

  const [playingFile, setPlayingFile] = useState<TelegramFile | null>(null);
  const [pdfFile, setPdfFile] = useState<TelegramFile | null>(null);
  const [previewFile, setPreviewFile] = useState<TelegramFile | null>(null);
  const [textFile, setTextFile] = useState<TelegramFile | null>(null);
  const [shareFile, setShareFile] = useState<TelegramFile | null>(null);
  const [bulkShareLinks, setBulkShareLinks] = useState<Array<{ file: TelegramFile; link: string }> | null>(null);
  const [bulkShareLoading, setBulkShareLoading] = useState(false);
  const [bulkShareCopied, setBulkShareCopied] = useState<Set<string>>(new Set());
  const [uploadingCacheFiles, setUploadingCacheFiles] = useState<Set<string>>(new Set());
  const transferIdCounter = useRef(0);

  // ── Connection diagnostics state ──────────────────────────────────────
  const [checkingLatency, setCheckingLatency] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  const { data: bandwidth } = useQuery({
    queryKey: ['bandwidth'],
    queryFn: () => invoke<BandwidthStats>('cmd_get_bandwidth'),
    refetchInterval: activeTab === 'settings' ? 5000 : false,
  });

  const handleCheckLatency = useCallback(async () => {
    setCheckingLatency(true);
    setLatencyMs(null);
    toast.loading('Checking latency to Telegram DC...', { id: 'ping-check' });
    try {
      const ms = await invoke<number>('cmd_check_latency');
      setLatencyMs(ms);
      if (ms >= 0) {
        const emoji = ms < 100 ? '🟢' : ms < 250 ? '🟡' : '🔴';
        toast.success(`${emoji} Ping: ${ms}ms to Telegram DC`, { id: 'ping-check' });
      } else {
        toast.error('Unable to reach Telegram servers', { id: 'ping-check' });
      }
    } catch (e) {
      console.warn('Ping check failed:', e);
      toast.error('Unable to reach Telegram servers', { id: 'ping-check' });
      setLatencyMs(-1);
    } finally {
      setCheckingLatency(false);
    }
  }, []);


  // ── Android cached shared files ───────────────────────────────────────
  interface CachedFileEntry {
    uri: string;
    cached_path: string;
    file_name: string;
    file_size: number;
  }

  const { data: cachedFiles = [], refetch: refetchCachedFiles } = useQuery({
    queryKey: ['cached-files'],
    queryFn: () => invoke<CachedFileEntry[]>('cmd_list_cached_files'),
    enabled: isAndroid,
    refetchInterval: isAndroid ? 5000 : false, // poll while app is open (lightweight)
  });

  const handleUploadCachedFile = useCallback(async (entry: CachedFileEntry) => {
    const tid = `cache-upload-${++transferIdCounter.current}-${Date.now()}`;
    setUploadingCacheFiles(prev => new Set(prev).add(entry.cached_path));
    try {
      await invoke<string>('cmd_upload_file', {
        path: entry.cached_path,
        folderId: activeFolderId,
        transferId: tid,
      });
      toast.success(`Uploaded: ${entry.file_name}`);
      // Refresh the list to remove the uploaded entry
      refetchCachedFiles();
    } catch (e) {
      toast.error(`Upload failed: ${e}`);
    } finally {
      setUploadingCacheFiles(prev => {
        const next = new Set(prev);
        next.delete(entry.cached_path);
        return next;
      });
    }
  }, [activeFolderId, refetchCachedFiles]);

  const handleClearCachedFiles = useCallback(async () => {
    try {
      await Promise.all(cachedFiles.map(entry =>
        invoke('cmd_remove_cached_path', { uri: entry.uri }).catch(() => {})
      ));
      refetchCachedFiles();
      toast.success('Shared files cleared');
    } catch (e) {
      toast.error(`Failed to clear: ${e}`);
    }
  }, [cachedFiles, refetchCachedFiles]);

  // Real files loader
  const { data: allFiles = [], isLoading } = useQuery({
    queryKey: ['files', activeFolderId],
    queryFn: async () => {
      const seen = new Map<number, any>(); // dedup by file id — matches desktop's loader
      queryClient.setQueryData(['files', activeFolderId], []);

      const unlisten = await listen<any>('folder-load-chunk', (event) => {
        const payload = event.payload;
        if (payload.folderId === activeFolderId) {
          const newChunk = payload.files.map((f: any) => ({
            ...f,
            sizeStr: formatBytes(f.size),
            type: f.icon_type || (f.name.endsWith('/') ? 'folder' : 'file')
          }));
          for (const file of newChunk) {
            seen.set(file.id, file); // overwrite instead of duplicate
          }
          queryClient.setQueryData(['files', activeFolderId], Array.from(seen.values()));
        }
      });

      try {
        await invoke('cmd_get_files', { folderId: activeFolderId });
        return Array.from(seen.values());
      } finally {
        unlisten();
      }
    },
    enabled: !!store,
  });

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [fileRenames, setFileRenames] = useState<Map<number, string>>(new Map());
  const { handleDelete: handleDeleteOp, handleBulkDelete, handleBulkDownload, handleBulkMove } = useFileOperations(activeFolderId, selectedIds, setSelectedIds, allFiles, queueBulkDownload);

  const activeFolder = activeFolderId === null
    ? 'My Drive'
    : folders.find(f => f.id === activeFolderId)?.name || 'Unknown Channel';

  // Folder action menu state (replaces swipe-to-reveal)
  const [folderActionMenu, setFolderActionMenu] = useState<TelegramFolder | null>(null);
  const [renameFolder, setRenameFolder] = useState<{ id: number; name: string } | null>(null);

  // Switching folders must never leave stale selection/preview state behind —
  // otherwise "N selected" + bulk actions can silently target file IDs that
  // belonged to the folder you just navigated away from. Desktop already
  // does this (see DesktopDashboard's activeFolderId effect); mobile needs
  // the same reset.
  useEffect(() => {
    setSelectedIds([]);
    setPlayingFile(null);
    setPdfFile(null);
    setPreviewFile(null);
    setShareFile(null);
  }, [activeFolderId]);

  type CategoryFilter = 'all' | 'videos' | 'photos' | 'docs' | 'audio' | 'archives';
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showFabSheet, setShowFabSheet] = useState(false);

  // ── Android Back Button & Edge Swipe Gesture Interception ─────────────
  const backHandlerStateRef = useRef({
    playingFile,
    previewFile,
    pdfFile,
    textFile,
    shareFile,
    bulkShareLinks,
    renameFolder,
    folderActionMenu,
    showFabSheet,
    isSidebarOpen,
    selectedIds,
    searchQuery,
    categoryFilter,
    activeFolderId,
    activeTab,
  });

  useEffect(() => {
    backHandlerStateRef.current = {
      playingFile,
      previewFile,
      pdfFile,
      textFile,
      shareFile,
      bulkShareLinks,
      renameFolder,
      folderActionMenu,
      showFabSheet,
      isSidebarOpen,
      selectedIds,
      searchQuery,
      categoryFilter,
      activeFolderId,
      activeTab,
    };
  });

  useEffect(() => {
    (window as any).__handleAndroidBack = () => {
      const s = backHandlerStateRef.current;
      if (s.playingFile) {
        setPlayingFile(null);
        return true;
      }
      if (s.previewFile) {
        setPreviewFile(null);
        return true;
      }
      if (s.pdfFile) {
        setPdfFile(null);
        return true;
      }
      if (s.textFile) {
        setTextFile(null);
        return true;
      }
      if (s.shareFile) {
        setShareFile(null);
        return true;
      }
      if (s.bulkShareLinks) {
        setBulkShareLinks(null);
        return true;
      }
      if (s.renameFolder) {
        setRenameFolder(null);
        return true;
      }
      if (s.folderActionMenu) {
        setFolderActionMenu(null);
        return true;
      }
      if (s.showFabSheet) {
        setShowFabSheet(false);
        return true;
      }
      if (s.isSidebarOpen) {
        setIsSidebarOpen(false);
        return true;
      }
      if (s.selectedIds.length > 0) {
        setSelectedIds([]);
        return true;
      }
      if (s.searchQuery.trim().length > 0) {
        setSearchQuery('');
        return true;
      }
      if (s.categoryFilter !== 'all') {
        setCategoryFilter('all');
        return true;
      }
      if (s.activeFolderId !== null) {
        setActiveFolderId(null);
        return true;
      }
      if (s.activeTab !== 'files') {
        setActiveTab('files');
        return true;
      }
      return false; // Root screen with nothing active: allow default Android back action
    };

    return () => {
      delete (window as any).__handleAndroidBack;
    };
  }, [setActiveFolderId, setActiveTab]);

  const handleFolderVisibilityToggle = useCallback(async (folder: TelegramFolder) => {
    const isPublic = folder.is_public || !!folder.username;
    if (isPublic) {
      // Make private
      try {
        await handleFolderToggleVisibility(folder.id, false);
      } catch { /* error already toasted */ }
    } else {
      // Make public — prompt for optional username
      const defaultUsername = folder.name.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
      const username = prompt(`Make "${folder.name}" public. Enter a username (leave empty for auto-generated):`, defaultUsername)?.trim();
      if (username === undefined) return; // cancelled
      try {
        await handleFolderToggleVisibility(folder.id, true, username || undefined);
      } catch { /* error already toasted */ }
    }
  }, [handleFolderToggleVisibility]);

  const handleFolderShareInvite = useCallback(async (folder: TelegramFolder) => {
    try {
      const info = await handleExportFolderInvite(folder.id);
      try {
        await copyToClipboard(info.link);
        toast.success(`Invite link copied: ${info.link}`);
      } catch (e) {
        toast.error(`Failed to copy to clipboard: ${e}`);
      }
    } catch { /* backend error already toasted in hook */ }
  }, [handleExportFolderInvite]);

  const buildFolderActions = useCallback((folder: TelegramFolder): ActionItem[] => {
    const isPublic = folder.is_public || !!folder.username;
    return [
      {
        label: 'Rename',
        icon: <Pencil className="w-4 h-4" />,
        onClick: () => {
          setFolderActionMenu(null);
          setRenameFolder({ id: folder.id, name: folder.name });
        },
      },
      {
        label: isPublic ? 'Make Private' : 'Make Public',
        icon: isPublic ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />,
        onClick: () => handleFolderVisibilityToggle(folder),
      },
      {
        label: 'Copy Invite Link',
        icon: <Link className="w-4 h-4" />,
        onClick: () => handleFolderShareInvite(folder),
      },
      {
        label: 'Delete',
        icon: <Trash2 className="w-4 h-4" />,
        onClick: () => handleFolderDelete(folder.id, folder.name),
        destructive: true,
      },
    ];
  }, [handleFolderDelete, handleFolderVisibilityToggle, handleFolderShareInvite]);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.length === allFiles.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(allFiles.map(f => f.id));
    }
  }, [selectedIds.length, allFiles]);

  const handleClearSelection = useCallback(() => setSelectedIds([]), []);

  const handleToggleSelection = useCallback((id: number) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
  }, []);

  const handleDownload = useCallback((file: TelegramFile) => {
    queueDownload(file.id, file.name, activeFolderId);
  }, [queueDownload, activeFolderId]);

  const handleDeleteFile = useCallback((file: TelegramFile) => {
    handleDeleteOp(file.id);
  }, [handleDeleteOp]);

  const handlePreview = useCallback((file: TelegramFile) => {
    if (isMediaFile(file.name)) {
      setPlayingFile(file);
    } else if (isPdfFile(file.name)) {
      setPdfFile(file);
    } else if (isImageFile(file.name)) {
      setPreviewFile(file);
    } else if (isTextFile(file.name)) {
      setTextFile(file);
    } else {
      toast.info(`Preview not supported for ${file.name}`);
    }
  }, []);

  // Mobile preview navigation context
  const previewContextFiles = useMemo(() => {
    return allFiles.filter(f => f.type !== 'folder' && isImageFile(f.name));
  }, [allFiles]);

  const previewContextIndex = useMemo(() => {
    if (!previewFile) return -1;
    return previewContextFiles.findIndex(f => f.id === previewFile.id);
  }, [previewFile, previewContextFiles]);

  const previewNeighbors = useMemo(() => {
    if (previewContextIndex === -1) return { prevFile: null, nextFile: null };
    return {
      prevFile: previewContextIndex > 0 ? previewContextFiles[previewContextIndex - 1] : null,
      nextFile: previewContextIndex < previewContextFiles.length - 1 ? previewContextFiles[previewContextIndex + 1] : null,
    };
  }, [previewContextIndex, previewContextFiles]);

  const handleNextPreview = useCallback(() => {
    if (previewNeighbors.nextFile) setPreviewFile(previewNeighbors.nextFile);
  }, [previewNeighbors.nextFile]);

  const handlePrevPreview = useCallback(() => {
    if (previewNeighbors.prevFile) setPreviewFile(previewNeighbors.prevFile);
  }, [previewNeighbors.prevFile]);

  const handleRenameFile = useCallback((file: TelegramFile) => {
    const currentName = fileRenames.get(file.id) || file.name;
    const newName = prompt(`Rename "${currentName}":`, currentName);
    if (!newName || !newName.trim() || newName.trim() === currentName) return;
    setFileRenames(prev => {
      const next = new Map(prev);
      next.set(file.id, newName.trim());
      return next;
    });
    toast.success(`Renamed to "${newName.trim()}"`);
  }, [fileRenames]);

  // Bulk share: generate links for all selected non-folder files
  const handleBulkShare = useCallback(async () => {
    const shareFiles = allFiles.filter(f => selectedIds.includes(f.id) && f.type !== 'folder');
    if (shareFiles.length === 0) {
      toast.info('No shareable files selected (folders cannot be shared)');
      return;
    }
    // Open modal immediately with spinner
    setBulkShareLinks([]);
    setBulkShareLoading(true);
    setBulkShareCopied(new Set());
    try {
      const results = await Promise.all(
        shareFiles.map(async (file) => {
          try {
            const info = await invoke<ShareInfo>('cmd_create_share', {
              folderId: null,
              messageId: file.id,
              fileName: file.name,
              fileSize: file.size,
              password: null,
              expiryHours: 24, // default 1 day
            });
            return { file, link: info.link };
          } catch (e) {
            toast.error(`Failed to share ${file.name}: ${e}`);
            return null;
          }
        })
      );
      const valid = results.filter((r): r is { file: TelegramFile; link: string } => r !== null);
      if (valid.length > 0) {
        setBulkShareLinks(valid);
        setSelectedIds([]); // Clear selection after successful bulk share
      } else {
        setBulkShareLinks(null);
        toast.error('Failed to generate any share links');
      }
    } finally {
      setBulkShareLoading(false);
    }
  }, [allFiles, selectedIds]);

  const handleCopyBulkLink = useCallback((link: string) => {
    navigator.clipboard.writeText(link);
    setBulkShareCopied(prev => new Set(prev).add(link));
    setTimeout(() => setBulkShareCopied(prev => {
      const next = new Set(prev);
      next.delete(link);
      return next;
    }), 2000);
  }, []);

  const handleNativeShareBulkLink = useCallback((file: TelegramFile, link: string) => {
    nativeShareOrCopy(file.name, file.sizeStr, link, () => {
      handleCopyBulkLink(link);
    });
  }, [handleCopyBulkLink]);

  // ── Copy Telegram native t.me link ────────────────────────────────────
  const handleCopyTelegramLink = useCallback((file: TelegramFile) => {
    const folder = folders.find(f => f.id === file.folder_id) || folders.find(f => f.id === activeFolderId);
    const username = folder?.username || (folder as any)?.chat?.username || (folder as any)?.channel?.username;
    if (!username) {
      toast.error('Only available for public channels');
      return;
    }
    const url = `https://t.me/${username}/${file.id}`;
    navigator.clipboard.writeText(url).then(() => {
      toast.success('Telegram link copied');
    }).catch(() => {
      toast.error('Failed to copy link');
    });
  }, [folders, activeFolderId]);

  const displayFiles = useMemo(() => {
    let files = allFiles;
    if (fileRenames.size > 0) {
      files = files.map(f =>
        fileRenames.has(f.id) ? { ...f, name: fileRenames.get(f.id)! } : f
      );
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      files = files.filter(f => f.name.toLowerCase().includes(q));
    }
    if (categoryFilter !== 'all') {
      files = files.filter(f => {
        if (f.type === 'folder') return false;
        switch (categoryFilter) {
          case 'videos': return isVideoFile(f.name);
          case 'photos': return isImageFile(f.name);
          case 'docs': return isPdfFile(f.name) || isTextFile(f.name) || /\.(docx?|xlsx?|pptx?|epub|odt)$/i.test(f.name);
          case 'audio': return isAudioFile(f.name);
          case 'archives': return isArchiveFile(f.name);
          default: return true;
        }
      });
    }
    return files;
  }, [allFiles, fileRenames, searchQuery, categoryFilter]);

  return (
    <div className="absolute inset-0 flex flex-col bg-telegram-bg text-telegram-text overflow-hidden select-none font-sans">
      {/* Google Drive Floating Search Bar & Header */}
      <header className="px-4 pt-[calc(0.75rem+env(safe-area-inset-top,24px))] pb-2.5 sticky top-0 z-40 bg-telegram-bg/95 backdrop-blur-md border-b border-telegram-border/20">
        <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-2xl bg-white dark:bg-telegram-surface border border-black/10 dark:border-white/10 shadow-sm transition-all focus-within:border-telegram-primary/60 focus-within:ring-1 focus-within:ring-telegram-primary/30">
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="p-1 rounded-xl text-telegram-subtext hover:text-telegram-text transition-colors active:scale-95"
            aria-label="Open navigation drawer"
          >
            <Menu className="w-5 h-5" />
          </button>

          <div className="flex-1 flex items-center gap-2 min-w-0">
            <Search className="w-4 h-4 text-telegram-subtext/70 flex-shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search in ${activeFolderId === null ? 'My Drive' : activeFolder}...`}
              className="w-full bg-transparent border-none text-xs sm:text-sm text-telegram-text placeholder:text-telegram-subtext/70 focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="p-0.5 rounded-full text-telegram-subtext hover:text-telegram-text"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <ThemeToggle />
            <button
              onClick={handleSyncFolders}
              disabled={isSyncing}
              className="p-1.5 rounded-xl text-telegram-subtext hover:text-telegram-primary active:scale-95 transition-all disabled:opacity-50"
              title="Sync Drive"
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Google Drive Category Chips (only in Files view) */}
        {activeTab === 'files' && (
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pt-2.5">
            {[
              { id: 'all' as const, label: 'All' },
              { id: 'videos' as const, label: 'Videos', icon: <Video className="w-3 h-3" /> },
              { id: 'photos' as const, label: 'Photos', icon: <ImageIcon className="w-3 h-3" /> },
              { id: 'docs' as const, label: 'Docs', icon: <FileText className="w-3 h-3" /> },
              { id: 'audio' as const, label: 'Audio', icon: <Music className="w-3 h-3" /> },
              { id: 'archives' as const, label: 'Archives', icon: <Archive className="w-3 h-3" /> },
            ].map((cat) => {
              const isActive = categoryFilter === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setCategoryFilter(isActive && cat.id !== 'all' ? 'all' : cat.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium whitespace-nowrap transition-all duration-200 active:scale-95 ${
                    isActive
                      ? 'bg-telegram-primary text-black font-semibold shadow-sm'
                      : 'bg-white/80 dark:bg-telegram-surface/60 text-telegram-text hover:bg-white dark:hover:bg-telegram-surface border border-black/10 dark:border-white/10 shadow-xs'
                  }`}
                >
                  {cat.icon}
                  <span>{cat.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* Main Viewport Container */}
      <main ref={mainScrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4 pb-40 scroll-smooth">
        {activeTab === 'files' && (
          <div className="space-y-3">
            {/* If inside a folder, show Drive breadcrumb with back button */}
            {activeFolderId !== null ? (
              <div className="flex items-center justify-between bg-telegram-hover/20 p-2.5 px-3.5 rounded-2xl border border-telegram-border/30">
                <button
                  onClick={() => setActiveFolderId(null)}
                  className="flex items-center gap-2 text-xs font-semibold text-telegram-primary active:scale-95 transition-all truncate"
                >
                  <ArrowLeft className="w-4 h-4 flex-shrink-0" />
                  <span className="text-telegram-subtext">Drive /</span>
                  <span className="text-telegram-text truncate">{activeFolder}</span>
                </button>
                <span className="text-[10px] font-mono text-telegram-subtext/70 flex-shrink-0">
                  {displayFiles.length} item{displayFiles.length !== 1 ? 's' : ''}
                </span>
              </div>
            ) : (
              /* If at root and user has folders, show quick folder chips */
              folders.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[11px] font-bold text-telegram-subtext uppercase tracking-wider">Folders</span>
                    <span className="text-[10px] text-telegram-subtext/60">{folders.length}</span>
                  </div>
                  <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                    {folders.map(folder => (
                      <button
                        key={folder.id}
                        onClick={() => setActiveFolderId(folder.id)}
                        className="flex items-center gap-2 px-3.5 py-2.5 rounded-2xl bg-telegram-hover/25 hover:bg-telegram-hover/40 border border-telegram-border/30 active:scale-95 transition-all flex-shrink-0 text-left min-w-[120px] max-w-[190px]"
                      >
                        <Folder className="w-4 h-4 text-telegram-primary flex-shrink-0" />
                        <span className="text-xs font-semibold text-telegram-text truncate flex-1">{folder.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}

            <div className="flex items-center justify-between px-1 pt-1">
              <span className="text-[11px] font-bold text-telegram-subtext uppercase tracking-wider">
                {searchQuery
                  ? `Search: "${searchQuery}" (${displayFiles.length})`
                  : categoryFilter !== 'all'
                  ? `${categoryFilter.toUpperCase()} (${displayFiles.length})`
                  : 'Files'}
              </span>
              {selectedIds.length > 0 && (
                <span className="text-xs font-semibold text-telegram-primary">
                  {selectedIds.length} selected
                </span>
              )}
            </div>

            {/* Dynamic Real File List */}
            <TouchFileList
              key={activeFolderId ?? 'saved-messages'}
              scrollContainerRef={mainScrollRef}
              files={displayFiles}
              isLoading={isLoading && allFiles.length === 0}
              onDownload={handleDownload}
              onDelete={handleDeleteFile}
              onPreview={handlePreview}
              onRename={handleRenameFile}
              onShare={setShareFile}
              onCopyTelegramLink={handleCopyTelegramLink}
              onBulkShare={handleBulkShare}
              selectedIds={selectedIds}
              onToggleSelection={handleToggleSelection}
              onSelectAll={handleSelectAll}
              onClearSelection={handleClearSelection}
              onBulkDelete={handleBulkDelete}
              onBulkDownload={handleBulkDownload}
              onBulkMove={handleBulkMove}
              folders={folders}
              activeFolderId={activeFolderId}
            />
          </div>
        )}

        {activeTab === 'downloads' && (
          <div className="space-y-4">
            {/* Transfers Header & Controls */}
            <div className="flex items-center justify-between bg-telegram-hover/20 p-3.5 rounded-2xl border border-telegram-border/30">
              <div>
                <h2 className="text-sm font-bold text-telegram-text flex items-center gap-2">
                  <Download className="w-4 h-4 text-telegram-primary" />
                  Transfers
                  {totalActiveTransfers > 0 && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-telegram-primary text-black">
                      {totalActiveTransfers} active
                    </span>
                  )}
                </h2>
                <p className="text-[11px] text-telegram-subtext mt-0.5">
                  {uploadQueue.length + downloadQueue.length === 0
                    ? 'No active or recent transfers'
                    : `${uploadQueue.length} upload${uploadQueue.length !== 1 ? 's' : ''}, ${downloadQueue.length} download${downloadQueue.length !== 1 ? 's' : ''}`}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {(uploadQueue.some(i => i.status === 'success' || i.status === 'error' || i.status === 'cancelled') ||
                  downloadQueue.some(i => i.status === 'success' || i.status === 'error' || i.status === 'cancelled')) && (
                  <button
                    onClick={() => {
                      clearUploads();
                      clearDownloads();
                    }}
                    className="px-2.5 py-1.5 rounded-xl text-[11px] font-semibold bg-telegram-hover/40 text-telegram-subtext hover:text-telegram-text border border-telegram-border/30 transition-all active:scale-95"
                  >
                    Clear
                  </button>
                )}
                {totalActiveTransfers > 0 && (
                  <button
                    onClick={() => {
                      cancelUploads();
                      cancelDownloads();
                    }}
                    className="px-2.5 py-1.5 rounded-xl text-[11px] font-semibold bg-red-500/15 text-red-400 hover:bg-red-500/25 border border-red-500/20 transition-all active:scale-95"
                  >
                    Cancel All
                  </button>
                )}
              </div>
            </div>

            {/* Filter Tabs */}
            {(uploadQueue.length > 0 || downloadQueue.length > 0) && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setTransfersFilter('all')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-200 active:scale-95 ${
                    transfersFilter === 'all'
                      ? 'bg-telegram-primary text-black'
                      : 'bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30'
                  }`}
                >
                  All ({uploadQueue.length + downloadQueue.length})
                </button>
                <button
                  onClick={() => setTransfersFilter('uploads')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-200 active:scale-95 ${
                    transfersFilter === 'uploads'
                      ? 'bg-telegram-primary text-black'
                      : 'bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30'
                  }`}
                >
                  Uploads ({uploadQueue.length})
                </button>
                <button
                  onClick={() => setTransfersFilter('downloads')}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-200 active:scale-95 ${
                    transfersFilter === 'downloads'
                      ? 'bg-telegram-primary text-black'
                      : 'bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30'
                  }`}
                >
                  Downloads ({downloadQueue.length})
                </button>
              </div>
            )}

            {/* Empty state */}
            {uploadQueue.length === 0 && downloadQueue.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 space-y-3 text-center px-6">
                <div className="p-4 rounded-2xl bg-telegram-primary/10 text-telegram-primary border border-telegram-primary/20">
                  <Download className="w-8 h-8" />
                </div>
                <h3 className="text-base font-bold text-telegram-text">No Transfers</h3>
                <p className="text-xs text-telegram-subtext max-w-xs leading-relaxed">
                  Files you upload or download will appear here with live progress, speed, and status.
                </p>
                <button
                  onClick={handleManualUpload}
                  className="mt-2 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-telegram-primary text-black active:scale-95 transition-all shadow-md"
                >
                  <UploadCloud className="w-4 h-4" />
                  Upload a File
                </button>
              </div>
            )}

            {/* Transfers List */}
            <div className="space-y-2.5">
              {/* Upload items */}
              {(transfersFilter === 'all' || transfersFilter === 'uploads') &&
                uploadQueue.map((item) => {
                  const filename = (item.url || item.path || 'file').split('/').pop()?.split('\\').pop() || 'upload';
                  const isActive = item.status === 'uploading' || item.status === 'downloading' || item.status === 'pending';
                  const isDone = item.status === 'success';
                  const isFailed = item.status === 'error';
                  const isCancelled = item.status === 'cancelled';

                  return (
                    <div
                      key={`upload-${item.id}`}
                      className="p-3.5 rounded-2xl bg-telegram-hover/15 border border-telegram-border/30 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className={`p-2 rounded-xl flex-shrink-0 ${
                            isDone ? 'bg-green-500/15 text-green-400' :
                            isFailed ? 'bg-red-500/15 text-red-400' :
                            isCancelled ? 'bg-gray-500/15 text-gray-400' :
                            'bg-blue-500/15 text-blue-400'
                          }`}>
                            <UploadCloud className="w-4 h-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-telegram-text truncate leading-snug">{filename}</p>
                            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-telegram-subtext">
                              <span>Upload</span>
                              {item.totalBytes ? (
                                <>
                                  <span>•</span>
                                  <span>{formatBytes(item.uploadedBytes || 0)} / {formatBytes(item.totalBytes)}</span>
                                </>
                              ) : null}
                              {isActive && item.speedBytesPerSec ? (
                                <>
                                  <span>•</span>
                                  <span className="text-emerald-400 font-mono">{formatBytes(item.speedBytesPerSec)}/s</span>
                                </>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        {/* Status Badge & Actions */}
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {isActive && (
                            <button
                              onClick={() => cancelUploadItem(item.id)}
                              className="p-1.5 rounded-lg bg-telegram-hover/30 hover:bg-telegram-hover/60 text-telegram-subtext hover:text-red-400 transition"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {(isFailed || isCancelled) && (
                            <button
                              onClick={() => retryUploadItem(item.id)}
                              className="p-1.5 rounded-lg bg-telegram-primary/15 hover:bg-telegram-primary/25 text-telegram-primary transition"
                              title="Retry"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                            isDone ? 'bg-green-500/15 text-green-400' :
                            isFailed ? 'bg-red-500/15 text-red-400' :
                            isCancelled ? 'bg-gray-500/20 text-gray-400' :
                            item.status === 'downloading' ? 'bg-cyan-500/15 text-cyan-400 animate-pulse' :
                            'bg-blue-500/15 text-blue-400 animate-pulse'
                          }`}>
                            {isDone ? 'Complete' :
                             isFailed ? 'Failed' :
                             isCancelled ? 'Cancelled' :
                             item.status === 'downloading' ? `Caching ${item.progress ?? 0}%` :
                             item.status === 'uploading' ? `Uploading ${item.progress ?? 0}%` : 'Queued'}
                          </span>
                        </div>
                      </div>

                      {/* Progress Bar */}
                      {isActive && (
                        <div className="h-1.5 w-full bg-telegram-border/40 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${
                              item.status === 'downloading' ? 'bg-cyan-500' : 'bg-telegram-primary'
                            }`}
                            style={{ width: `${Math.max(5, item.progress || 0)}%` }}
                          />
                        </div>
                      )}
                      {isFailed && item.error && (
                        <p className="text-[10px] text-red-400/80 truncate px-1">{item.error}</p>
                      )}
                    </div>
                  );
                })}

              {/* Download items */}
              {(transfersFilter === 'all' || transfersFilter === 'downloads') &&
                downloadQueue.map((item) => {
                  const isActive = item.status === 'downloading' || item.status === 'pending';
                  const isDone = item.status === 'success';
                  const isFailed = item.status === 'error';
                  const isCancelled = item.status === 'cancelled';

                  return (
                    <div
                      key={`download-${item.id}`}
                      className="p-3.5 rounded-2xl bg-telegram-hover/15 border border-telegram-border/30 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <div className={`p-2 rounded-xl flex-shrink-0 ${
                            isDone ? 'bg-green-500/15 text-green-400' :
                            isFailed ? 'bg-red-500/15 text-red-400' :
                            isCancelled ? 'bg-gray-500/15 text-gray-400' :
                            'bg-amber-500/15 text-amber-400'
                          }`}>
                            <Download className="w-4 h-4" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-semibold text-telegram-text truncate leading-snug">{item.filename}</p>
                            <div className="flex items-center gap-2 mt-0.5 text-[10px] text-telegram-subtext">
                              <span>Download</span>
                              {item.totalBytes ? (
                                <>
                                  <span>•</span>
                                  <span>{formatBytes(item.downloadedBytes || 0)} / {formatBytes(item.totalBytes)}</span>
                                </>
                              ) : null}
                              {isActive && item.speedBytesPerSec ? (
                                <>
                                  <span>•</span>
                                  <span className="text-emerald-400 font-mono">{formatBytes(item.speedBytesPerSec)}/s</span>
                                </>
                              ) : null}
                            </div>
                          </div>
                        </div>

                        {/* Status Badge & Actions */}
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {isActive && (
                            <button
                              onClick={() => cancelDownloadItem(item.id)}
                              className="p-1.5 rounded-lg bg-telegram-hover/30 hover:bg-telegram-hover/60 text-telegram-subtext hover:text-red-400 transition"
                              title="Cancel"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {(isFailed || isCancelled) && (
                            <button
                              onClick={() => retryDownloadItem(item.id)}
                              className="p-1.5 rounded-lg bg-telegram-primary/15 hover:bg-telegram-primary/25 text-telegram-primary transition"
                              title="Retry"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <span className={`px-2 py-0.5 rounded-lg text-[10px] font-bold ${
                            isDone ? 'bg-green-500/15 text-green-400' :
                            isFailed ? 'bg-red-500/15 text-red-400' :
                            isCancelled ? 'bg-gray-500/20 text-gray-400' :
                            'bg-amber-500/15 text-amber-400 animate-pulse'
                          }`}>
                            {isDone ? 'Complete' :
                             isFailed ? 'Failed' :
                             isCancelled ? 'Cancelled' :
                             item.status === 'downloading' ? `Downloading ${item.progress ?? 0}%` : 'Queued'}
                          </span>
                        </div>
                      </div>

                      {/* Progress Bar */}
                      {isActive && (
                        <div className="h-1.5 w-full bg-telegram-border/40 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-300 bg-amber-500"
                            style={{ width: `${Math.max(5, item.progress || 0)}%` }}
                          />
                        </div>
                      )}
                      {isFailed && item.error && (
                        <p className="text-[10px] text-red-400/80 truncate px-1">{item.error}</p>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-telegram-hover/20 border border-telegram-border/30 space-y-4">
              <h3 className="text-sm font-bold text-telegram-primary tracking-wide uppercase text-[10px]">{t('common.preferences')}</h3>
              <div className="flex items-center justify-between py-2 border-b border-telegram-border/20">
                <div>
                  <p className="text-xs font-medium">{t('settings.zip_before_upload')}</p>
                  <p className="text-[10px] text-telegram-subtext">{t('settings.zip_folders_desc')}</p>
                </div>
                <button
                  onClick={() => updateSetting('zipFolders', !settings.zipFolders)}
                  className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${settings.zipFolders ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.zipFolders ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              <div className="flex items-center justify-between py-2">
                <div>
                  <p className="text-xs font-medium">{t('common.language')}</p>
                  <p className="text-[10px] text-telegram-subtext">{t('settings.select_app_language')}</p>
                </div>
                <div className="relative">
                  <select
                    value={settings.language}
                    onChange={e => updateSetting('language', e.target.value as any)}
                    className="appearance-none bg-telegram-bg border border-telegram-border rounded-lg pl-2.5 pr-7 py-1.5 text-xs text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                  >
                    {LANGUAGES.map(lang => (
                      <option key={lang.code} value={lang.code}>
                        {lang.nativeLabel}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 text-telegram-subtext absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>
            </div>

            {/* Connection Diagnostics */}
            <div className="p-4 rounded-2xl bg-telegram-hover/20 border border-telegram-border/30 space-y-4">
              <h3 className="text-sm font-bold text-telegram-primary tracking-wide uppercase text-[10px] flex items-center gap-1.5">
                <Wifi className="w-3 h-3" />
                {t('settings.connection_diagnostics')}
              </h3>

              {/* Connection status indicator */}
              <div className="flex items-center justify-between py-2 border-b border-telegram-border/20">
                <div className="flex items-center gap-2">
                  <Activity className="w-3.5 h-3.5 text-telegram-subtext" />
                  <p className="text-xs font-medium">{t('common.status')}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
                  <span className={`text-xs font-semibold ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
                    {isConnected ? t('common.connected_telegram') : t('settings.offline')}
                  </span>
                </div>
              </div>

              {/* Ping test */}
              <div className="flex items-center justify-between py-2 border-b border-telegram-border/20">
                <div>
                  <p className="text-xs font-medium">{t('common.ping')}</p>
                  <p className="text-[10px] text-telegram-subtext">
                    {latencyMs !== null
                      ? latencyMs >= 0
                        ? `${latencyMs}ms`
                        : t('settings.offline')
                      : t('settings.not_tested')}
                  </p>
                </div>
                <button
                  onClick={handleCheckLatency}
                  disabled={checkingLatency}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-telegram-primary/15 text-telegram-primary hover:bg-telegram-primary/25 border border-telegram-primary/20 active:scale-95 transition-all duration-200 disabled:opacity-50"
                >
                  {checkingLatency ? (
                    <>
                      <div className="w-3 h-3 border-2 border-telegram-primary/30 border-t-telegram-primary rounded-full animate-spin" />
                      {t('settings.testing')}
                    </>
                  ) : (
                    <>
                      <Zap className="w-3 h-3" />
                      {t('settings.check_ping')}
                    </>
                  )}
                </button>
              </div>

              {/* Latency quality bar */}
              {latencyMs !== null && latencyMs >= 0 && (
                <div className="flex items-center gap-2 py-1">
                  <div className="flex-1 h-1.5 rounded-full bg-telegram-border/30 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${latencyMs < 100 ? 'bg-green-500' : latencyMs < 250 ? 'bg-yellow-500' : 'bg-red-500'}`}
                      style={{ width: `${Math.min(100, Math.max(5, (500 - latencyMs) / 5))}%` }}
                    />
                  </div>
                  <span className={`text-[10px] font-semibold ${latencyMs < 100 ? 'text-green-400' : latencyMs < 250 ? 'text-yellow-400' : 'text-red-400'}`}>
                    {latencyMs < 100 ? t('settings.excellent') : latencyMs < 250 ? t('settings.good') : t('settings.slow')}
                  </span>
                </div>
              )}

              {/* Bandwidth stats */}
              {bandwidth && (
                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-xs font-medium">{t('common.usage')}</p>
                    <p className="text-[10px] text-telegram-subtext">{t('settings.up_down_since_connected')}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] font-mono font-semibold text-telegram-text">
                      <span className="text-emerald-400">↑ {formatBytes(bandwidth.up_bytes)}</span>
                      {' · '}
                      <span className="text-blue-400">↓ {formatBytes(bandwidth.down_bytes)}</span>
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Proxy Configuration */}
            <div className="p-4 rounded-2xl bg-telegram-hover/20 border border-telegram-border/30 space-y-4">
              <h3 className="text-sm font-bold text-telegram-primary tracking-wide uppercase text-[10px] flex items-center gap-1.5">
                <Shield className="w-3 h-3" />
                {t('common.proxy')}
              </h3>

              {/* Enable Proxy Toggle */}
              <div className="flex items-center justify-between py-2 border-b border-telegram-border/20">
                <div>
                  <p className="text-xs font-medium">{t('common.enable_proxy')}</p>
                  <p className="text-[10px] text-telegram-subtext">{t('settings.enable_proxy_desc')}</p>
                </div>
                <button
                  onClick={() => updateSetting('proxyEnabled', !settings.proxyEnabled)}
                  className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${settings.proxyEnabled ? 'bg-telegram-primary' : 'bg-telegram-border'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${settings.proxyEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* Proxy Type */}
              <div className="flex items-center justify-between py-2 border-b border-telegram-border/20">
                <div>
                  <p className="text-xs font-medium">{t('common.proxy_type')}</p>
                  <p className="text-[10px] text-telegram-subtext">{t('settings.socks5_desc_mobile')}</p>
                </div>
                <div className="relative">
                  <select
                    value={settings.proxyType}
                    onChange={e => updateSetting('proxyType', e.target.value as 'socks5')}
                    className="appearance-none bg-telegram-bg border border-telegram-border rounded-lg pl-2.5 pr-7 py-1.5 text-xs text-telegram-text focus:outline-none focus:border-telegram-primary/50 transition cursor-pointer"
                  >
                    <option value="socks5">SOCKS5</option>
                  </select>
                  <ChevronDown className="w-3.5 h-3.5 text-telegram-subtext absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              {/* Host */}
              <div className="flex items-center justify-between py-2 border-b border-telegram-border/20">
                <div>
                  <p className="text-xs font-medium">{t('common.host')}</p>
                  <p className="text-[10px] text-telegram-subtext">{t('settings.host_desc')}</p>
                </div>
                <input
                  type="text"
                  placeholder="127.0.0.1"
                  value={settings.proxyHost}
                  onChange={e => updateSetting('proxyHost', e.target.value)}
                  className="w-32 bg-telegram-bg border border-telegram-border rounded-lg px-2 py-1.5 text-xs text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                />
              </div>

              {/* Port */}
              <div className="flex items-center justify-between py-2 border-b border-telegram-border/20">
                <div>
                  <p className="text-xs font-medium">{t('common.port')}</p>
                  <p className="text-[10px] text-telegram-subtext">{t('settings.port_desc')}</p>
                </div>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={settings.proxyPort}
                  onChange={e => updateSetting('proxyPort', Math.max(1, Math.min(65535, parseInt(e.target.value) || 1080)))}
                  className="w-20 bg-telegram-bg border border-telegram-border rounded-lg px-2 py-1.5 text-xs text-telegram-text text-center focus:outline-none focus:border-telegram-primary/50 transition"
                />
              </div>

              {/* SOCKS5 auth fields */}
              {settings.proxyType === 'socks5' && (
                <>
                  <div className="flex items-center justify-between py-2 border-b border-telegram-border/20">
                    <div>
                      <p className="text-xs font-medium">{t('common.username')}</p>
                      <p className="text-[10px] text-telegram-subtext">{t('settings.optional')}</p>
                    </div>
                    <input
                      type="text"
                      placeholder={t('settings.optional')}
                      value={settings.proxyUsername}
                      onChange={e => updateSetting('proxyUsername', e.target.value)}
                      className="w-32 bg-telegram-bg border border-telegram-border rounded-lg px-2 py-1.5 text-xs text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                    />
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <div>
                      <p className="text-xs font-medium">{t('common.password')}</p>
                      <p className="text-[10px] text-telegram-subtext">{t('settings.optional')}</p>
                    </div>
                    <input
                      type="password"
                      placeholder={t('settings.optional')}
                      value={settings.proxyPassword}
                      onChange={e => updateSetting('proxyPassword', e.target.value)}
                      className="w-32 bg-telegram-bg border border-telegram-border rounded-lg px-2 py-1.5 text-xs text-telegram-text text-right focus:outline-none focus:border-telegram-primary/50 transition placeholder:text-telegram-subtext/40"
                    />
                  </div>
                </>
              )}

              {/* Info note */}
              <div className="p-2.5 rounded-lg bg-yellow-500/5 border border-yellow-500/10">
                <p className="text-[10px] text-yellow-400/70 leading-relaxed">
                  {t('settings.proxy_reconnect_note')}
                </p>
              </div>
            </div>

            {/* Shared Files (Android only) */}
            {isAndroid && cachedFiles.length > 0 && (
              <div className="p-4 rounded-2xl bg-telegram-hover/20 border border-telegram-border/30 space-y-4">
                <h3 className="text-sm font-bold text-telegram-primary tracking-wide uppercase text-[10px] flex items-center gap-1.5">
                  <Share2 className="w-3 h-3" />
                  {t('settings.shared_files', { count: cachedFiles.length })}
                </h3>
                <div className="space-y-2">
                  {cachedFiles.map((entry) => {
                    const isUploading = uploadingCacheFiles.has(entry.cached_path);
                    return (
                      <div
                        key={entry.cached_path}
                        className="flex items-center justify-between p-3 rounded-xl bg-telegram-bg/50 border border-telegram-border/30"
                      >
                        <div className="min-w-0 flex-1 mr-2">
                          <p className="text-xs font-semibold text-telegram-text truncate">{entry.file_name}</p>
                          <p className="text-[10px] text-telegram-subtext/60 font-mono">{formatBytes(entry.file_size)}</p>
                        </div>
                        <button
                          onClick={() => handleUploadCachedFile(entry)}
                          disabled={isUploading || !isConnected}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-telegram-primary text-black hover:bg-telegram-primary/95 border border-telegram-primary/10 active:scale-95 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                        >
                          {isUploading ? (
                            <>
                              <div className="w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                              {t('settings.uploading')}
                            </>
                          ) : (
                            <>
                              <UploadCloud className="w-3 h-3" />
                              {t('common.upload')}
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  onClick={handleClearCachedFiles}
                  className="w-full text-center text-[10px] text-red-400/60 hover:text-red-400 transition-colors py-1"
                >
                  {t('settings.clear_shared_files')}
                </button>
              </div>
            )}

            <div className="p-4 rounded-2xl bg-telegram-hover/20 border border-telegram-border/30 space-y-4">
              <h3 className="text-sm font-bold text-telegram-primary tracking-wide uppercase text-[10px]">{t('common.about')}</h3>
              <div className="flex flex-col items-center py-3 space-y-4">
                <img src="/logo.svg" className="w-14 h-14 drop-shadow-lg" alt="Telegram Drive Logo" />
                <div className="text-center">
                  <p className="text-sm font-bold text-telegram-text">Telegram Drive</p>
                  <p className="text-[11px] text-telegram-subtext mt-0.5">v{appVersion}</p>
                </div>

                <div className="w-10 h-px bg-telegram-border" />

                <div className="text-center space-y-2.5">
                  <p className="text-xs font-semibold text-telegram-text">bigblast66</p>

                  <button
                    onClick={(e) => { e.preventDefault(); openUrl('https://web.iiit.ac.in/~akash.chebrolu/'); }}
                    className="flex items-center justify-center gap-1.5 text-[11px] text-telegram-primary hover:text-telegram-primary/80 transition-colors cursor-pointer"
                  >
                    <Globe className="w-3 h-3" />
                    https://web.iiit.ac.in/~akash.chebrolu/
                  </button>

                  <button
                    onClick={(e) => { e.preventDefault(); openUrl('https://github.com/bigblast66'); }}
                    className="flex items-center justify-center gap-1.5 text-[11px] text-telegram-primary hover:text-telegram-primary/80 transition-colors cursor-pointer"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                    </svg>
                    github.com/bigblast66
                  </button>
                </div>

                <p className="text-[10px] text-telegram-subtext/60 leading-relaxed text-center px-2">
                  {t('settings.tagline')}
                </p>
              </div>
            </div>

            <button onClick={handleLogout} className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 font-semibold text-xs active:scale-98 transition-all duration-200">
              <LogOut className="w-4 h-4" />
              {t('common.logout')}
            </button>
          </div>
        )}
      </main>

      {/* Slide-out Sidebar Drawer Overlay */}
      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-[100] backdrop-blur-sm transition-opacity duration-300"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Slide-out Sidebar Drawer Panel */}
      <div
        className={`fixed top-0 left-0 bottom-0 w-[280px] max-w-[85vw] bg-telegram-surface border-r border-telegram-border/60 z-[110] shadow-2xl flex flex-col pt-[calc(1rem+env(safe-area-inset-top,24px))] pb-[calc(1.5rem+env(safe-area-inset-bottom,16px))] transition-transform duration-300 ease-out transform ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 flex items-center justify-between border-b border-telegram-border/30">
          <div className="flex items-center gap-2">
            <img src="/logo.svg" className="w-8 h-8 drop-shadow-lg" alt="Logo" />
            <span className="font-bold text-base text-telegram-text tracking-tight">Telegram Drive</span>
          </div>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="p-1 rounded-lg bg-telegram-hover/30 hover:bg-telegram-hover/60 text-telegram-subtext text-xs"
          >
            ✕
          </button>
        </div>

        {/* Scrollable Folder List */}
        <nav className="flex-1 px-3 py-4 space-y-1.5 overflow-y-auto min-h-0">
          <button
            onClick={() => {
              setActiveFolderId(null);
              setIsSidebarOpen(false);
            }}
            className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all duration-200 ${activeFolderId === null
                ? 'bg-telegram-primary/15 text-telegram-primary border border-telegram-primary/15'
                : 'text-telegram-subtext hover:bg-telegram-hover/40 hover:text-telegram-text border border-transparent'
              }`}
          >
            <span className="flex items-center gap-2">
              <Folder className="w-4 h-4 text-telegram-primary" />
              My Drive
            </span>
          </button>

          {folders.map(folder => {
            const isPublic = folder.is_public || !!folder.username;
            return (
            <div key={folder.id} className="flex items-center gap-1">
              <button
                onClick={() => {
                  setActiveFolderId(folder.id);
                  setIsSidebarOpen(false);
                }}
                className={`flex-1 text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all duration-200 ${
                  activeFolderId === folder.id
                    ? 'bg-telegram-primary/15 text-telegram-primary border border-telegram-primary/15'
                    : 'text-telegram-subtext hover:bg-telegram-hover/40 hover:text-telegram-text border border-transparent'
                }`}
              >
                <span className="flex items-center gap-1.5 max-w-[150px]">
                  <span className="truncate">{folder.name}</span>
                  {isPublic ? (
                    <Globe className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                  ) : (
                    <Lock className="w-3 h-3 text-amber-400/60 flex-shrink-0" />
                  )}
                </span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setFolderActionMenu(folder);
                }}
                className="flex-shrink-0 p-2 rounded-xl hover:bg-telegram-hover/40 active:bg-telegram-hover/60 text-telegram-subtext/60 hover:text-telegram-subtext transition-all duration-200"
                aria-label="Folder actions"
              >
                <MoreVertical className="w-3.5 h-3.5" />
              </button>
            </div>
            );
          })}
        </nav>

        {/* Action Panel & Connection Status */}
        <div className="px-4 py-3 border-t border-telegram-border/30 space-y-3">
          <button
            onClick={async () => {
              const name = prompt("Enter folder name:");
              if (name && name.trim()) {
                await handleCreateFolder(name.trim());
              }
            }}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold text-telegram-subtext hover:text-telegram-text border border-dashed border-telegram-border/60 hover:bg-telegram-hover/20 transition-all duration-200"
          >
            + Create Folder
          </button>
          <div className="flex items-center gap-2 text-telegram-subtext text-[10px] font-semibold uppercase tracking-wider">
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span>{isConnected ? 'Connected' : 'Offline'}</span>
          </div>
        </div>
      </div>

      {/* Folder action popover (replaces swipe-to-reveal) */}
      {folderActionMenu && (
        <ActionPopover
          title={folderActionMenu.name}
          actions={buildFolderActions(folderActionMenu)}
          onClose={() => setFolderActionMenu(null)}
        />
      )}

      {/* Rename folder bottom sheet */}
      {renameFolder && (
        <RenameFolderSheet
          folderId={renameFolder.id}
          currentName={renameFolder.name}
          onRename={handleFolderRename}
          onClose={() => setRenameFolder(null)}
        />
      )}

      {/* Google Drive Style Floating Action Button (FAB) */}
      {activeTab === 'files' && (
        <button
          onClick={() => setShowFabSheet(true)}
          className="fixed right-5 bottom-20 z-40 w-14 h-14 rounded-2xl bg-white dark:bg-telegram-surface border border-black/10 dark:border-white/10 text-telegram-primary shadow-xl flex items-center justify-center active:scale-90 hover:scale-105 transition-all duration-200"
          style={{
            boxShadow: '0 8px 24px -4px rgba(0, 0, 0, 0.35), 0 2px 8px -2px rgba(0, 0, 0, 0.15)'
          }}
          aria-label="Create new"
        >
          <Plus className="w-7 h-7 stroke-[2.2]" />
        </button>
      )}

      {/* Google Drive Style FAB Bottom Sheet */}
      {showFabSheet && (
        <div
          className="fixed inset-0 z-[150] flex items-end justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
          onClick={() => setShowFabSheet(false)}
        >
          <div
            className="w-full max-w-md bg-telegram-surface border border-telegram-border/40 rounded-t-3xl p-5 shadow-2xl animate-in slide-in-from-bottom duration-300 flex flex-col gap-4"
            style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 16px))' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="flex justify-center -mt-1">
              <div className="w-10 h-1 rounded-full bg-telegram-border/60" />
            </div>

            <div className="flex items-center justify-between pb-1 border-b border-telegram-border/20">
              <h3 className="text-sm font-bold text-telegram-text">Create new</h3>
              <button
                onClick={() => setShowFabSheet(false)}
                className="p-1 rounded-lg hover:bg-telegram-hover text-telegram-subtext"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Options Grid */}
            <div className="grid grid-cols-3 gap-3">
              <button
                onClick={() => {
                  setShowFabSheet(false);
                  handleManualUpload();
                }}
                className="flex flex-col items-center justify-center p-3.5 rounded-2xl bg-telegram-hover/20 hover:bg-telegram-hover/40 border border-telegram-border/30 active:scale-95 transition-all gap-2 text-center"
              >
                <div className="w-11 h-11 rounded-2xl bg-telegram-primary/15 text-telegram-primary flex items-center justify-center">
                  <UploadCloud className="w-5 h-5" />
                </div>
                <span className="text-xs font-semibold text-telegram-text">Upload</span>
              </button>

              <button
                onClick={async () => {
                  setShowFabSheet(false);
                  const name = prompt("Enter folder name:");
                  if (name && name.trim()) {
                    await handleCreateFolder(name.trim());
                  }
                }}
                className="flex flex-col items-center justify-center p-3.5 rounded-2xl bg-telegram-hover/20 hover:bg-telegram-hover/40 border border-telegram-border/30 active:scale-95 transition-all gap-2 text-center"
              >
                <div className="w-11 h-11 rounded-2xl bg-blue-500/15 text-blue-400 flex items-center justify-center">
                  <FolderPlus className="w-5 h-5" />
                </div>
                <span className="text-xs font-semibold text-telegram-text">Folder</span>
              </button>

              <button
                onClick={() => {
                  setShowFabSheet(false);
                  handleSyncFolders();
                }}
                disabled={isSyncing}
                className="flex flex-col items-center justify-center p-3.5 rounded-2xl bg-telegram-hover/20 hover:bg-telegram-hover/40 border border-telegram-border/30 active:scale-95 transition-all gap-2 text-center disabled:opacity-50"
              >
                <div className="w-11 h-11 rounded-2xl bg-emerald-500/15 text-emerald-400 flex items-center justify-center">
                  <RefreshCw className={`w-5 h-5 ${isSyncing ? 'animate-spin' : ''}`} />
                </div>
                <span className="text-xs font-semibold text-telegram-text">Sync</span>
              </button>
            </div>

            {/* Cached files received via Android share sheet */}
            {cachedFiles.length > 0 && (
              <div className="mt-1 p-3 rounded-2xl bg-telegram-primary/10 border border-telegram-primary/20 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-telegram-primary flex-shrink-0" />
                  <span className="text-xs font-semibold text-telegram-text">
                    {cachedFiles.length} file{cachedFiles.length !== 1 ? 's' : ''} from phone
                  </span>
                </div>
                <button
                  onClick={() => {
                    setShowFabSheet(false);
                    cachedFiles.forEach(f => handleUploadCachedFile(f));
                  }}
                  className="px-3 py-1 rounded-xl text-xs font-bold bg-telegram-primary text-black active:scale-95 transition"
                >
                  Upload All
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating Bottom Nav Bar */}
      <BottomNavBar activeTab={activeTab} setActiveTab={setActiveTab} isAndroid={isAndroid} activeTransfersCount={totalActiveTransfers} />

     

      {/* Previews Overlays (Media, PDF & Images) */}
      {playingFile && (
        <MobileMediaPlayer
          key={playingFile.id}
          file={playingFile}
          onClose={() => setPlayingFile(null)}
          activeFolderId={activeFolderId}
          onDownload={handleDownload}
          onShare={setShareFile}
        />
      )}
      {pdfFile && (
        <div className="fixed inset-0 z-[100] bg-telegram-bg">
          <PdfViewer
            file={pdfFile}
            onClose={() => setPdfFile(null)}
            activeFolderId={activeFolderId}
          />
        </div>
      )}
      {previewFile && (
        <MobilePreviewModal
          file={previewFile}
          activeFolderId={activeFolderId}
          onClose={() => setPreviewFile(null)}
          onNext={previewNeighbors.nextFile ? handleNextPreview : undefined}
          onPrev={previewNeighbors.prevFile ? handlePrevPreview : undefined}
          currentIndex={previewContextIndex >= 0 ? previewContextIndex : undefined}
          totalItems={previewContextFiles.length}
          nextFile={previewNeighbors.nextFile}
          prevFile={previewNeighbors.prevFile}
          onDownload={handleDownload}
          onShare={setShareFile}
        />
      )}
      {textFile && (
        <TextViewer
          file={textFile}
          activeFolderId={activeFolderId}
          onClose={() => setTextFile(null)}
        />
      )}

      {shareFile && (
        <ShareDialog
          file={shareFile}
          onClose={() => setShareFile(null)}
        />
      )}

      {/* Bulk Share Results Modal */}
      {bulkShareLinks && (
        <div
          className="fixed inset-0 z-[150] flex items-end justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setBulkShareLinks(null)}
        >
          <div
            className="w-full max-w-lg bg-telegram-surface border border-telegram-border/40 rounded-t-3xl p-5 shadow-2xl animate-in slide-in-from-bottom duration-300 max-h-[75vh] flex flex-col"
            style={{ paddingBottom: 'calc(1.5rem + env(safe-area-inset-bottom, 0px))' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="flex justify-center mb-4">
              <div className="w-10 h-1 rounded-full bg-telegram-border/60" />
            </div>

            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-telegram-text flex items-center gap-2">
                <Link className="w-4 h-4 text-telegram-primary" />
                {bulkShareLinks.length} Share Link{bulkShareLinks.length !== 1 ? 's' : ''}
              </h3>
              <button
                onClick={() => setBulkShareLinks(null)}
                className="p-1.5 rounded-lg hover:bg-telegram-hover text-telegram-subtext"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {bulkShareLoading ? (
              <div className="flex flex-col items-center justify-center py-12 space-y-3">
                <Loader2 className="w-8 h-8 text-telegram-primary animate-spin" />
                <p className="text-xs text-telegram-subtext">Generating share links...</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
                {bulkShareLinks.map(({ file, link }) => {
                  const isCopied = bulkShareCopied.has(link);
                  return (
                    <div
                      key={file.id}
                      className="p-3 rounded-xl bg-telegram-hover/20 border border-telegram-border/30 space-y-2"
                    >
                      <p className="text-xs font-semibold text-telegram-text truncate">{file.name}</p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          readOnly
                          value={link}
                          className="flex-1 bg-telegram-bg border border-telegram-border rounded-lg px-2.5 py-1.5 text-[11px] text-telegram-text focus:outline-none select-all truncate"
                        />
                        <button
                          onClick={() => handleCopyBulkLink(link)}
                          className={`px-2.5 py-1.5 rounded-lg flex items-center justify-center transition-all flex-shrink-0 ${
                            isCopied
                              ? 'bg-emerald-500 border-emerald-500 text-white'
                              : 'bg-telegram-hover/40 border border-telegram-border text-telegram-subtext hover:text-telegram-text'
                          }`}
                        >
                          {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                        {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                          <button
                            onClick={() => handleNativeShareBulkLink(file, link)}
                            className="px-2.5 py-1.5 rounded-lg bg-telegram-primary/20 hover:bg-telegram-primary/30 text-telegram-primary border border-telegram-primary/30 transition-all flex items-center justify-center flex-shrink-0"
                          >
                            <Share2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <button
              onClick={() => setBulkShareLinks(null)}
              className="w-full mt-3 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl text-sm font-semibold bg-telegram-hover/20 text-telegram-subtext hover:text-telegram-text hover:bg-telegram-hover/40 border border-telegram-border/30 transition-all duration-200 active:scale-[0.98] flex-shrink-0"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}