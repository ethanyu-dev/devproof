import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";
import { Label } from "./label";

function Field({
  children,
  className,
  description,
  label,
}: {
  children: ReactNode;
  className?: string;
  description?: string;
  label: string;
}) {
  const generatedId = useId();
  const child = Children.only(children);
  const element = isValidElement(child)
    ? (child as ReactElement<{ "aria-describedby"?: string; id?: string }>)
    : null;
  const controlId = element?.props.id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const describedBy = [element?.props["aria-describedby"], descriptionId]
    .filter(Boolean)
    .join(" ");

  return (
    <div data-slot="field" className={cn("grid gap-1", className)}>
      <Label htmlFor={controlId}>{label}</Label>
      {element
        ? cloneElement(element, {
            ...(describedBy ? { "aria-describedby": describedBy } : {}),
            id: controlId,
          })
        : child}
      {description ? (
        <p
          className="text-[10px] leading-relaxed text-muted-foreground"
          id={descriptionId}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

export { Field };
