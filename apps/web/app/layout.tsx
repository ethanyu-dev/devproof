import type { Metadata } from "next";
import type { ReactNode } from "react";

import { THEME_INIT_SCRIPT } from "./theme";
import "./globals.css";

export const metadata: Metadata = {
  description: "团队集成测试控制台",
  robots: { follow: false, index: false },
  title: {
    default: "DevProof",
    template: "%s · DevProof",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
