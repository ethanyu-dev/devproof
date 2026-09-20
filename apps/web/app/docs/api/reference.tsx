"use client";
import dynamic from "next/dynamic";
import "@scalar/api-reference-react/style.css";
import { docsFetch } from "@/lib/docs-fetch";
import styles from "../docs.module.css";
const Scalar = dynamic(
  () =>
    import("@scalar/api-reference-react").then(
      (module) => module.ApiReferenceReact,
    ),
  {
    ssr: false,
    loading: () => (
      <p className={styles.loading} role="status">
        正在加载 API 文档…
      </p>
    ),
  },
);
const configuration = {
  url: "/v2/openapi.json",
  theme: "default" as const,
  withDefaultFonts: false,
  persistAuth: false,
  locale: "zh-CN" as const,
  showDeveloperTools: "never" as const,
  agent: { disabled: true },
  mcp: { disabled: true },
  telemetry: false,
  customFetch: docsFetch,
};
export function ApiReference() {
  return <Scalar configuration={configuration} />;
}
