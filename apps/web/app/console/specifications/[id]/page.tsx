import { redirect } from "next/navigation";

export default async function SpecificationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/console/runs/${id}`);
}
