import type { Metadata } from "next";

import { ProfilesClient } from "./profiles-client";

export const metadata: Metadata = { title: "用户浏览器 Profile" };

export default function ProfilesPage() {
  return <ProfilesClient />;
}
