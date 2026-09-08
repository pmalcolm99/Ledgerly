import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Ledgerly",
  description: "Receipt capture and spend tracking.",
};

// App shell (header, safe-area insets, 100dvh) is Phase 7 task 7.2. This is
// the minimal Phase 2 skeleton the App Router requires to build at all.
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
