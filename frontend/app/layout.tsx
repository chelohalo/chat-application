import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import {
  THEME_COOKIE,
  DEFAULT_THEME,
  DEFAULT_EXPERT_CONFIG,
  Theme,
} from '@/lib/types';
import { fetchExpertConfig } from '@/lib/nest-client';
import './globals.css';

/**
 * Resolve `<title>` and `<meta name="description">` from the backend's
 * configured persona. Falls back to DEFAULT_EXPERT_CONFIG (TypeScript) if
 * /chat/config is unreachable at SSR time so search engines/social cards
 * never see blank metadata.
 */
export async function generateMetadata(): Promise<Metadata> {
  const cfg = (await fetchExpertConfig()) ?? DEFAULT_EXPERT_CONFIG;
  return {
    title: cfg.appTitle,
    description: cfg.description,
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const jar = await cookies();
  const cookieTheme = jar.get(THEME_COOKIE)?.value;
  const theme: Theme =
    cookieTheme === 'light' || cookieTheme === 'dark' ? cookieTheme : DEFAULT_THEME;

  return (
    <html lang="en" className={theme === 'dark' ? 'dark' : ''}>
      <body className="h-full">{children}</body>
    </html>
  );
}
