import * as React from "react";
import { cn } from "../utils/cn";

export interface CtaProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  eyebrow?: string;
  title: string;
  description?: string;
  primaryAction?: React.ReactNode;
  secondaryAction?: React.ReactNode;
}

export function Cta({
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryAction,
  className,
  ...props
}: CtaProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl bg-primary-800 px-8 py-10 text-neutral-100 shadow-float md:px-12",
        className
      )}
      {...props}
    >
      <div className="relative z-10 flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
        <div className="max-w-xl">
          {eyebrow ? (
            <span className="text-overline uppercase tracking-[0.22em] text-neutral-100/85">
              {eyebrow}
            </span>
          ) : null}
          <h2 className="mt-2 font-display text-headline leading-tight text-neutral-100">
            {title}
          </h2>
          {description ? (
            <p className="mt-2 text-body text-neutral-100/85">{description}</p>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          {primaryAction}
          {secondaryAction}
        </div>
      </div>
      <div className="absolute inset-y-0 right-[-10%] w-1/2 rounded-full bg-accent-500/20 blur-xl" />
      <div className="absolute inset-0 bg-primary-900/10" />
    </div>
  );
}

