import { notFound } from "next/navigation";
import { RuntimeDrainPanel } from "../../../runtime-drain-panel";

export const metadata = { title: "节点排空与恢复" };
export default async function RuntimeRecoveryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)) notFound();
  return <RuntimeDrainPanel key={id} runtimeId={id} />;
}
