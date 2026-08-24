import type { Metadata } from "next";

import { ProfilesClient } from "./profiles-client";

export const metadata: Metadata = { title: "浏览器身份" };

export default function ProfilesPage() {
  return <ProfilesClient />;
}
