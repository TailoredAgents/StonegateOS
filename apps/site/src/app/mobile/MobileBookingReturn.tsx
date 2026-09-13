"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  mobileBookingHref,
  readMobileBookingReturn,
} from "./lib/booking-presentation";
import {
  readMobileJobDraft,
  writeMobileJobDraft,
} from "./lib/mobile-job-drafts";

export function MobileBookingReturnTracker({
  employeeId,
  appointmentId,
  screen,
  date,
}: {
  employeeId: string;
  appointmentId: string;
  screen: "myday" | "calendar";
  date: string;
}) {
  React.useEffect(() => {
    writeMobileJobDraft(
      {
        employeeId,
        appointmentId,
        appointmentVersion: null,
        kind: "navigation",
      },
      { href: mobileBookingHref(screen, date, appointmentId) },
    );
  }, [employeeId, appointmentId, screen, date]);
  return null;
}

export function MobileBookingReturnRestore({
  employeeId,
  appointmentId,
  paymentReturn,
}: {
  employeeId: string;
  appointmentId: string;
  paymentReturn: boolean;
}) {
  const router = useRouter();
  React.useEffect(() => {
    if (!paymentReturn || !appointmentId) return;
    const saved = readMobileJobDraft<{ href?: unknown }>({
      employeeId,
      appointmentId,
      appointmentVersion: null,
      kind: "navigation",
    });
    const returnTo = readMobileBookingReturn(saved?.values?.href);
    if (!returnTo) return;
    const destination = new URL(returnTo, window.location.origin);
    if (destination.searchParams.get("jobId") !== appointmentId) return;
    const current = new URL(window.location.href);
    for (const key of ["payment", "paymentAttempt", "paymentError"]) {
      const value = current.searchParams.get(key);
      if (value) destination.searchParams.set(key, value);
    }
    if (current.search !== destination.search)
      router.replace(`${destination.pathname}${destination.search}` as Route);
  }, [employeeId, appointmentId, paymentReturn, router]);
  return null;
}
