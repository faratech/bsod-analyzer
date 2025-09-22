import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  resetToSystemPreference: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [theme, setTheme] = useState<Theme>(() => {
    // Check localStorage first - but only if explicitly set by user toggle
    const stored = localStorage.getItem('theme');
    const hasUserPreference = localStorage.getItem('theme-manually-set') === 'true';

    if (hasUserPreference && (stored === 'light' || stored === 'dark')) {
      return stored;
    }

    // Check system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }

    // Default to dark
    return 'dark';
  });

  useEffect(() => {
    // Update HTML class
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(theme);

    // Only save to localStorage if it's not the system default
    const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const systemPrefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;

    // Only save if different from system preference or manually set
    const hasUserPreference = localStorage.getItem('theme-manually-set') === 'true';
    if (hasUserPreference) {
      localStorage.setItem('theme', theme);
    }

    // Update meta theme-color
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#ffffff');
    }
  }, [theme]);

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');

    const handleChange = (e: MediaQueryListEvent) => {
      // Only auto-switch if user hasn't manually set a preference
      const hasUserPreference = localStorage.getItem('theme-manually-set') === 'true';
      if (!hasUserPreference) {
        setTheme(e.matches ? 'light' : 'dark');
      }
    };

    // Modern browsers
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange);
      return () => mediaQuery.removeEventListener('change', handleChange);
    }
    // Legacy browsers
    else if (mediaQuery.addListener) {
      mediaQuery.addListener(handleChange);
      return () => mediaQuery.removeListener(handleChange);
    }
  }, []);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
    // Mark that user has manually set a preference
    localStorage.setItem('theme-manually-set', 'true');
    localStorage.setItem('theme', theme === 'dark' ? 'light' : 'dark');
  };

  const resetToSystemPreference = () => {
    // Clear manual preference
    localStorage.removeItem('theme');
    localStorage.removeItem('theme-manually-set');

    // Set theme based on system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      setTheme('light');
    } else {
      setTheme('dark');
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, resetToSystemPreference }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};