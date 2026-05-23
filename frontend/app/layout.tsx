import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { THEME_COOKIE, DEFAULT_THEME, Theme } from '@/lib/types';
import './globals.css';

export const metadata: Metadata = {
  title: 'TypeScript Coding Expert',
  description: 'Chat with a TypeScript domain-expert assistant.',
};

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
