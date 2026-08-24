import type { Metadata } from "next";

import { PlaygroundClient } from "./playground-client";

export const metadata: Metadata = { title: "集成试验场" };

export default function PlaygroundPage() {
  return <PlaygroundClient />;
}
