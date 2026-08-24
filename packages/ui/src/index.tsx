import { Slot } from "@radix-ui/react-slot";
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "./utils";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ asChild = false, className, variant = "primary", ...props }, ref) => {
    const Component = asChild ? Slot : "button";
    return (
      <Component
        className={cn("dp-button", "dp-button-" + variant, className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div className={cn("dp-card", className)} ref={ref} {...props} />
  ),
);
Card.displayName = "Card";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input className={cn("dp-input", className)} ref={ref} {...props} />
));
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea className={cn("dp-textarea", className)} ref={ref} {...props} />
));
Textarea.displayName = "Textarea";

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    className={cn("dp-input dp-select", className)}
    ref={ref}
    {...props}
  />
));
Select.displayName = "Select";

export const Label = forwardRef<
  HTMLLabelElement,
  LabelHTMLAttributes<HTMLLabelElement>
>(({ className, ...props }, ref) => (
  <label className={cn("dp-label", className)} ref={ref} {...props} />
));
Label.displayName = "Label";

export function Field({
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
    ? (child as ReactElement<{
        "aria-describedby"?: string;
        id?: string;
      }>)
    : null;
  const controlId = element?.props.id ?? generatedId;
  const descriptionId = description ? `${controlId}-description` : undefined;
  const describedBy = [element?.props["aria-describedby"], descriptionId]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("dp-field", className)}>
      <Label htmlFor={controlId}>{label}</Label>
      {element
        ? cloneElement(element, {
            ...(describedBy ? { "aria-describedby": describedBy } : {}),
            id: controlId,
          })
        : child}
      {description ? <small id={descriptionId}>{description}</small> : null}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return <span className={"dp-badge dp-badge-" + tone}>{children}</span>;
}

export function Toggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="dp-toggle-row">
      <span>{label}</span>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
    </label>
  );
}
