import type { Metadata } from "next";

import { VerificationsClient } from "../verifications-client";

export const metadata: Metadata = { title: "验证详情" };

export default async function VerificationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <VerificationsClient initialId={id} />;
}
