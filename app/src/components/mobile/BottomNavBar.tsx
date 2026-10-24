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
      className="fixed left-1/2 -translate-x-1/2 w-[88%] max-w-xs bg-white/95 dark:bg-[#1a1d24]/95 backdrop-blur-2xl border border-black/10 dark:border-white/10 rounded-full shadow-2xl flex justify-around items-center px-2 py-1.5 z-40 transition-all duration-300"
      style={{
        bottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
        boxShadow: '0 8px 30px rgba(0, 0, 0, 0.25)'
      }}
    >
      {tabs.map(({ id, labelKey, icon: Icon }) => {
        const isActive = activeTab === id;
        const showBadge = id === 'downloads' && activeTransfersCount > 0;

        return (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all duration-200 relative select-none ${
              isActive
                ? 'bg-telegram-primary/15 text-telegram-primary font-semibold'
                : 'text-telegram-subtext hover:text-telegram-text'
            }`}
          >
            <div className="relative flex items-center justify-center">
              <Icon className="w-4 h-4" />
              {showBadge && (
                <span className="absolute -top-1.5 -right-2 min-w-[14px] h-3.5 px-0.5 rounded-full bg-telegram-primary text-black text-[9px] font-bold flex items-center justify-center shadow-xs">
                  {activeTransfersCount > 99 ? '99+' : activeTransfersCount}
                </span>
              )}
            </div>
            <span className={`text-[11px] capitalize ${isActive ? 'inline' : 'hidden sm:inline'}`}>
              {t(labelKey)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
