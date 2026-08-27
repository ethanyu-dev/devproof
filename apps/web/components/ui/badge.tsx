import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-3 whitespace-nowrap [&>svg]:size-2.5",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        destructive: "border-transparent bg-destructive/10 text-destructive",
        outline: "border-border bg-background text-foreground",
        success: "border-emerald-200 bg-emerald-50 text-emerald-700",
        warning: "border-amber-200 bg-amber-50 text-amber-700",
        neutral: "border-border bg-muted text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

type BadgeTone = "neutral" | "success" | "warning" | "danger";

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
