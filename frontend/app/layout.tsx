import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TypeScript Coding Expert',
  description: 'Chat with a TypeScript domain-expert assistant.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="h-full">{children}</body>
    </html>
  );
}
