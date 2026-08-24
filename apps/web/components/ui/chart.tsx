"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";

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
        className={`dp-chart-container${className ? ` ${className}` : ""}`}
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
    <div className="dp-chart-tooltip">
      {label ? <b>{label}</b> : null}
      <div>
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
            <span key={key}>
              <i style={color ? { background: color } : undefined} />
              <small>{itemLabel as React.ReactNode}</small>
              <strong>
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
