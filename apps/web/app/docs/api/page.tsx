import type { Metadata } from "next";
import { ApiReference } from "./reference";
import styles from "../docs.module.css";
export const metadata: Metadata = {
  title: "API 参考",
  description:
    "DevProof 对外任务 API：参数、响应、示例与 Bearer Token 在线调试。",
};
export default function ApiDocsPage() {
  return (
    <main>
      <p className={styles.referenceNote}>
        公开文档 · 点击接口的测试按钮并填写自己的 Bearer Token。请求直接发送到
        DevProof；不会携带控制台登录 Cookie，也不会持久保存
        Token。示例数据仅用于说明。
      </p>
      <ApiReference />
    </main>
  );
}
