import type { Metadata } from "next";

import { AccessClient } from "./access-client";

export const metadata: Metadata = { title: "接入配置" };

export default function AccessPage() {
  return <AccessClient />;
}
