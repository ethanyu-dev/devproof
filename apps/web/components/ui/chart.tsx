"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";

import { cn } from "@/lib/utils";

export type ChartConfig = Record<
  string,
  {
    color?: string;
    label?: React.ReactNode;
  }
>;

const ChartContext = React.createContext<ChartConfig | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error("Chart components must be rendered inside ChartContainer.");
  }
  return context;
}

export function ChartContainer({
  children,
  className,
  config,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  children: React.ReactElement;
  config: ChartConfig;
}) {
  return (
    <ChartContext.Provider value={config}>
      <div
        data-slot="chart"
        className={cn(
          "relative flex w-full min-w-0 justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line]:stroke-border/60 [&_.recharts-layer]:outline-none [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none",
          className,
        )}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

interface TooltipPayloadItem {
  color?: string;
  dataKey?: string | number;
  name?: string | number;
  payload?: Record<string, unknown>;
  value?: number | string | readonly (number | string)[];
}

export function ChartTooltipContent({
  active,
  label,
  payload,
  valueFormatter,
}: {
  active?: boolean;
  label?: React.ReactNode;
  payload?: readonly TooltipPayloadItem[];
  valueFormatter?: (
    value: TooltipPayloadItem["value"],
    item: TooltipPayloadItem,
  ) => React.ReactNode;
}) {
  const config = useChart();

  if (!active || !payload?.length) return null;

  return (
    <div className="grid min-w-32 gap-1.5 rounded-lg border border-border/80 bg-background px-3 py-2 text-xs shadow-xl">
      {label ? <b className="font-medium">{label}</b> : null}
      <div className="grid gap-1.5">
        {payload.map((item, index) => {
          const key = String(
            item.payload?.status ?? item.dataKey ?? item.name ?? index,
          );
          const itemConfig = config[key] ?? config[String(item.dataKey ?? "")];
          const itemLabel =
            item.payload?.label ?? itemConfig?.label ?? item.name ?? key;
          const color =
            (item.payload?.fill as string | undefined) ??
            item.color ??
            itemConfig?.color;

          return (
            <span className="flex items-center gap-2" key={key}>
              <i
                className="size-2 rounded-[2px]"
                style={color ? { background: color } : undefined}
              />
              <small className="flex-1 text-muted-foreground">
                {itemLabel as React.ReactNode}
              </small>
              <strong className="font-mono font-medium tabular-nums">
                {valueFormatter
                  ? valueFormatter(item.value, item)
                  : String(item.value ?? "—")}
              </strong>
            </span>
          );
        })}
      </div>
    </div>
  );
}
