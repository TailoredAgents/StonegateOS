'use client';

import * as React from "react";
import { withOpenAiAdsUtm } from "./openai-ads";

const COOKIE_NAME = "myst_utm";
const UTM_KEYS: (keyof UtmState)[] = [
  "source",
  "medium",
  "campaign",
  "term",
  "content",
  "gclid",
  "fbclid"
];

type UtmState = {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  gclid?: string;
  fbclid?: string;
};

function parseCookie(): UtmState {
  if (typeof document === "undefined") {
    return {};
  }

  const cookies = document.cookie.split(";").map((cookie) => cookie.trim());
  const match = cookies.find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
  if (!match) {
    return {};
  }

  try {
    const value = decodeURIComponent(match.split("=")[1] ?? "");
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }

    const record = parsed as Record<string, unknown>;
    return UTM_KEYS.reduce<UtmState>((acc, key) => {
      const entry = record[key];
      if (typeof entry === "string") {
        acc[key] = entry;
      }
      return acc;
    }, {});
  } catch {
    return {};
  }
}

export function useUTM(): UtmState {
  const [utm, setUtm] = React.useState<UtmState>({});

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial = params.has("oppref") ? {} : parseCookie();
    const merged: UtmState = { ...initial };

    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const) {
      const value = params.get(key);
      if (value) {
        const normalizedKey = key.replace("utm_", "") as keyof UtmState;
        merged[normalizedKey] = value;
      }
    }

    const gclid = params.get("gclid");
    if (gclid) merged.gclid = gclid;

    const fbclid = params.get("fbclid");
    if (fbclid) merged.fbclid = fbclid;

    setUtm(withOpenAiAdsUtm(merged));
  }, []);

  return utm;
}
