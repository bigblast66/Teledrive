import { useState } from 'react';
import { Folder, MoreVertical, Check, DownloadCloud, Trash2 } from 'lucide-react';
import { TelegramFile } from '../../../types';
import { createDragGhost } from '../../../utils';
import { FileTypeIcon } from '../../shared/FileTypeIcon';
import { useVideoMetadata } from '../../../hooks/useVideoMetadata';
import { useCachedVariants } from '../../../hooks/useCachedVariants';
import { VideoMetaBadge } from '../../shared/VideoMetaBadge';


interface FileListItemProps {
    file: TelegramFile;
    selectedIds: number[];
    onFileClick: (e: React.MouseEvent, id: number) => void;
    onOpen: (file: TelegramFile) => void;
    onToggleSelection: (id: number) => void;
    onDownload: (id: number, name: string) => void;
    onDelete: (id: number) => void;
    handleContextMenu: (e: React.MouseEvent, file: TelegramFile) => void;
    onDragStart?: (fileIds: number[]) => void;
    onDragEnd?: () => void;
    onDrop?: (e: React.DragEvent, folderId: number) => void;
}

export function FileListItem({
    file, selectedIds, onFileClick, onOpen, onToggleSelection, onDownload, onDelete, handleContextMenu,
    onDragStart, onDragEnd, onDrop
}: FileListItemProps) {
    const [isDragOver, setIsDragOver] = useState(false);
    const isFolder = file.type === 'folder';
    const isSelected = selectedIds.includes(file.id);

    // Lazy video metadata badge (.mp4 only)
    const { data: videoMeta, isLoading: videoMetaLoading } = useVideoMetadata(
        file.id,
        file.folder_id ?? null,
        file.name,
    );

    // Cached HLS variants
    const { data: cachedVariants } = useCachedVariants(
        file.id,
        file.folder_id ?? null,
        file.name,
    );
    const cachedQualities = (cachedVariants || []).filter(v => v.available).map(v => v.quality);

    const handleRowClick = (e: React.MouseEvent) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
            // Power-user multi-select shortcuts still work on the row itself
            onFileClick(e, file.id);
        } else if (selectedIds.length > 0) {
            // Already in "selection mode" (at least one checkbox is checked)
            // — plain clicks extend/replace the selection instead of opening,
            // matching Gmail/Drive behavior once selection has started.
            onFileClick(e, file.id);
        } else {
            // Normal case: no selection active — click just opens it.
            onOpen(file);
        }
    };

    return (
        <div
            onClick={handleRowClick}
            onContextMenu={(e) => handleContextMenu(e, file)}
            draggable
            onDragStart={(e) => {
                const idsToDrag = selectedIds.includes(file.id) ? selectedIds : [file.id];
                if (onDragStart) onDragStart(idsToDrag);
                e.dataTransfer.setData("application/x-telegram-file-ids", JSON.stringify(idsToDrag));
                e.dataTransfer.effectAllowed = 'move';
                const dragCount = idsToDrag.length;
                const ghost = createDragGhost(file.name, isFolder, dragCount);
                e.dataTransfer.setDragImage(ghost, 0, 0);
                requestAnimationFrame(() => ghost.remove());
            }}
            onDragEnd={() => {
                if (onDragEnd) onDragEnd();
            }}
            onDragOver={(e) => {
                if (isFolder) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isDragOver) setIsDragOver(true);
                }
            }}
            onDragLeave={(e) => {
                if (isFolder) {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);
                }
            }}
            onDrop={(e) => {
                if (isFolder && onDrop) {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDragOver(false);
                    onDrop(e, file.id);
                }
            }}
            className={`group grid grid-cols-[2rem_minmax(0,1fr)_5.5rem] sm:grid-cols-[2rem_minmax(0,2fr)_6rem_8rem_5.5rem] gap-4 items-center px-4 py-3 rounded-lg cursor-pointer border border-transparent transition-all hover:bg-telegram-hover
                ${isSelected ? 'bg-telegram-primary/10 border-telegram-primary/20' : ''}
                ${isDragOver ? 'ring-2 ring-telegram-primary bg-telegram-primary/20' : ''}
            `}
        >
            <div className="flex justify-center relative w-5 h-5">
                {/* Checkbox: hidden by default, revealed on row hover, always
                    visible once checked. Clicking it never opens the file. */}
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onToggleSelection(file.id);
                    }}
                    className={`absolute inset-0 flex items-center justify-center rounded border transition-opacity
                        ${isSelected ? 'opacity-100 bg-telegram-primary border-telegram-primary' : 'opacity-0 group-hover:opacity-100 bg-telegram-surface border-telegram-border'}
                    `}
                    title={isSelected ? "Deselect" : "Select"}
                    aria-label={isSelected ? "Deselect" : "Select"}
                >
                    {isSelected && <Check className="w-3.5 h-3.5 text-white" />}
                </button>
                <div className={`pointer-events-none ${isSelected ? 'opacity-0' : 'opacity-100 group-hover:opacity-0 transition-opacity'}`}>
                    {isFolder ? <Folder className="w-5 h-5 text-telegram-primary" /> : <FileTypeIcon filename={file.name} className="w-5 h-5" />}
                </div>
            </div>
            <div className="min-w-0 truncate text-sm text-telegram-text font-medium">
                <span>{file.name}</span>
                <VideoMetaBadge metadata={videoMeta} isLoading={videoMetaLoading} />
                {cachedQualities.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 ml-1.5">
                        {cachedQualities.map(q => (
                            <span key={q} className="inline-flex items-center gap-0.5 text-[9px] font-medium text-emerald-400 bg-emerald-500/10 px-1 py-0.5 rounded">
                                <Check className="w-2.5 h-2.5" />
                                {q}
                            </span>
                        ))}
                    </span>
                )}
            </div>
            <div className="hidden sm:block text-right text-xs text-telegram-subtext truncate">{file.sizeStr}</div>
            <div className="hidden sm:block text-right text-xs text-telegram-subtext font-mono opacity-50 truncate">{file.created_at || '-'}</div>

            {/* Direct action buttons: Download + Delete only (the truly
                frequent ones). Everything else (Preview, Share, Rename,
                Move) lives in the 3-dot menu — no duplication. */}
            <div className="flex justify-end items-center gap-1">
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDownload(file.id, file.name);
                    }}
                    className="opacity-100 group-hover:opacity-100 focus-visible:opacity-100 p-1 bg-telegram-surface hover:bg-telegram-hover border border-telegram-border shadow-md rounded text-telegram-subtext hover:text-telegram-text transition-all"
                    title="Download"
                    aria-label="Download"
                >
                    <DownloadCloud className="w-4 h-4" />
                </button>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete(file.id);
                    }}
                    className="opacity-100 group-hover:opacity-100 focus-visible:opacity-100 p-1 bg-telegram-surface hover:bg-red-500/10 border border-telegram-border shadow-md rounded text-telegram-subtext hover:text-red-500 transition-all"
                    title="Delete"
                    aria-label="Delete"
                >
                    <Trash2 className="w-4 h-4" />
                </button>
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        handleContextMenu(e, file);
                    }}
                    className="opacity-100 group-hover:opacity-100 focus-visible:opacity-100 p-1 bg-telegram-surface hover:bg-telegram-hover border border-telegram-border shadow-md rounded text-telegram-subtext hover:text-telegram-text transition-all"
                    title="More actions"
                    aria-label="More actions"
                >
                    <MoreVertical className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}