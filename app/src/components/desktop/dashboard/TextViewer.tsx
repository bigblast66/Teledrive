import { useEffect, useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { TelegramFile } from '../../../types';

interface TextViewerProps {
    file: TelegramFile;
    onClose: () => void;
    onNext?: () => void;
    onPrev?: () => void;
    currentIndex?: number;
    totalItems?: number;
    activeFolderId: number | null;
}

export function TextViewer({ file, onClose, onNext, onPrev, currentIndex, totalItems, activeFolderId }: TextViewerProps) {
    const [content, setContent] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setContent(null);

        invoke<string>('cmd_get_text_preview', { messageId: file.id, folderId: activeFolderId })
            .then((text) => { if (!cancelled) { setContent(text); setLoading(false); } })
            .catch((err) => { if (!cancelled) { setError(String(err)); setLoading(false); } });

        return () => { cancelled = true; };
    }, [file.id, activeFolderId]);

    return (
        <div className="fixed inset-0 z-[200] bg-black/90 flex flex-col p-4 backdrop-blur-md" onClick={onClose}>
            <div className="absolute top-0 left-0 right-0 flex justify-between items-center px-4 md:px-8 z-50 pt-[calc(1rem+env(safe-area-inset-top))]">
                <div className="text-white bg-black/40 backdrop-blur-md px-4 py-2 rounded-full border border-white/10">
                    <h3 className="text-sm font-medium truncate max-w-xs">{file.name}</h3>
                </div>
                <button onClick={onClose} className="p-3 text-white/50 hover:text-white bg-black/40 rounded-full border border-white/10">
                    <X className="w-5 h-5" />
                </button>
            </div>

            <button onClick={(e) => { e.stopPropagation(); onPrev?.(); }} className="absolute left-4 top-1/2 -translate-y-1/2 p-3 text-white/50 hover:text-white bg-black/40 rounded-full z-10 border border-white/10">
                <ChevronLeft className="w-6 h-6" />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onNext?.(); }} className="absolute right-4 top-1/2 -translate-y-1/2 p-3 text-white/50 hover:text-white bg-black/40 rounded-full z-10 border border-white/10">
                <ChevronRight className="w-6 h-6" />
            </button>

            <div
                className="flex-1 w-full overflow-auto custom-scrollbar pt-20 pb-24"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="max-w-4xl mx-auto">
                    {loading && <p className="text-white/60 text-center mt-20">Loading...</p>}
                    {error && <p className="text-red-400 text-center mt-20">{error}</p>}
                    {content !== null && (
                        <pre className="bg-telegram-surface text-telegram-text text-sm p-4 rounded-lg whitespace-pre-wrap break-words">
                            {content}
                        </pre>
                    )}
                </div>
            </div>

            {typeof currentIndex === 'number' && typeof totalItems === 'number' && totalItems > 0 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/50 text-sm bg-black/40 px-4 py-1.5 rounded-full border border-white/10">
                    File {currentIndex + 1} of {totalItems}
                </div>
            )}
        </div>
    );
}