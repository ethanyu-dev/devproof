/** Two encoding attempts plus Chromium startup must fit the 30 s close budget.
 * All original step images remain available as artifacts; only the overview video
 * samples long runs, preserving both the first and final frame.
 */
export function stepVideoPlan<T>(frames: readonly T[]) {
  const count = Math.min(60, frames.length);
  const selected =
    count < frames.length
      ? Array.from(
          { length: count },
          (_, i) =>
            frames[Math.round((i * (frames.length - 1)) / (count - 1))]!,
        )
      : [...frames];
  const frameDurationMs = Math.min(750, Math.floor(6000 / Math.max(1, count)));
  return {
    frames: selected,
    frameDurationMs,
    durationMs: Math.max(700, count * frameDurationMs),
    sourceFrameCount: frames.length,
  };
}
