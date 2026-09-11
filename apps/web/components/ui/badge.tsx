import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-sm border px-2 py-0.5 text-xs font-medium leading-4 whitespace-nowrap [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          "border-destructive/20 bg-destructive-soft text-destructive",
        outline: "border-border bg-background text-foreground",
        success: "border-success/20 bg-success-soft text-success",
        warning: "border-warning/20 bg-warning-soft text-warning",
        info: "border-info/20 bg-info-soft text-info",
        neutral: "border-border bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

function Badge({
  className,
  tone,
  variant,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { tone?: BadgeTone }) {
  const resolvedVariant = tone === "danger" ? "destructive" : (tone ?? variant);
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant: resolvedVariant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
