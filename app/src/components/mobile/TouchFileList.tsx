import { useRef, useState, useCallback, useMemo, useEffect, RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  DownloadCloud,
  Trash2,
  Pencil,
  CheckSquare,
  X,
  Check,
  FolderInput,
  MoreVertical,
  Eye,
  Link,
  Copy,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  LayoutGrid,
  List,
  Play,
  Music,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { FileTypeIcon } from '../shared/FileTypeIcon';
import { ActionPopover, ActionItem } from './ActionPopover';
import { TelegramFile, TelegramFolder } from '../../types';
import { useSettings } from '../../context/SettingsContext';
import { isImageFile, isVideoFile, isAudioFile } from '../../utils';

type SortField = 'name' | 'size' | 'date';
type SortDirection = 'asc' | 'desc';
type ViewMode = 'grid' | 'list';

export const thumbnailCache = new Map<number, string>();

interface MobileGridCardProps {
  file: TelegramFile;
  isSelected: boolean;
  isSelectionActive: boolean;
  onToggleSelection: (id: number) => void;
  onPreview: (file: TelegramFile) => void;
  onOpenActionMenu: (file: TelegramFile) => void;
  onPointerDown: (e: React.PointerEvent, file: TelegramFile) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  longPressFiredRef: React.MutableRefObject<boolean>;
  activeFolderId: number | null;
}

function MobileGridCard({
  file,
  isSelected,
  isSelectionActive,
  onToggleSelection,
  onPreview,
  onOpenActionMenu,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  longPressFiredRef,
  activeFolderId,
}: MobileGridCardProps) {
  const isImg = isImageFile(file.name);
  const isVid = isVideoFile(file.name);
  const isAud = isAudioFile(file.name);
  const isVisualMedia = isImg || isVid;

  const [thumb, setThumb] = useState<string | null>(() => thumbnailCache.get(file.id) || null);
  const [loadingThumb, setLoadingThumb] = useState(false);

  useEffect(() => {
    if (!isVisualMedia || thumb || thumbnailCache.has(file.id)) return;
    let cancelled = false;
    setLoadingThumb(true);

    invoke<string>('cmd_get_thumbnail', {
      messageId: file.id,
      folderId: activeFolderId,
    })
      .then((res) => {
        if (!cancelled && res) {
          thumbnailCache.set(file.id, res);
          setThumb(res);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingThumb(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file.id, isVisualMedia, activeFolderId, thumb]);

  return (
    <div
      onPointerDown={(e) => onPointerDown(e, file)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={() => {
        if (longPressFiredRef.current) {
          longPressFiredRef.current = false;
          return;
        }
        if (isSelectionActive) {
          onToggleSelection(file.id);
        } else {
          onPreview(file);
        }
      }}
      className={`flex flex-col rounded-2xl overflow-hidden bg-telegram-hover/10 border transition-all duration-200 cursor-pointer active:scale-[0.98] select-none ${
        isSelected
          ? 'border-telegram-primary bg-telegram-primary/10 shadow-lg shadow-telegram-primary/15 ring-1 ring-telegram-primary'
          : 'border-telegram-border/20 active:bg-telegram-hover/25'
      }`}
    >
      <div className="relative w-full aspect-square bg-telegram-hover/15 flex items-center justify-center overflow-hidden">
        {thumb ? (
          <>
            <img
              src={thumb}
              alt={file.name}
              className="w-full h-full object-cover transition-opacity duration-200"
              loading="lazy"
            />
            {isVid && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/10">
                <div className="w-10 h-10 rounded-full bg-black/60 backdrop-blur-md flex items-center justify-center text-white shadow-xl ring-1 ring-white/20">
                  <Play className="w-4 h-4 fill-white ml-0.5" />
                </div>
              </div>
            )}
          </>
        ) : isVid ? (
          <div className="relative flex flex-col items-center justify-center p-4 w-full h-full bg-gradient-to-br from-[#1c1d22] to-[#121316]">
            {/* Format pill badge */}
            <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-md text-[9px] font-mono font-bold tracking-wider text-white/70 uppercase">
              {file.name.split('.').pop() || 'VID'}
            </div>
            {/* Centered Drive-style frosted play badge */}
            <div className="w-12 h-12 rounded-2xl bg-white/10 border border-white/15 flex items-center justify-center text-white shadow-lg backdrop-blur-sm">
              <Play className="w-5 h-5 fill-white/80 text-white ml-0.5" />
            </div>
            {/* Shimmer animation while fetching thumbnail */}
            {loadingThumb && (
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.08] to-transparent animate-pulse pointer-events-none" />
            )}
          </div>
        ) : isAud ? (
          <div className="relative flex flex-col items-center justify-center p-4 w-full h-full bg-gradient-to-br from-[#1e1e24] to-[#14141a]">
            <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-md text-[9px] font-mono font-bold tracking-wider text-amber-400/80 uppercase">
              {file.name.split('.').pop() || 'AUDIO'}
            </div>
            <div className="w-12 h-12 rounded-2xl bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-amber-400 shadow-md">
              <Music className="w-6 h-6" />
            </div>
          </div>
        ) : (
          <div className="relative flex flex-col items-center justify-center p-4 w-full h-full bg-telegram-hover/10">
            <div className="transform scale-125 mb-1">
              <FileTypeIcon filename={file.name} />
            </div>
            {loadingThumb && (
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.05] to-transparent animate-pulse pointer-events-none" />
            )}
          </div>
        )}

        {/* Selection Checkbox */}
        {isSelectionActive && (
          <div
            className={`absolute top-2 left-2 z-10 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all shadow-md ${
              isSelected
                ? 'bg-telegram-primary border-telegram-primary text-black'
                : 'border-white/80 bg-black/40 text-transparent backdrop-blur-sm'
            }`}
          >
            {isSelected && <Check className="w-3.5 h-3.5 stroke-[3]" />}
          </div>
        )}

        {/* Action Menu (⋮) */}
        {!isSelectionActive && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onOpenActionMenu(file);
            }}
            className="absolute top-1.5 right-1.5 z-10 p-1.5 rounded-full bg-black/40 hover:bg-black/60 active:bg-black/80 text-white backdrop-blur-md transition-all active:scale-95"
            aria-label="Actions"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>
        )}

        {/* File Size Badge */}
        <div className="absolute bottom-1.5 right-1.5 z-10 px-1.5 py-0.5 rounded-md bg-black/60 backdrop-blur-md text-[9px] font-mono font-medium text-white/95">
          {file.sizeStr}
        </div>
      </div>

      <div className="p-2.5 flex flex-col justify-between flex-1 min-w-0">
        <p className="text-xs font-semibold text-telegram-text line-clamp-2 leading-tight break-words">
          {file.name}
        </p>
        <p className="text-[10px] text-telegram-subtext/70 mt-1 truncate">
          {file.created_at || 'Synchronized'}
        </p>
      </div>
    </div>
  );
}

