import type { Metadata } from "next";

import { PlaygroundClient } from "./playground-client";

export const metadata: Metadata = { title: "统一执行试验场" };

export default function PlaygroundPage() {
  return <PlaygroundClient />;
}
