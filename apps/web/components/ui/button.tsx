import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-[color,background-color,border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover",
        primary:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover",
        destructive:
          "bg-destructive text-white shadow-sm hover:bg-destructive/90 focus-visible:ring-destructive/25",
        danger:
          "bg-destructive text-white shadow-sm hover:bg-destructive/90 focus-visible:ring-destructive/25",
        outline:
          "border border-border bg-card shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/75",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3 py-2",
        sm: "h-8 px-2.5 text-xs",
        lg: "h-10 px-4 text-sm",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { size: "default", variant: "default" },
  },
);

function Button({
  asChild = false,
  className,
  size,
  variant,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return (
    <Component
      data-slot="button"
      className={cn(buttonVariants({ className, size, variant }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
