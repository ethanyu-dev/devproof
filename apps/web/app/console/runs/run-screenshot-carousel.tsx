"use client";

import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useState } from "react";
import styles from "./run-screenshot-carousel.module.css";

interface StepScreenshot {
  id: string;
  downloadUrl: string;
  commandType: string;
}

export function RunScreenshotCarousel({
  screenshots,
}: {
  screenshots: StepScreenshot[];
}) {
  // A null selection follows new screenshots; an ID keeps history stable on refresh.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIndex = screenshots.findIndex(({ id }) => id === selectedId);
  const index = selectedIndex < 0 ? screenshots.length - 1 : selectedIndex;
  const screenshot = screenshots[index];
  const isLatest = index === screenshots.length - 1;

  function move(direction: -1 | 1) {
    const nextIndex = index + direction;
    const nextScreenshot = screenshots[nextIndex];
    if (nextScreenshot) {
      setSelectedId(
        nextIndex === screenshots.length - 1 ? null : nextScreenshot.id,
      );
    }
  }

  if (!screenshot) return null;

  return (
    <section
      className={styles.carousel}
      aria-label="操作步骤截图"
      aria-roledescription="轮播"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          move(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className={styles.frame}>
        <a
          className={styles.imageLink}
          href={screenshot.downloadUrl}
          target="_blank"
          rel="noreferrer"
          title="查看原图"
        >
          <img
            key={screenshot.id}
            src={screenshot.downloadUrl}
            alt={`步骤 ${index + 1}：${screenshot.commandType}`}
          />
        </a>
        <Button
          className={`${styles.arrow} ${styles.previous}`}
          variant="outline"
          size="icon"
          aria-label="上一张截图"
          title="上一张截图（←）"
          disabled={index === 0}
          onClick={() => move(-1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          className={`${styles.arrow} ${styles.next}`}
          variant="outline"
          size="icon"
          aria-label="下一张截图"
          title="下一张截图（→）"
          disabled={isLatest}
          onClick={() => move(1)}
        >
          <ChevronRight />
        </Button>
      </div>
      <div className={styles.toolbar}>
        <div className={styles.caption} aria-live="polite" aria-atomic="true">
          <b>
            步骤 {index + 1} / {screenshots.length}
          </b>
          <span title={screenshot.commandType}>{screenshot.commandType}</span>
        </div>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            disabled={isLatest}
            onClick={() => setSelectedId(null)}
          >
            {isLatest ? "最新截图" : "回到最新"}
          </Button>
          <a
            href={screenshot.downloadUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="查看截图原图"
            title="查看原图"
          >
            <ExternalLink />
          </a>
        </div>
      </div>
    </section>
  );
}
