'use client';

import { ReactElement, useEffect, useState } from 'react';
import { THEME_COOKIE, Theme } from '@/lib/types';

interface ThemeToggleProps {
  initialTheme: Theme;
}

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function writeCookie(theme: Theme): void {
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
}

/**
 * Theme toggle button. The initial value comes from the Server Component
 * (which already applied the right `dark` class to <html>), so the first
 * paint matches the user's preference with no flash.
 *
 * Clicking the button flips the class on documentElement immediately and
 * persists the choice in a cookie so the next SSR render keeps it.
 */
export function ThemeToggle({ initialTheme }: ThemeToggleProps): ReactElement {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  // Keep documentElement in sync if some other tab changed the cookie. Cheap
  // and defensive — not strictly required.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
  }, [theme]);

  const toggle = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    writeCookie(next);
  };

  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={isDark}
      className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white shadow-sm transition hover:bg-white/20"
    >
      {isDark ? 'Light mode' : 'Dark mode'}
    </button>
  );
}
