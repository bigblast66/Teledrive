import { Folder, Download, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface BottomNavBarProps {
  activeTab: 'files' | 'downloads' | 'settings';
  setActiveTab: (tab: 'files' | 'downloads' | 'settings') => void;
  isAndroid?: boolean;
  activeTransfersCount?: number;
}

export function BottomNavBar({ activeTab, setActiveTab, activeTransfersCount = 0 }: BottomNavBarProps) {
  const { t } = useTranslation();

  const tabs = [
    { id: 'files', labelKey: 'common.files', icon: Folder },
    { id: 'downloads', labelKey: 'common.transfers', icon: Download },
    { id: 'settings', labelKey: 'common.settings', icon: Settings },
  ] as const;

  return (
    <nav
      className="fixed left-4 right-4 bg-telegram-bg/90 backdrop-blur-xl border border-telegram-border/50 rounded-2xl shadow-2xl flex justify-around py-3 z-50 transition-all duration-300"
      style={{ bottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}
    >
      {tabs.map(({ id, labelKey, icon: Icon }) => {
        const isActive = activeTab === id;
        const showBadge = id === 'downloads' && activeTransfersCount > 0;

        return (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex flex-col items-center gap-1 transition-all duration-300 relative px-3 py-1 ${
              isActive ? 'text-telegram-primary scale-105' : 'text-telegram-subtext hover:text-telegram-text'
            }`}
          >
            <div className="relative">
              <Icon className="w-5 h-5" />
              {showBadge && (
                <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-telegram-primary text-black text-[10px] font-bold flex items-center justify-center animate-pulse shadow-sm">
                  {activeTransfersCount > 99 ? '99+' : activeTransfersCount}
                </span>
              )}
            </div>
            <span className="text-[10px] font-bold tracking-wide uppercase">{t(labelKey)}</span>
            {isActive && (
              <span className="absolute -bottom-1 w-1.5 h-1.5 bg-telegram-primary rounded-full shadow-[0_0_8px_var(--telegram-primary)]" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
