"use client";

import * as React from "react";
import { LoaderCircle, MapPin } from "lucide-react";
import {
  partnerPortalFetch,
  portalSupportReferenceFromResponse,
  withPortalSupportReference,
} from "../lib/portal-v2";
import { partnerFieldClass } from "./PartnerPortalUi";

export type SuggestedPartnerAddress = {
  line1: string;
  city: string;
  state: string;
  postalCode: string;
};

type AddressSuggestion = {
  id: string;
  label: string;
  address: SuggestedPartnerAddress;
};

type SearchState = {
  query: string;
  phase: "loading" | "ready" | "error";
  suggestions: AddressSuggestion[];
  message?: string;
  retryable?: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
  );
}

function parseSuggestions(value: unknown): AddressSuggestion[] | null {
  if (
    !record(value) ||
    value["ok"] !== true ||
    !Array.isArray(value["suggestions"]) ||
    value["suggestions"].length > 5
  )
    return null;
  const suggestions: AddressSuggestion[] = [];
  for (const item of value["suggestions"]) {
    if (
      !record(item) ||
      !boundedText(item["id"], 256) ||
      !boundedText(item["label"], 500)
    )
      return null;
    const address = item["address"];
    if (
      !record(address) ||
      !boundedText(address["line1"], 200) ||
      !boundedText(address["city"], 100) ||
      typeof address["state"] !== "string" ||
      !/^[A-Z]{2}$/u.test(address["state"]) ||
      typeof address["postalCode"] !== "string" ||
      !/^\d{5}(?:-\d{4})?$/u.test(address["postalCode"]) ||
      suggestions.some((suggestion) => suggestion.id === item["id"])
    )
      return null;
    suggestions.push({
      id: item["id"],
      label: item["label"],
      address: {
        line1: address["line1"],
        city: address["city"],
        state: address["state"],
        postalCode: address["postalCode"],
      },
    });
  }
  return suggestions;
}

const UNAVAILABLE =
  "Address suggestions are unavailable. You can enter the address manually.";

