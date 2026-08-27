import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative grid w-full gap-1 rounded-lg border px-2.5 py-2 text-[10px] [&>svg]:absolute [&>svg]:left-2.5 [&>svg]:top-2.5 [&>svg]:size-3 [&>svg+div]:pl-5",
  {
    variants: {
      variant: {
        default: "border-border bg-card text-card-foreground",
        destructive: "border-destructive/20 bg-destructive/5 text-destructive",
        success: "border-emerald-200 bg-emerald-50 text-emerald-800",
        warning: "border-amber-200 bg-amber-50 text-amber-800",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      role="alert"
      data-slot="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("font-medium", className)}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-[10px] opacity-90", className)}
      {...props}
    />
  );
}

export { Alert, AlertDescription, AlertTitle };
