// src/app/layout.tsx
import 'katex/dist/katex.min.css'; // ✅ KaTeX global CSS here

export const metadata = { title: 'Tutor Chat' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
