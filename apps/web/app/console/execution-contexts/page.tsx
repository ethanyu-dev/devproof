import type { Metadata } from "next";
import { ExecutionContexts } from "./execution-contexts";
export const metadata: Metadata = { title: "Step Context 执行分析" };
export default function Page() {
  return <ExecutionContexts />;
}
