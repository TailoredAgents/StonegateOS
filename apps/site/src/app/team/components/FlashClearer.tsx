"use client";

import { useEffect } from "react";

export function FlashClearer() {
  useEffect(() => {
    fetch("/api/team/flash/clear", { method: "POST" }).catch(() => {});
  }, []);

  return null;
}

