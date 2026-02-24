"use client";

import * as React from "react";
import Image from "next/image";
import { cn } from "../utils/cn";

export interface BeforeAfterSliderProps
  extends React.HTMLAttributes<HTMLDivElement> {
  beforeImage: string;
  afterImage: string;
  alt: string;
  initialPosition?: number;
  aspectRatio?: "16/9" | "4/3";
  imageSizes?: string;
}

export function BeforeAfterSlider({
  beforeImage,
  afterImage,
  alt,
  initialPosition = 50,
  aspectRatio = "16/9",
  imageSizes = "(min-width: 1280px) 31vw, (min-width: 768px) 46vw, 100vw",
  className,
  ...props
}: BeforeAfterSliderProps) {
  const [position, setPosition] = React.useState(initialPosition);
  const sliderId = React.useId();

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number.parseInt(event.target.value, 10);
    if (Number.isNaN(next)) {
      return;
    }
    setPosition(Math.min(100, Math.max(0, next)));
  };

  return (
    <div className={cn("w-full", className)} {...props}>
      <div
        className={cn(
          "relative overflow-hidden rounded-lg shadow-soft sm:rounded-xl",
          aspectRatio === "4/3" ? "aspect-[4/3]" : "aspect-[16/9]",
        )}
      >
        <Image
          src={afterImage}
          alt={`${alt} after cleaning`}
          fill
          className="object-cover"
          sizes={imageSizes}
          priority={false}
        />
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          aria-hidden="true"
        >
          <Image
            src={beforeImage}
            alt={`${alt} before cleaning`}
            fill
            className="object-cover"
            sizes={imageSizes}
            priority={false}
          />
        </div>
        <div
          className="pointer-events-none absolute inset-y-0"
          style={{ left: `calc(${position}% - 1px)` }}
        >
          <div className="h-full w-0.5 bg-white/80 shadow-[0_0_12px_rgba(15,23,42,0.35)]" />
        </div>
        <div className="absolute inset-x-0 bottom-3 flex items-center justify-center sm:bottom-4">
          <label className="sr-only" htmlFor={sliderId}>
            Compare before and after image
          </label>
          <input
            id={sliderId}
            type="range"
            min="0"
            max="100"
            step="1"
            value={position}
            onChange={handleChange}
            className="w-11/12 accent-accent-500"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={position}
          />
        </div>
      </div>
      <div className="mt-2 flex justify-between text-xs uppercase tracking-[0.18em] text-neutral-500 sm:mt-3 sm:tracking-[0.25em]">
        <span>Before</span>
        <span>After</span>
      </div>
    </div>
  );
}
