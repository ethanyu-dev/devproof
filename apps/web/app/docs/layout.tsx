import type { ReactNode } from "react";
import Link from "next/link";
import styles from "./docs.module.css";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <Link href="/docs" className={styles.brand}>
          <span>DP</span>DevProof <small>开发者文档</small>
        </Link>
        <nav aria-label="文档导航">
          <Link href="/docs">接入指南</Link>
          <Link href="/docs/api">API 参考</Link>
          <Link href="/login">进入控制台 ↗</Link>
        </nav>
      </header>
      {children}
    </div>
  );
}