interface TouchFileListProps {
  files: TelegramFile[];
  isLoading: boolean;
  onDownload: (file: TelegramFile) => void;
  onDelete: (file: TelegramFile) => void;
  onPreview: (file: TelegramFile) => void;
  onRename: (file: TelegramFile) => void;
  selectedIds: number[];
  onToggleSelection: (id: number) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkDelete: () => void;
  onBulkDownload: () => void;
  onBulkMove: (targetFolderId: number | null) => void;
  onBulkShare?: () => void;
  onShare?: (file: TelegramFile) => void;
  onCopyTelegramLink?: (file: TelegramFile) => void;
  folders: TelegramFolder[];
  activeFolderId: number | null;
  /** The scrollable ancestor to virtualize against — the mobile dashboard's <main> element. */
  scrollContainerRef: RefObject<HTMLElement | null>;
}

export function TouchFileList({
  files,
  isLoading,
  onDownload,
  onDelete,
  onPreview,
  onRename,
  selectedIds,
  onToggleSelection,
  onSelectAll,
  onClearSelection,
  onBulkDelete,
  onBulkDownload,
  onBulkMove,
  onBulkShare,
  onShare,
  onCopyTelegramLink,
  folders,
  activeFolderId,
  scrollContainerRef,
}: TouchFileListProps) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [actionMenuFile, setActionMenuFile] = useState<TelegramFile | null>(null);
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem('mobile_file_view') as ViewMode) || 'grid';
  });

  const handleToggleViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem('mobile_file_view', mode);
  };

  const { settings } = useSettings();
  const isSelectionActive = selectionMode || selectedIds.length > 0;

  // Long-press detection refs
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressPosRef = useRef<{ x: number; y: number } | null>(null);
  const longPressFiredRef = useRef(false);
  const LONG_PRESS_DURATION = 500;

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, file: TelegramFile) => {
      if (isSelectionActive) return;
      longPressFiredRef.current = false;
      longPressPosRef.current = { x: e.clientX, y: e.clientY };
      longPressTimerRef.current = setTimeout(() => {
        longPressFiredRef.current = true;
        navigator.vibrate?.(15);
        setSelectionMode(true);
        onToggleSelection(file.id);
      }, LONG_PRESS_DURATION);
    },
    [isSelectionActive, onToggleSelection]
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!longPressPosRef.current || !longPressTimerRef.current) return;
    const dx = Math.abs(e.clientX - longPressPosRef.current.x);
    const dy = Math.abs(e.clientY - longPressPosRef.current.y);
    if (dx > 10 || dy > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      longPressPosRef.current = null;
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPosRef.current = null;
  }, []);

  // Build action items for a file's popover menu
  const buildFileActions = useCallback(
    (file: TelegramFile): ActionItem[] => {
      const isMedia = isVideoFile(file.name) || isAudioFile(file.name);
      const actions: ActionItem[] = [
        {
          label: isMedia ? 'Play' : 'Preview',
          icon: isMedia ? <Play className="w-4 h-4" /> : <Eye className="w-4 h-4" />,
          onClick: () => onPreview(file),
        },
        {
          label: 'Download',
          icon: <DownloadCloud className="w-4 h-4" />,
          onClick: () => onDownload(file),
        },
        {
          label: 'Rename',
          icon: <Pencil className="w-4 h-4" />,
          onClick: () => onRename(file),
        },
      ];
      if (file.type !== 'folder' && onShare) {
        actions.push({
          label: 'Share Link',
          icon: <Link className="w-4 h-4" />,
          onClick: () => onShare(file),
        });
      }
      if (file.type !== 'folder' && onCopyTelegramLink) {
        const folder =
          folders.find((f) => f.id === file.folder_id) ||
          folders.find((f) => f.id === activeFolderId);
        const username =
          folder?.username ||
          (folder as any)?.chat?.username ||
          (folder as any)?.channel?.username;
        if (username) {
          actions.push({
            label: 'Copy Telegram Link',
            icon: <Copy className="w-4 h-4" />,
            onClick: () => onCopyTelegramLink(file),
          });
        }
      }
      actions.push({
        label: 'Delete',
        icon: <Trash2 className="w-4 h-4" />,
        onClick: () => onDelete(file),
        destructive: true,
      });
      return actions;
    },
    [onPreview, onDownload, onRename, onDelete, onShare, onCopyTelegramLink, folders, activeFolderId]
  );

  const sortedFiles = useMemo(() => {
    return [...files].sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name, settings.language, {
            numeric: true,
            sensitivity: 'base',
          });
          break;
        case 'size':
          comparison = (a.size || 0) - (b.size || 0);
          break;
        case 'date':
          comparison = (a.created_at || '').localeCompare(b.created_at || '');
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [files, sortField, sortDirection, settings.language]);

  const handleSort = useCallback(
    (field: SortField) => {
      if (field === sortField) {
        setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
    },
    [sortField]
  );

  // Group items into pairs of 2 for grid virtualization
  const gridRows = useMemo(() => {
    const rows: TelegramFile[][] = [];
    for (let i = 0; i < sortedFiles.length; i += 2) {
      rows.push(sortedFiles.slice(i, i + 2));
    }
    return rows;
  }, [sortedFiles]);

  const rowVirtualizer = useVirtualizer({
    count: viewMode === 'grid' ? gridRows.length : sortedFiles.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => (viewMode === 'grid' ? 240 : 82),
    overscan: 6,
  });

  return (
    <>
      {isLoading && (
        <div className="flex flex-col items-center justify-center py-16 space-y-3 text-center">
          <div className="animate-spin rounded-full h-7 w-7 border-t-2 border-b-2 border-telegram-primary"></div>
          <p className="text-xs text-telegram-subtext font-semibold">Retrieving your files...</p>
        </div>
      )}

      {!isLoading && files.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 space-y-3 text-center px-4">
          <div className="p-4 rounded-2xl bg-telegram-hover/10 text-telegram-subtext border border-telegram-border/10">
            📁
          </div>
          <h4 className="text-sm font-bold text-telegram-text">This folder is empty</h4>
          <p className="text-xs text-telegram-subtext max-w-xs leading-relaxed">
            Upload files or synchronise folders to begin managing content.
          </p>
        </div>
      )}

      {!isLoading && files.length > 0 && (
        <>
          {/* Header controls: Selection & View Mode toggle */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (isSelectionActive) {
                    onClearSelection();
                  }
                  setSelectionMode(!selectionMode);
                }}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all duration-200 active:scale-95 ${
                  isSelectionActive
                    ? 'bg-telegram-primary/20 text-telegram-primary border border-telegram-primary/30'
                    : 'bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30'
                }`}
              >
                <CheckSquare className="w-3.5 h-3.5" />
                {isSelectionActive ? `${selectedIds.length} selected` : 'Select'}
              </button>
              {isSelectionActive && (
                <>
                  <button
                    onClick={onSelectAll}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[10px] font-semibold bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30 active:scale-95 transition-all duration-200"
                  >
                    <Check className="w-3 h-3" />
                    All
                  </button>
                  <button
                    onClick={onClearSelection}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[10px] font-semibold bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30 active:scale-95 transition-all duration-200"
                  >
                    <X className="w-3 h-3" />
                    Clear
                  </button>
                </>
              )}
            </div>

            {/* Grid vs List toggle */}
            <div className="flex items-center bg-telegram-hover/20 rounded-xl p-0.5 border border-telegram-border/30">
              <button
                onClick={() => handleToggleViewMode('grid')}
                className={`p-1.5 rounded-lg transition-all ${
                  viewMode === 'grid'
                    ? 'bg-telegram-primary text-black shadow-sm'
                    : 'text-telegram-subtext hover:text-telegram-text'
                }`}
                title="Grid View"
                aria-label="Grid View"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleToggleViewMode('list')}
                className={`p-1.5 rounded-lg transition-all ${
                  viewMode === 'list'
                    ? 'bg-telegram-primary text-black shadow-sm'
                    : 'text-telegram-subtext hover:text-telegram-text'
                }`}
                title="List View"
                aria-label="List View"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Sort controls */}
          {!isSelectionActive && (
            <div className="flex items-center gap-1.5 mb-3 overflow-x-auto no-scrollbar">
              {(['name', 'size', 'date'] as const).map((field) => (
                <button
                  key={field}
                  onClick={() => handleSort(field)}
                  className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[10px] font-semibold transition-all duration-200 active:scale-95 ${
                    sortField === field
                      ? 'bg-telegram-primary/20 text-telegram-primary border border-telegram-primary/30'
                      : 'bg-telegram-hover/20 text-telegram-subtext border border-telegram-border/30'
                  }`}
                >
                  {field === 'name' ? 'Name' : field === 'size' ? 'Size' : 'Date'}
                  {sortField === field ? (
                    sortDirection === 'asc' ? (
                      <ArrowUp className="w-3 h-3" />
                    ) : (
                      <ArrowDown className="w-3 h-3" />
                    )
                  ) : (
                    <ArrowUpDown className="w-3 h-3 opacity-30" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Batch action bar */}
          {isSelectionActive && selectedIds.length > 0 && (
            <div className="sticky top-0 z-10 flex items-center gap-2 p-3 mb-3 rounded-2xl bg-telegram-primary/10 border border-telegram-primary/20 backdrop-blur-md animate-in slide-in-from-top-2 overflow-x-auto no-scrollbar">
              <button
                onClick={onBulkDownload}
                className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-telegram-primary/20 text-telegram-primary border border-telegram-primary/30 active:scale-95 transition-all duration-200"
              >
                <DownloadCloud className="w-3.5 h-3.5" />
                Download ({selectedIds.length})
              </button>
              <button
                onClick={() => setShowMovePicker(true)}
                className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 active:scale-95 transition-all duration-200"
              >
                <FolderInput className="w-3.5 h-3.5" />
                Move ({selectedIds.length})
              </button>
              {onBulkShare && (
                <button
                  onClick={onBulkShare}
                  className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-teal-500/20 text-teal-400 border border-teal-500/30 active:scale-95 transition-all duration-200"
                >
                  <Link className="w-3.5 h-3.5" />
                  Share ({selectedIds.length})
                </button>
              )}
              <button
                onClick={onBulkDelete}
                className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold bg-red-500/20 text-red-400 border border-red-500/30 active:scale-95 transition-all duration-200"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete ({selectedIds.length})
              </button>
            </div>
          )}

          {/* Move-to-folder picker modal */}
          {showMovePicker && (
            <div
              className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
              onClick={() => setShowMovePicker(false)}
            >
              <div
                className="bg-telegram-surface border border-telegram-border/40 rounded-2xl p-5 w-full max-w-[340px] max-h-[60vh] flex flex-col shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-bold text-telegram-text">
                    Move {selectedIds.length} file{selectedIds.length !== 1 ? 's' : ''} to...
                  </h3>
                  <button
                    onClick={() => setShowMovePicker(false)}
                    className="p-1.5 rounded-lg hover:bg-telegram-hover text-telegram-subtext"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
                  <button
                    onClick={() => {
                      onBulkMove(null);
                      setShowMovePicker(false);
                    }}
                    className={`w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold transition-all duration-200 ${
                      activeFolderId === null
                        ? 'bg-telegram-primary/10 text-telegram-primary'
                        : 'text-telegram-subtext hover:bg-telegram-hover'
                    }`}
                  >
                    📁 Saved Messages
                  </button>
                  {folders
                    .filter((f) => f.id !== activeFolderId)
                    .map((folder) => (
                      <button
                        key={folder.id}
                        onClick={() => {
                          onBulkMove(folder.id);
                          setShowMovePicker(false);
                        }}
                        className="w-full text-left px-3.5 py-2.5 rounded-xl text-xs font-semibold text-telegram-subtext hover:bg-telegram-hover transition-all duration-200"
                      >
                        📁 {folder.name}
                      </button>
                    ))}
                  {folders.filter((f) => f.id !== activeFolderId).length === 0 && (
                    <p className="text-xs text-telegram-subtext/60 text-center py-4">
                      No other folders available
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Virtualized Container */}
          <div
            className="relative pb-24"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              if (viewMode === 'grid') {
                const rowItems = gridRows[virtualRow.index] || [];
                return (
                  <div
                    key={`grid-row-${virtualRow.index}`}
                    data-index={virtualRow.index}
                    ref={rowVirtualizer.measureElement}
                    className="absolute top-0 left-0 w-full"
                    style={{
                      transform: `translateY(${virtualRow.start}px)`,
                      paddingBottom: '12px',
                    }}
                  >
                    <div className="grid grid-cols-2 gap-3">
                      {rowItems.map((file) => {
                        const isSelected = selectedIds.includes(file.id);
                        return (
                          <MobileGridCard
                            key={file.id}
                            file={file}
                            isSelected={isSelected}
                            isSelectionActive={isSelectionActive}
                            onToggleSelection={onToggleSelection}
                            onPreview={onPreview}
                            onOpenActionMenu={setActionMenuFile}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            longPressFiredRef={longPressFiredRef}
                            activeFolderId={activeFolderId}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              }

              // List View row
              const file = sortedFiles[virtualRow.index];
              const isSelected = selectedIds.includes(file.id);

              return (
                <div
                  key={file.id}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${virtualRow.start}px)`, paddingBottom: '10px' }}
                >
                  <div
                    onPointerDown={(e) => handlePointerDown(e, file)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onClick={() => {
                      if (longPressFiredRef.current) {
                        longPressFiredRef.current = false;
                        return;
                      }
                      if (isSelectionActive) {
                        onToggleSelection(file.id);
                      } else {
                        onPreview(file);
                      }
                    }}
                    className={`flex items-center justify-between p-3.5 rounded-2xl bg-telegram-hover/15 border transition-all duration-200 cursor-pointer active:bg-telegram-hover/35 select-none ${
                      isSelected
                        ? 'border-telegram-primary/50 bg-telegram-primary/10'
                        : 'border-telegram-border/20'
                    }`}
                  >
                    <div className="flex items-center gap-3.5 min-w-0 flex-1 mr-2">
                      {isSelectionActive && (
                        <div
                          className={`flex-shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all duration-200 ${
                            isSelected
                              ? 'bg-telegram-primary border-telegram-primary text-black'
                              : 'border-telegram-border/50 bg-transparent'
                          }`}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5" />}
                        </div>
                      )}
                      <div className="flex-shrink-0">
                        <FileTypeIcon filename={file.name} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-telegram-text truncate leading-snug">
                          {file.name}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-telegram-subtext/80 font-medium font-mono">
                            {file.sizeStr}
                          </span>
                          <span className="w-1 h-1 bg-telegram-border rounded-full" />
                          <span className="text-[10px] text-telegram-subtext/80 font-medium">
                            {file.created_at || 'Sync'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {!isSelectionActive && (
                      <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActionMenuFile(file);
                        }}
                        className="flex-shrink-0 p-2 rounded-xl hover:bg-telegram-hover/40 active:bg-telegram-hover/60 text-telegram-subtext/60 hover:text-telegram-subtext transition-all duration-200"
                        aria-label="File actions"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Action popover for file operations */}
      {actionMenuFile && (
        <ActionPopover
          title={actionMenuFile.name}
          actions={buildFileActions(actionMenuFile)}
          onClose={() => setActionMenuFile(null)}
        />
      )}
    </>
  );
}
