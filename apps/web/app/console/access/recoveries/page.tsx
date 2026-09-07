import { Suspense } from "react";
import { LoadingState } from "@/components/settings-layout";
import { RuntimeRecoveryList } from "../runtime-recovery-list";

export const metadata = { title: "会话恢复" };
export default function RecoveryListPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <RuntimeRecoveryList />
    </Suspense>
  );
}