export function PartnerAddressAutocomplete({
  id,
  value,
  onChange,
  onSelect,
  disabled = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onSelect: (address: SuggestedPartnerAddress) => void;
  disabled?: boolean;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const generation = React.useRef(0);
  const selectedValue = React.useRef<string | null>(null);
  const [focused, setFocused] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [search, setSearch] = React.useState<SearchState | null>(null);
  const [retryCount, setRetryCount] = React.useState(0);
  const query = value.trim();
  const current = search?.query === query ? search : null;
  const expanded =
    focused &&
    !disabled &&
    !dismissed &&
    current?.phase === "ready" &&
    current.suggestions.length > 0;
  const listId = `${id}-suggestions`;
  const helpId = `${id}-help`;

  React.useEffect(() => {
    if (expanded && activeIndex >= 0) {
      document
        .getElementById(`${listId}-${activeIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [expanded, activeIndex, listId]);

  React.useEffect(() => {
    if (
      !focused ||
      disabled ||
      dismissed ||
      query.length < 3 ||
      selectedValue.current === value
    )
      return;
    const controller = new AbortController();
    const attempt = ++generation.current;
    let cancelled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      setSearch({ query, phase: "loading", suggestions: [] });
      deadline = setTimeout(() => controller.abort(), 8_000);
      void (async () => {
        const result = await partnerPortalFetch<unknown>(
          "address-suggestions",
          {
            method: "POST",
            body: JSON.stringify({ query }),
            signal: controller.signal,
          },
        ).catch(() => null);
        if (deadline) clearTimeout(deadline);
        if (cancelled || generation.current !== attempt) return;
        const suggestions = result?.ok ? parseSuggestions(result.data) : null;
        if (suggestions === null) {
          const message =
            result?.response.status === 401
              ? "Your sign-in expired. Sign in again to use address suggestions."
              : UNAVAILABLE;
          setSearch({
            query,
            phase: "error",
            suggestions: [],
            retryable: result?.response.status !== 401,
            message: withPortalSupportReference(
              message,
              portalSupportReferenceFromResponse(result?.response),
            ),
          });
        } else {
          setSearch({ query, phase: "ready", suggestions });
        }
        setActiveIndex(-1);
      })();
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
      controller.abort();
    };
  }, [query, value, focused, disabled, dismissed, retryCount]);

  const retry = (): void => {
    if (disabled || current?.phase !== "error" || !current.retryable) return;
    generation.current++;
    setSearch({ query, phase: "loading", suggestions: [] });
    setActiveIndex(-1);
    setDismissed(false);
    setFocused(true);
    setRetryCount((count) => count + 1);
    input.current?.focus();
  };

  const choose = (suggestion: AddressSuggestion): void => {
    generation.current++;
    selectedValue.current = suggestion.address.line1;
    setSearch(null);
    setDismissed(true);
    setActiveIndex(-1);
    onSelect(suggestion.address);
    input.current?.focus();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      if (expanded || current?.phase === "loading") {
        event.preventDefault();
        event.stopPropagation();
      }
      generation.current++;
      setDismissed(true);
      setActiveIndex(-1);
    } else if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      current?.phase === "ready" &&
      current.suggestions.length > 0
    ) {
      event.preventDefault();
      setDismissed(false);
      const length = current.suggestions.length;
      setActiveIndex((index) =>
        event.key === "ArrowDown"
          ? (index + 1) % length
          : (index <= 0 ? length : index) - 1,
      );
    } else if (event.key === "Enter") {
      // A search or selection must never submit the location form, including
      // while suggestions are still loading. The form has its own Save button.
      event.preventDefault();
      if (expanded && activeIndex >= 0 && current.suggestions[activeIndex])
        choose(current.suggestions[activeIndex]);
    }
  };

  let help =
    "Start typing for address suggestions, or enter the address manually.";
  if (focused && !dismissed && current?.phase === "loading")
    help = "Searching for addresses…";
  else if (focused && !dismissed && current?.phase === "error")
    help = current.message ?? UNAVAILABLE;
  else if (focused && !dismissed && current?.phase === "ready")
    help = current.suggestions.length
      ? `${current.suggestions.length} matching addresses. Use the arrow keys and Enter to choose.`
      : "No matching addresses found. You can enter the address manually.";

  return (
    <div
      className="min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          generation.current++;
          setFocused(false);
          setActiveIndex(-1);
        }
      }}
    >
      <label htmlFor={id} className="text-sm font-semibold text-slate-700">
        Street address
      </label>
      <div className="relative">
        <input
          ref={input}
          id={id}
          required
          maxLength={200}
          disabled={disabled}
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={
            expanded && activeIndex >= 0
              ? `${listId}-${activeIndex}`
              : undefined
          }
          aria-describedby={helpId}
          value={value}
          className={partnerFieldClass}
          onFocus={() => {
            setFocused(true);
            if (selectedValue.current !== value) setDismissed(false);
          }}
          onKeyDown={handleKeyDown}
          onChange={(event) => {
            generation.current++;
            selectedValue.current = null;
            setDismissed(false);
            setActiveIndex(-1);
            onChange(event.target.value);
          }}
        />
        {expanded ? (
          <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
            <div
              id={listId}
              role="listbox"
              aria-label="Matching street addresses"
              className="max-h-64 overflow-y-auto overscroll-contain"
            >
              {current.suggestions.map((suggestion, index) => (
                <button
                  key={suggestion.id}
                  id={`${listId}-${index}`}
                  type="button"
                  role="option"
                  aria-selected={activeIndex === index}
                  tabIndex={-1}
                  className={`flex min-h-12 w-full items-start gap-2 px-3 py-3 text-left text-sm text-slate-800 ${activeIndex === index ? "bg-primary-50" : "bg-white hover:bg-slate-50"}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(suggestion)}
                >
                  <MapPin
                    className="mt-0.5 h-4 w-4 shrink-0 text-slate-400"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 break-words">
                    {suggestion.label}
                  </span>
                </button>
              ))}
            </div>
            <div className="border-t border-slate-100 px-3 py-1.5 text-right text-xs text-slate-500">
              <a
                href="https://www.mapbox.com/about/maps/"
                target="_blank"
                rel="noreferrer"
                tabIndex={-1}
                className="underline"
              >
                © Mapbox
              </a>
            </div>
          </div>
        ) : null}
      </div>
      <p
        id={helpId}
        role="status"
        className="mt-1.5 flex items-start gap-1.5 text-xs leading-5 text-slate-500"
      >
        {focused && !dismissed && current?.phase === "loading" ? (
          <LoaderCircle
            className="mt-0.5 h-4 w-4 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : null}
        <span>{help}</span>
      </p>
      {focused &&
      !disabled &&
      !dismissed &&
      current?.phase === "error" &&
      current.retryable ? (
        <button
          type="button"
          className="mt-1 inline-flex min-h-11 items-center rounded-lg px-2 text-sm font-semibold text-primary-700 underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
          // WebKit does not focus buttons on pointer clicks. Keep the input
          // focused so its blur handler cannot remove Retry before the click.
          onMouseDown={(event) => event.preventDefault()}
          onClick={retry}
        >
          Try suggestions again
        </button>
      ) : null}
    </div>
  );
}
