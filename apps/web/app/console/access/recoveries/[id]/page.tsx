import { notFound } from "next/navigation";
import { RuntimeRecoveryDetailView } from "../../runtime-recovery-detail";

export const metadata = { title: "恢复详情" };
export default async function RecoveryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ list?: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)) notFound();
  const search = await searchParams;
  return (
    <RuntimeRecoveryDetailView
      key={id}
      id={id}
      listQuery={typeof search.list === "string" ? search.list : ""}
    />
  );
}
