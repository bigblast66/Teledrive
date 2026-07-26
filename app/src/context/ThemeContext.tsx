import { createContext, useContext, useState, ReactNode, useLayoutEffect, useCallback } from 'react';
import { CustomTheme, applyTheme as applyThemeToDOM, removeCustomTheme as removeCustomThemeFromDOM } from '../theme/themeEngine';
import { BUILTIN_THEMES } from '../theme/presets';


type Theme = 'light' | 'dark';

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
    setTheme: (theme: Theme) => void;
    // Custom theme engine
    customThemes: CustomTheme[];
    activeCustomThemeId: string | null;
    setActiveCustomTheme: (id: string | null) => void;
    addCustomTheme: (theme: CustomTheme) => void;
    deleteCustomTheme: (id: string) => void;
    updateCustomTheme: (id: string, patch: Partial<CustomTheme>) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// Safe localStorage read: returns the value or null on any error
function safeTryGet(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

// Safe localStorage write: best-effort, silently ignores errors
function safeTrySet(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage unavailable — theme still works in-memory for this session
    }
}

// Get initial theme synchronously to prevent flash
function getInitialTheme(): Theme {
    if (typeof window !== 'undefined') {
        const saved = safeTryGet('theme') as Theme | null;
        if (saved === 'light' || saved === 'dark') return saved;
        if (window.matchMedia('(prefers-color-scheme: light)').matches) {
            return 'light';
        }
    }
    return 'dark';
}

// Apply theme to DOM immediately
function applyBaseTheme(theme: Theme) {
    const root = document.documentElement;
    if (theme === 'light') {
        root.classList.add('light');
        root.classList.remove('dark');
    } else {
        root.classList.add('dark');
        root.classList.remove('light');
    }
}

// Load user-created themes from localStorage
function loadUserThemes(): CustomTheme[] {
    const raw = safeTryGet('user-themes');
    if (!raw) return [];
    try {
        return JSON.parse(raw) as CustomTheme[];
    } catch {
        return [];
    }
}

function saveUserThemes(themes: CustomTheme[]): void {
    safeTrySet('user-themes', JSON.stringify(themes));
}

