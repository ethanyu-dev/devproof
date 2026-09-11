"use client";

import {
  Children,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import styles from "./access.module.css";

const compactQuery = "(max-width: 640px)";
const mediumQuery = "(max-width: 1180px)";

function subscribeLayout(onChange: () => void) {
  const queries = [compactQuery, mediumQuery].map((query) =>
    window.matchMedia(query),
  );
  queries.forEach((query) => query.addEventListener("change", onChange));
  return () =>
    queries.forEach((query) => query.removeEventListener("change", onChange));
}

function getPageSize() {
  if (window.matchMedia(compactQuery).matches) return 2;
  return window.matchMedia(mediumQuery).matches ? 4 : 6;
}

function getServerPageSize() {
  return 6;
}

export function AccessCollection({
  children,
  count,
  label,
}: {
  children: ReactNode;
  count: number;
  label: string;
}) {
  const pageSize = useSyncExternalStore(
    subscribeLayout,
    getPageSize,
    getServerPageSize,
  );
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const currentPage = Math.min(page, pageCount);
  const start = (currentPage - 1) * pageSize;

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);

  return (
    <div aria-label={label} role="region" className={styles.collectionRegion}>
      {count > pageSize ? (
        <div className={styles.pagination}>
          <span aria-live="polite" aria-atomic="true">
            {start + 1}–{Math.min(start + pageSize, count)} / {count} 项
          </span>
          <div>
            <Button
              aria-label={`${label}上一页`}
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
              size="sm"
              variant="secondary"
            >
              <ChevronLeft />
            </Button>
            <span>
              {currentPage} / {pageCount}
            </span>
            <Button
              aria-label={`${label}下一页`}
              disabled={currentPage === pageCount}
              onClick={() => setPage(currentPage + 1)}
              size="sm"
              variant="secondary"
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
      <div className={styles.collection}>
        {Children.toArray(children).slice(start, start + pageSize)}
      </div>
    </div>
  );
}
