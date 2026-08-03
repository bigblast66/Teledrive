import { useState } from 'react';
import { type } from '@tauri-apps/plugin-os';

interface PlatformInfo {
  isMobile: boolean;
  isDesktop: boolean;
  isAndroid: boolean;
}

// `type()` from @tauri-apps/plugin-os is synchronous, so we can resolve the
// real platform before the first paint instead of guessing "desktop" and
// correcting it a tick later via useEffect. That earlier version briefly
// mounted DesktopDashboard on Android/iOS on every cold start (and every time
// this hook was used elsewhere), which:
//  - flashed the desktop UI before swapping to mobile (the "glitchy dashboard")
//  - registered DesktopDashboard's data-fetching effects (file listing,
//    'folder-load-chunk' listener, cmd_get_files invoke) which then raced
//    against MobileDashboard's identical effects once the swap happened,
//    producing duplicate/overlapping loads of the same folder
//  - reset/lost any selection or preview state that had already been set up
// Computing this once, synchronously, in useState's initializer avoids all of
// that: the correct dashboard mounts on the very first render.
function detectPlatform(): PlatformInfo {
  try {
    const osType = type();
    const isAndroid = osType === 'android';
    const isIos = osType === 'ios';
    const isMobile = isAndroid || isIos;
    return { isMobile, isDesktop: !isMobile, isAndroid };
  } catch (e) {
    // Fallback for browser/development environments
    const ua = navigator.userAgent.toLowerCase();
    const isAndroid = ua.includes('android');
    const isMobile = isAndroid || ua.includes('iphone') || ua.includes('ipad');
    return { isMobile, isDesktop: !isMobile, isAndroid };
  }
}

export function usePlatform(): PlatformInfo {
  const [platformInfo] = useState(detectPlatform);
  return platformInfo;
}