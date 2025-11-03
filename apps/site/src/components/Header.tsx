"use client";

import Image from "next/image";
import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Button, cn } from "@myst-os/ui";

const navItems = [
  { href: "/services", label: "Services" },
  { href: "/areas", label: "Service Areas" },
  { href: "/pricing", label: "Pricing" },
  { href: "/reviews", label: "Reviews" },
  { href: "/gallery", label: "Gallery" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" }
] satisfies Array<{ href: Route; label: string }>;

export function Header() {
  const pathname = usePathname();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [isMenuOpen]);

  useEffect(() => {
    setIsMenuOpen(false);
  }, [pathname]);

  const toggleMenu = () => setIsMenuOpen((prev) => !prev);
  const closeMenu = () => setIsMenuOpen(false);

  return (
    <header className="sticky top-0 z-50 border-b border-neutral-300/50 bg-white/95">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4 md:px-10">
        <Link href="/" className="flex items-center gap-2 text-primary-800">
          <Image src="/images/brand/Stonegatelogo.png" alt="Stonegate Junk Removal" width={80} height={41} priority />
          <span className="sr-only">Stonegate Junk Removal</span>
        </Link>
        <nav className="hidden items-center gap-6 md:flex">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm font-medium text-neutral-600 transition hover:text-primary-700"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="hidden md:flex">
          <Button asChild>
            <Link href="#schedule-estimate">Schedule Estimate</Link>
          </Button>
        </div>
        <button
          type="button"
          onClick={toggleMenu}
          className="inline-flex items-center gap-2 rounded-md border border-neutral-300/60 px-4 py-2 text-sm font-semibold text-neutral-700 shadow-soft transition hover:border-primary-300 hover:text-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 md:hidden"
          aria-controls="mobile-navigation"
          aria-expanded={isMenuOpen}
        >
          <span>{isMenuOpen ? "Close" : "Menu"}</span>
        </button>
      </div>
      <div
        className={cn(
          "md:hidden",
          isMenuOpen ? "pointer-events-auto" : "pointer-events-none"
        )}
      >
        <button
          type="button"
          onClick={closeMenu}
          aria-hidden="true"
          className={cn(
            "fixed inset-0 bg-neutral-900/40 transition-opacity",
            isMenuOpen ? "opacity-100" : "opacity-0"
          )}
          tabIndex={-1}
        />
        <div
          id="mobile-navigation"
          className={cn(
            "fixed inset-y-0 right-0 flex w-full max-w-xs flex-col gap-6 border-l border-neutral-200 bg-white px-6 pb-[calc(env(safe-area-inset-bottom,0px)+2rem)] pt-6 shadow-xl transition-transform",
            isMenuOpen ? "translate-x-0" : "translate-x-full"
          )}
        >
          <div className="flex items-center justify-between">
            <span className="text-lg font-semibold text-primary-900">Menu</span>
            <button
              type="button"
              onClick={closeMenu}
              className="rounded-md p-2 text-neutral-500 transition hover:bg-neutral-100 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
              aria-label="Close navigation"
            >
              ×
            </button>
          </div>
          <nav className="flex flex-1 flex-col gap-3 text-base">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-2 py-2 font-medium text-neutral-700 transition hover:bg-neutral-100 hover:text-primary-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex flex-col gap-3">
            <Button asChild size="lg" className="w-full">
              <Link href="#schedule-estimate">Schedule Estimate</Link>
            </Button>
            <Button
              asChild
              variant="ghost"
              size="lg"
              className="w-full border border-neutral-300/70 text-primary-800 hover:border-primary-300"
            >
              <a href="tel:16785417725">Call (678) 541-7725</a>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}


