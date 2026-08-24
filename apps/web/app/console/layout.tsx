import type { ReactNode } from "react";

import { ConsoleShell } from "./shell";

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