// Apply theme immediately on script load (before React hydration)
if (typeof window !== 'undefined') {
    applyBaseTheme(getInitialTheme());
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<Theme>(getInitialTheme);
    const [userThemes, setUserThemes] = useState<CustomTheme[]>(() => loadUserThemes());
    const [activeCustomThemeId, setActiveCustomThemeIdState] = useState<string | null>(
        () => safeTryGet('active-custom-theme-id')
    );

    // All available themes: builtins + user-created
    const allThemes = [...BUILTIN_THEMES, ...userThemes];

    // Apply base theme to DOM
    useLayoutEffect(() => {
        if (!activeCustomThemeId) {
            removeCustomThemeFromDOM();
            applyBaseTheme(theme);
        }
        safeTrySet('theme', theme);
    }, [theme, activeCustomThemeId]);

    // Apply custom theme to DOM
    useLayoutEffect(() => {
        if (activeCustomThemeId) {
            const found = allThemes.find(t => t.id === activeCustomThemeId);
            if (found) {
                applyThemeToDOM(found);
            } else {
                // Theme was deleted — clear
                setActiveCustomThemeIdState(null);
                safeTrySet('active-custom-theme-id', '');
                removeCustomThemeFromDOM();
                applyBaseTheme(theme);
            }
        }
    }, [activeCustomThemeId, allThemes, theme]);

    
    const runThemeTransition = useCallback((updateFn: () => void, prevIsDark: boolean, goingDark: boolean) => {
        const supportsMask = typeof CSS !== 'undefined' &&
            (CSS.supports('mask-image', 'linear-gradient(black, transparent)') ||
            CSS.supports('-webkit-mask-image', 'linear-gradient(black, transparent)'));

        if (!supportsMask) {
            updateFn();
            return;
        }

        document.documentElement.classList.add('theme-transitioning');

        const oldColor = prevIsDark ? '#0f0f0f' : '#ffffff';
        // going dark: line sweeps from top-left toward bottom-right.
        // going light: line sweeps from bottom-right toward top-left.
        const direction = goingDark ? 'to bottom right' : 'to top left';

        updateFn();

        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '2147483647';
        overlay.style.pointerEvents = 'none';
        overlay.style.backgroundColor = oldColor;
        document.body.appendChild(overlay);

        const duration = 700;
        const start = performance.now();

        // Sweep the reveal edge from -10% to 110% so it clears both corners fully
        const setWipe = (progress: number) => {
            const pos = progress * 120 - 10;
            const maskValue = `linear-gradient(${direction}, transparent ${pos}%, black ${pos + 0.5}%)`;
            overlay.style.maskImage = maskValue;
            (overlay.style as any).webkitMaskImage = maskValue;
        };

        setWipe(0);

        
        function step(now: number) {
            const t = Math.min((now - start) / duration, 1);
            const eased = 1 - Math.pow(1 - t, 2.2); // moderate ease-out — quicker than cubic, gentler than exponential
            setWipe(eased);
            if (t < 1) {
                requestAnimationFrame(step);
            } else {
                overlay.remove();
                document.documentElement.classList.remove('theme-transitioning');
            }
        }
        
        requestAnimationFrame(step);
    }, []);

    const toggleTheme = useCallback(() => {
        const prevIsDark = activeCustomThemeId
            ? !!(allThemes.find(t => t.id === activeCustomThemeId)?.isDark)
            : theme === 'dark';
        const goingDark = !prevIsDark;

        runThemeTransition(() => {
            if (activeCustomThemeId) {
                const activeTheme = allThemes.find(t => t.id === activeCustomThemeId);
                const nextBase: Theme = activeTheme?.isDark ? 'light' : 'dark';
                setActiveCustomThemeIdState(null);
                safeTrySet('active-custom-theme-id', '');
                removeCustomThemeFromDOM();
                setThemeState(nextBase);
            } else {
                setThemeState(t => t === 'dark' ? 'light' : 'dark');
            }
        }, prevIsDark, goingDark);
    }, [activeCustomThemeId, allThemes, theme, runThemeTransition]);

    const setTheme = useCallback((newTheme: Theme) => {
        const prevIsDark = theme === 'dark';
        const goingDark = newTheme === 'dark';
        runThemeTransition(() => {
            setThemeState(newTheme);
        }, prevIsDark, goingDark);
    }, [theme, runThemeTransition]);

    const setActiveCustomTheme = useCallback((id: string | null) => {
        setActiveCustomThemeIdState(id);
        safeTrySet('active-custom-theme-id', id || '');
        if (!id) {
            removeCustomThemeFromDOM();
            applyBaseTheme(theme);
        }
    }, [theme]);

    const addCustomTheme = useCallback((t: CustomTheme) => {
        setUserThemes(prev => {
            const next = [...prev, t];
            saveUserThemes(next);
            return next;
        });
    }, []);

    const deleteCustomTheme = useCallback((id: string) => {
        setUserThemes(prev => {
            const next = prev.filter(t => t.id !== id);
            saveUserThemes(next);
            return next;
        });
        // If the deleted theme was active, deactivate
        setActiveCustomThemeIdState(prev => {
            if (prev === id) {
                safeTrySet('active-custom-theme-id', '');
                removeCustomThemeFromDOM();
                applyBaseTheme(theme);
                return null;
            }
            return prev;
        });
    }, [theme]);

    const updateCustomTheme = useCallback((id: string, patch: Partial<CustomTheme>) => {
        setUserThemes(prev => {
            const next = prev.map(t => t.id === id ? { ...t, ...patch, id } : t);
            saveUserThemes(next);
            return next;
        });
    }, []);

    return (
        <ThemeContext.Provider value={{
            theme,
            toggleTheme,
            setTheme,
            customThemes: allThemes,
            activeCustomThemeId,
            setActiveCustomTheme,
            addCustomTheme,
            deleteCustomTheme,
            updateCustomTheme,
        }}>
            {children}
        </ThemeContext.Provider>
    );
}

export const useTheme = () => {
    const context = useContext(ThemeContext);
    if (!context) throw new Error('useTheme must be used within a ThemeProvider');
    return context;
};
