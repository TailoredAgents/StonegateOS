"use client";

import React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { Search, SlidersHorizontal, Plus } from "lucide-react";
import { TeamWorkflowDrawer } from "./TeamWorkflowDrawer";
import { TEAM_INPUT_COMPACT, TEAM_SELECT, teamButtonClass } from "./team-ui";
import {
  inboxContactName,
  type InboxInput,
  type ThreadDetail,
} from "../inbox-loader";

export function InboxRetryClient({
  label = "Retry messages",
}: {
  label?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <button
      type="button"
      className={teamButtonClass("secondary", "sm")}
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? "Loading…" : label}
    </button>
  );
}

export function InboxListScroll({
  storageKey,
  children,
}: {
  storageKey: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    try {
      if (ref.current)
        ref.current.scrollTop = Number(sessionStorage.getItem(storageKey) ?? 0);
    } catch {
      /* optional storage */
    }
  }, [storageKey]);
  return (
    <div
      ref={ref}
      data-inbox-list-scroll
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
      onScroll={(event) => {
        try {
          sessionStorage.setItem(
            storageKey,
            String(event.currentTarget.scrollTop),
          );
        } catch {
          /* optional storage */
        }
      }}
    >
      {children}
    </div>
  );
}

export function InboxSearchFiltersClient({
  input,
  href,
  canSend,
}: {
  input: InboxInput;
  href: string;
  canSend: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [newMessage, setNewMessage] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [search, setSearch] = React.useState(input.q ?? "");
  const [queue, setQueue] = React.useState(input.queue ?? "all");
  const [source, setSource] = React.useState(input.view ?? "all");
  const [dates, setDates] = React.useState([
    input.firstMessageFrom ?? "",
    input.firstMessageTo ?? "",
    input.lastMessageFrom ?? "",
    input.lastMessageTo ?? "",
  ]);
  const dateKeys = [
    "firstMessageFrom",
    "firstMessageTo",
    "lastMessageFrom",
    "lastMessageTo",
  ] as const;
  const dateLabels = [
    "First message from",
    "First message to",
    "Last message from",
    "Last message to",
  ];
  React.useEffect(() => {
    setSearch(input.q ?? "");
    setQueue(input.queue ?? "all");
    setSource(input.view ?? "all");
    setDates([
      input.firstMessageFrom ?? "",
      input.firstMessageTo ?? "",
      input.lastMessageFrom ?? "",
      input.lastMessageTo ?? "",
    ]);
  }, [
    input.q,
    input.queue,
    input.view,
    input.firstMessageFrom,
    input.firstMessageTo,
    input.lastMessageFrom,
    input.lastMessageTo,
  ]);
  // Replace obsolete queue links without dropping customer context or history parameters.
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (
      url.searchParams.get("inbox_queue") === "waiting" ||
      url.searchParams.has("inbox_status")
    ) {
      url.searchParams.delete("inbox_status");
      url.searchParams.set("inbox_queue", input.queue ?? "all");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}`,
      );
    }
  }, [input.queue]);
  const count =
    Number(input.queue !== "all") +
    Number(input.view !== "all") +
    dateKeys.filter((key) => Boolean(input[key])).length;
  function navigate(clear = false) {
    const url = new URL(href, window.location.origin);
    url.searchParams.delete("inbox_offset");
    url.searchParams.delete("inbox_status");
    url.searchParams.set("inbox_queue", clear ? "all" : queue);
    url.searchParams.delete("inbox_view");
    if (!clear && source !== "all") url.searchParams.set("inbox_view", source);
    url.searchParams.delete("inbox_q");
    if (search.trim()) url.searchParams.set("inbox_q", search.trim());
    dateKeys.forEach((key, index) => {
      url.searchParams.delete(
        [
          "inbox_first_from",
          "inbox_first_to",
          "inbox_last_from",
          "inbox_last_to",
        ][index]!,
      );
      if (!clear && dates[index])
        url.searchParams.set(
          [
            "inbox_first_from",
            "inbox_first_to",
            "inbox_last_from",
            "inbox_last_to",
          ][index]!,
          dates[index],
        );
    });
    startTransition(() =>
      router.push(`${url.pathname}${url.search}` as Route, { scroll: false }),
    );
  }
  return (
    <div className="max-h-[60dvh] shrink-0 space-y-2 overflow-y-auto overscroll-contain border-b border-[color:var(--team-border)] p-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        <div className="flex gap-1">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Search conversations</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customers or messages"
              className={TEAM_INPUT_COMPACT + " w-full"}
            />
          </label>
          <button
            type="submit"
            aria-label="Search"
            title="Search"
            disabled={pending}
            className={teamButtonClass("secondary", "sm")}
          >
            <Search size={16} />
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="inbox-filters"
            onClick={() => setOpen(!open)}
            className={teamButtonClass("secondary", "sm")}
          >
            <SlidersHorizontal size={14} />
            {count ? `Filters (${count})` : "Filters"}
          </button>
          {canSend ? (
            <button
              type="button"
              onClick={() => setNewMessage(true)}
              className={teamButtonClass("secondary", "sm")}
            >
              <Plus size={14} />
              New message
            </button>
          ) : null}
          {count > 0 ? (
            <button
              type="button"
              onClick={() => navigate(true)}
              className="min-h-9 text-xs font-semibold underline"
            >
              Clear filters
            </button>
          ) : null}
        </div>
        <div id="inbox-filters" hidden={!open} className="mt-3 space-y-3">
          <label className="block text-xs">
            Show
            <select
              aria-label="Conversation filter"
              value={queue}
              onChange={(e) => setQueue(e.target.value)}
              className={TEAM_SELECT + " mt-1 w-full"}
            >
              <option value="all">All conversations</option>
              <option value="needs_reply">Needs a reply</option>
              <option value="failed">Delivery problems</option>
            </select>
          </label>
          <label className="block text-xs">
            Source
            <select
              aria-label="Source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className={TEAM_SELECT + " mt-1 w-full"}
            >
              <option value="all">All sources</option>
              <option value="google">Google</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            {dateKeys.map((key, i) => (
              <label key={key} className="min-w-0 text-xs">
                {dateLabels[i]}
                <input
                  type="date"
                  aria-label={dateLabels[i]}
                  value={dates[i]}
                  onChange={(e) =>
                    setDates((old) =>
                      old.map((v, j) => (i === j ? e.target.value : v)),
                    )
                  }
                  className={TEAM_INPUT_COMPACT + " mt-1 w-full min-w-0"}
                />
              </label>
            ))}
          </div>
          <button
            type="submit"
            disabled={pending}
            className={teamButtonClass("primary", "sm")}
          >
            {pending ? "Applying…" : "Apply filters"}
          </button>
        </div>
      </form>
      {newMessage ? (
        <InboxNewMessageClient
          href={href}
          onClose={() => setNewMessage(false)}
        />
      ) : null}
    </div>
  );
}

function InboxNewMessageClient({
  href,
  onClose,
}: {
  href: string;
  onClose: () => void;
}) {
  const [q, setQ] = React.useState("");
  const [contacts, setContacts] = React.useState<
    Array<NonNullable<ThreadDetail["contact"]>>
  >([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function search(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/team/contacts?q=${encodeURIComponent(q)}&limit=12`,
        { cache: "no-store" },
      );
      const data = (await res.json()) as {
        contacts?: Array<Record<string, unknown>>;
      } | null;
      if (!res.ok || !Array.isArray(data?.contacts)) throw new Error();
      setContacts(
        data.contacts.map((c: Record<string, unknown>) => ({
          id: String(c["id"]),
          name:
            typeof c["name"] === "string"
              ? c["name"]
              : [c["firstName"], c["lastName"]].filter(Boolean).join(" "),
          phone:
            typeof c["phone"] === "string"
              ? c["phone"]
              : typeof c["phoneE164"] === "string"
                ? c["phoneE164"]
                : null,
          email: typeof c["email"] === "string" ? c["email"] : null,
        })),
      );
    } catch {
      setError("Customers could not be loaded. Please search again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <TeamWorkflowDrawer title="New message" onClose={onClose}>
      <form onSubmit={(event) => void search(event)} className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Find a customer</span>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className={TEAM_INPUT_COMPACT + " w-full"}
            placeholder="Customer name, phone or email"
          />
        </label>
        <button disabled={busy} className={teamButtonClass("primary", "sm")}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}
      <ul className="mt-4 divide-y divide-[color:var(--team-border)]">
        {contacts.map((contact) => (
          <li key={contact.id} className="py-3">
            <div className="font-semibold">{inboxContactName(contact)}</div>
            <div className="mt-2 flex gap-2">
              {(["sms", "email"] as const)
                .filter((channel) =>
                  channel === "sms" ? contact.phone : contact.email,
                )
                .map((channel) => {
                  const url = new URL(href, "https://inbox.invalid");
                  url.searchParams.delete("threadId");
                  url.searchParams.delete("inbox_message_cursor");
                  url.searchParams.delete("inbox_message_limit");
                  url.searchParams.set("contactId", contact.id);
                  url.searchParams.set("channel", channel);
                  return (
                    <Link
                      key={channel}
                      href={`${url.pathname}${url.search}` as Route}
                      scroll={false}
                      onClick={onClose}
                      className={teamButtonClass("secondary", "sm")}
                    >
                      {channel === "sms" ? "Text message" : "Email"}
                    </Link>
                  );
                })}
              {!contact.phone && !contact.email ? (
                <span className="text-sm">
                  Add a phone number or email in Contacts to message this
                  customer.
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </TeamWorkflowDrawer>
  );
}
