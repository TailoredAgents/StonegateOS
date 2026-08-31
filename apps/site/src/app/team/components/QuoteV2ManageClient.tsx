"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isQuoteV2DetailPayload,
  normalizeQuoteV2ManagePage,
  quoteV2DeliveryIsRetryable,
  quoteV2ManageAmount,
  quoteV2ResendRecipientDefaults,
  quoteV2SendAttemptIsActive,
  type QuoteV2ManageBucket,
  type QuoteV2ManagePage,
  type QuoteV2ManageRow,
  type QuoteV2ManageSort,
  type QuoteV2ResendRecipientDefaults,
} from "../lib/quote-v2-management-model";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_FOCUS_RING,
  TEAM_INPUT,
  TEAM_SELECT,
  teamButtonClass,
  teamStatePanelClass,
} from "./team-ui";
import QuoteV2LifecyclePanel, {
  type QuoteV2LifecycleCommit,
} from "./QuoteV2LifecyclePanel";

type DetailTab = "overview" | "proposal" | "delivery" | "activity";
type ResendDraft = QuoteV2ResendRecipientDefaults & { coverMessage: string };
type SendFeedback = { tone: "success" | "danger" | "info"; message: string };

const EMPTY_RESEND_DRAFT: ResendDraft = {
  name: "",
  email: "",
  phoneE164: "",
  emailSelected: false,
  smsSelected: false,
  coverMessage: "",
};
const MAX_ACTIVE_SEND_POLLS = 20;

const BUCKETS: Array<{ key: QuoteV2ManageBucket; label: string }> = [
  { key: "needs_action", label: "Needs action" },
  { key: "drafts", label: "Drafts" },
  { key: "awaiting_client", label: "Awaiting client" },
  { key: "accepted_booked", label: "Accepted / booked" },
  { key: "closed", label: "Closed" },
];

const SORTS: Array<{ key: QuoteV2ManageSort; label: string }> = [
  { key: "next_action", label: "Next action" },
  { key: "updated_desc", label: "Recently updated" },
  { key: "expiry_asc", label: "Expiry soonest" },
  { key: "total_desc", label: "Highest total" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function formatDate(value: unknown): string {
  if (typeof value !== "string") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatCents(value: unknown): string {
  if (!Number.isSafeInteger(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value) / 100);
}

function humanize(value: unknown): string {
  return text(value)
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function requestId(scope: string): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `quote-v2:${scope}:${id}`;
}

function customerLabel(row: QuoteV2ManageRow): string {
  return row.client.company || row.client.name || "Client not set";
}

function projectLabel(row: QuoteV2ManageRow): string {
  return (
    row.project.name || row.project.property.addressLine1 || "Project not named"
  );
}

function statusTone(row: QuoteV2ManageRow): string {
  if (row.bucket === "accepted_booked") {
    return "border-[color:var(--team-success-border)] bg-[color:var(--team-success-surface)] text-[color:var(--team-success-text)]";
  }
  if (row.bucket === "needs_action") {
    return "border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] text-[color:var(--team-warning-text)]";
  }
  return "border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] text-[color:var(--team-text-muted)]";
}

export default function QuoteV2ManageClient({
  initialPage,
  canUpdate,
  canSend,
}: {
  initialPage: QuoteV2ManagePage;
  canUpdate: boolean;
  canSend: boolean;
}) {
  const [rows, setRows] = useState(initialPage.quotes);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [bucket, setBucket] = useState<QuoteV2ManageBucket | "all">("all");
  const [sort, setSort] = useState<QuoteV2ManageSort>("next_action");
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<QuoteV2ManageRow | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [revisionReason, setRevisionReason] = useState("");
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [revisionMessage, setRevisionMessage] = useState<string | null>(null);
  const [capabilityReason, setCapabilityReason] = useState("");
  const [capabilityBusy, setCapabilityBusy] = useState<string | null>(null);
  const [capabilityMessage, setCapabilityMessage] = useState<string | null>(
    null,
  );
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const [sendBusy, setSendBusy] = useState<string | null>(null);
  const [sendFeedback, setSendFeedback] = useState<SendFeedback | null>(null);
  const [resendOpen, setResendOpen] = useState(false);
  const [resendDraft, setResendDraft] =
    useState<ResendDraft>(EMPTY_RESEND_DRAFT);
  const [detailLastCheckedAt, setDetailLastCheckedAt] = useState<string | null>(
    null,
  );
  const [deliveryPollNotice, setDeliveryPollNotice] = useState<string | null>(
    null,
  );
  const [manualRefreshBusy, setManualRefreshBusy] = useState(false);
  const [pollGeneration, setPollGeneration] = useState(0);
  const listSequence = useRef(0);
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const activeSendPollCount = useRef(0);

  const loadPage = useCallback(
    async (input: {
      bucket: QuoteV2ManageBucket | "all";
      sort: QuoteV2ManageSort;
      search: string;
      cursor?: string | null;
      append?: boolean;
    }) => {
      const sequence = ++listSequence.current;
      setLoading(true);
      setListError(null);
      const query = new URLSearchParams({ limit: "40", sort: input.sort });
      if (input.bucket !== "all") query.set("bucket", input.bucket);
      if (input.search.trim()) query.set("search", input.search.trim());
      if (input.cursor) query.set("cursor", input.cursor);
      try {
        const response = await fetch(`/api/team/quotes/v2/quotes?${query}`, {
          cache: "no-store",
          headers: { "x-correlation-id": requestId("list") },
        });
        const payload = (await response.json().catch(() => null)) as unknown;
        const page = normalizeQuoteV2ManagePage(payload);
        if (!response.ok || !page) {
          throw new Error(
            isRecord(payload) && typeof payload["message"] === "string"
              ? payload["message"]
              : "The quote list could not be loaded.",
          );
        }
        if (sequence !== listSequence.current) return;
        setRows((current) =>
          input.append
            ? [
                ...current,
                ...page.quotes.filter(
                  (row) => !current.some((existing) => existing.id === row.id),
                ),
              ]
            : page.quotes,
        );
        setNextCursor(page.nextCursor);
      } catch (error) {
        if (sequence === listSequence.current) {
          setListError(
            error instanceof Error
              ? error.message
              : "The quote list could not be loaded.",
          );
        }
      } finally {
        if (sequence === listSequence.current) setLoading(false);
      }
    },
    [],
  );

  const loadDetail = useCallback(
    async (
      row: QuoteV2ManageRow,
      options: { background?: boolean } = {},
    ): Promise<boolean> => {
      const background = options.background === true;
      if (!background) {
        setSelectedRow(row);
        setDetail(null);
        setPreview(null);
        setDetailError(null);
        setDetailLoading(true);
        setDetailTab("overview");
        setRevisionMessage(null);
        setCapabilityReason("");
        setCapabilityMessage(null);
        setOneTimeLink(null);
        setSendFeedback(null);
        setResendOpen(false);
        setDeliveryPollNotice(null);
        activeSendPollCount.current = 0;
      }
      try {
        const response = await fetch(
          `/api/team/quotes/v2/quotes/${encodeURIComponent(row.id)}`,
          {
            cache: "no-store",
            headers: {
              "x-correlation-id": requestId(
                background ? "detail-poll" : "detail",
              ),
            },
          },
        );
        const payload = (await response.json().catch(() => null)) as unknown;
        if (!response.ok || !isQuoteV2DetailPayload(payload)) {
          throw new Error(
            isRecord(payload) && typeof payload["message"] === "string"
              ? payload["message"]
              : "The quote detail could not be loaded.",
          );
        }
        const nextRevision = Number(payload.quote["quoteRevision"]);
        const nextPublishedVersionId = nullableText(
          payload.quote["publishedVersionId"],
        );
        const nextCurrentVersionId = nullableText(
          payload.quote["currentVersionId"],
        );
        setDetail(payload.quote);
        setDetailLastCheckedAt(new Date().toISOString());
        setDeliveryPollNotice(null);
        setSelectedRow((current) => {
          const base = current?.id === row.id ? current : row;
          return {
            ...base,
            quoteRevision:
              Number.isSafeInteger(nextRevision) && nextRevision > 0
                ? nextRevision
                : base.quoteRevision,
            publishedVersionId:
              nextPublishedVersionId ?? base.publishedVersionId,
            currentVersionId: nextCurrentVersionId ?? base.currentVersionId,
          };
        });
        if (!background) {
          const defaults = quoteV2ResendRecipientDefaults(
            payload.quote,
            nextPublishedVersionId ?? row.publishedVersionId,
          );
          setResendDraft({ ...defaults, coverMessage: "" });
          globalThis.requestAnimationFrame?.(() =>
            detailHeadingRef.current?.focus(),
          );
        }
        return true;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "The quote detail could not be loaded.";
        if (background) {
          setDeliveryPollNotice(
            `${message} Automatic refresh will retry with backoff.`,
          );
        } else {
          setDetailError(message);
        }
        return false;
      } finally {
        if (!background) setDetailLoading(false);
      }
    },
    [],
  );

  const loadPreview = useCallback(async (versionId: string) => {
    setPreview(null);
    setDetailError(null);
    try {
      const response = await fetch(
        `/api/team/quotes/v2/quote-versions/${encodeURIComponent(versionId)}/preview`,
        {
          cache: "no-store",
          headers: { "x-correlation-id": requestId("preview") },
        },
      );
      const payload = (await response.json().catch(() => null)) as unknown;
      if (
        !response.ok ||
        !isRecord(payload) ||
        payload["ok"] !== true ||
        !isRecord(payload["preview"])
      ) {
        throw new Error(
          "The authenticated proposal preview could not be loaded.",
        );
      }
      setPreview(payload["preview"]);
      setDetailTab("proposal");
    } catch (error) {
      setDetailError(
        error instanceof Error ? error.message : "Preview unavailable.",
      );
    }
  }, []);

  const activeSendAttemptCount = useMemo(
    () =>
      records(detail?.["sendAttempts"]).filter(quoteV2SendAttemptIsActive)
        .length,
    [detail],
  );

  useEffect(() => {
    if (!selectedRow || !detail || activeSendAttemptCount === 0) {
      activeSendPollCount.current = 0;
      return;
    }
    if (activeSendPollCount.current >= MAX_ACTIVE_SEND_POLLS) {
      setDeliveryPollNotice(
        "Automatic delivery refresh paused after the bounded polling window. Refresh manually to continue checking.",
      );
      return;
    }
    const delay = Math.min(
      4_000 * 2 ** Math.min(activeSendPollCount.current, 2),
      16_000,
    );
    const timer = globalThis.setTimeout(() => {
      void loadDetail(selectedRow, { background: true }).finally(() => {
        activeSendPollCount.current += 1;
        setPollGeneration((current) => current + 1);
      });
    }, delay);
    return () => globalThis.clearTimeout(timer);
  }, [activeSendAttemptCount, detail, loadDetail, pollGeneration, selectedRow]);

  const counts = useMemo(
    () =>
      rows.reduce<Record<QuoteV2ManageBucket, number>>(
        (result, row) => ({ ...result, [row.bucket]: result[row.bucket] + 1 }),
        {
          needs_action: 0,
          drafts: 0,
          awaiting_client: 0,
          accepted_booked: 0,
          closed: 0,
        },
      ),
    [rows],
  );

  const refreshAfterLifecycle = useCallback(
    async (commit: QuoteV2LifecycleCommit): Promise<void> => {
      if (!selectedRow) return;
      const nextBucket: QuoteV2ManageBucket =
        commit.aggregateState === "accepted"
          ? "accepted_booked"
          : ["declined", "voided", "archived"].includes(commit.aggregateState)
            ? "closed"
            : commit.aggregateState === "open"
              ? "awaiting_client"
              : selectedRow.bucket;
      const refreshedRow: QuoteV2ManageRow = {
        ...selectedRow,
        aggregateState: commit.aggregateState,
        quoteRevision: commit.quoteRevision,
        bucket: nextBucket,
      };
      setSelectedRow(refreshedRow);
      setDetail((current) =>
        current
          ? {
              ...current,
              aggregateState: commit.aggregateState,
              quoteRevision: commit.quoteRevision,
            }
          : current,
      );
      setPreview(null);
      await loadDetail(refreshedRow, { background: true });
      await loadPage({ bucket, sort, search: appliedSearch });
    },
    [appliedSearch, bucket, loadDetail, loadPage, selectedRow, sort],
  );

  async function createRevision() {
    if (!selectedRow || !detail || !revisionReason.trim()) {
      setRevisionMessage("Explain why this revision is needed.");
      return;
    }
    const sourceVersionId =
      nullableText(detail["publishedVersionId"]) ??
      nullableText(detail["currentVersionId"]);
    if (!sourceVersionId) {
      setRevisionMessage("A published source version is required.");
      return;
    }
    setRevisionBusy(true);
    setRevisionMessage(null);
    try {
      const response = await fetch(
        `/api/team/quotes/v2/quotes/${encodeURIComponent(selectedRow.id)}/revisions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": requestId("revision"),
            "If-Match": String(selectedRow.quoteRevision),
            "x-correlation-id": requestId("revision-correlation"),
          },
          body: JSON.stringify({
            confirmation: "create_quote_revision",
            sourceVersionId,
            quoteRevision: selectedRow.quoteRevision,
            reason: revisionReason.trim(),
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new Error(
          isRecord(payload) && typeof payload["message"] === "string"
            ? payload["message"]
            : "The revision could not be created.",
        );
      }
      setRevisionReason("");
      setRevisionMessage(
        "Revision draft created. Refreshing the quote record…",
      );
      await loadPage({ bucket, sort, search: appliedSearch });
      const refreshed =
        rows.find((row) => row.id === selectedRow.id) ?? selectedRow;
      await loadDetail(refreshed);
    } catch (error) {
      setRevisionMessage(
        error instanceof Error
          ? error.message
          : "The revision could not be created.",
      );
    } finally {
      setRevisionBusy(false);
    }
  }

  async function queueSendAttempt(input: {
    versionId: string;
    body: Record<string, unknown>;
    busyKey: string;
    successMessage: string;
  }): Promise<boolean> {
    if (!selectedRow || !detail || !canSend) {
      setSendFeedback({
        tone: "danger",
        message:
          "Quote-send permission and an enabled sender are required for this action.",
      });
      return false;
    }
    if (activeSendAttemptCount > 0) {
      setSendFeedback({
        tone: "info",
        message:
          "Wait for the active delivery attempt to finish before sending again.",
      });
      return false;
    }
    const quoteRevision = Number(detail["quoteRevision"]);
    if (!Number.isSafeInteger(quoteRevision) || quoteRevision <= 0) {
      setSendFeedback({
        tone: "danger",
        message: "Refresh the quote before requesting another delivery.",
      });
      return false;
    }
    setSendBusy(input.busyKey);
    setSendFeedback(null);
    try {
      const response = await fetch(
        `/api/team/quotes/v2/quote-versions/${encodeURIComponent(input.versionId)}/send-attempts`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": requestId("send-attempt"),
            "If-Match": String(quoteRevision),
            "x-correlation-id": requestId("send-attempt-correlation"),
          },
          body: JSON.stringify({ ...input.body, quoteRevision }),
        },
      );
      const payload = (await response.json().catch(() => null)) as unknown;
      const data =
        isRecord(payload) && isRecord(payload["data"]) ? payload["data"] : null;
      if (!response.ok || !data) {
        throw new Error(
          isRecord(payload) && typeof payload["message"] === "string"
            ? payload["message"]
            : "The delivery attempt could not be requested.",
        );
      }
      const nextRevision = Number(data["quoteRevision"]);
      if (
        !Number.isSafeInteger(nextRevision) ||
        nextRevision <= quoteRevision ||
        typeof data["sendAttemptId"] !== "string" ||
        data["versionId"] !== input.versionId
      ) {
        throw new Error(
          "The server returned an unverified delivery-attempt receipt.",
        );
      }
      const refreshedRow: QuoteV2ManageRow = {
        ...selectedRow,
        quoteRevision: nextRevision,
      };
      setSelectedRow(refreshedRow);
      setDetail((current) =>
        current ? { ...current, quoteRevision: nextRevision } : current,
      );
      setSendFeedback({ tone: "success", message: input.successMessage });
      setDetailTab("delivery");
      activeSendPollCount.current = 0;
      setDeliveryPollNotice(null);
      setPollGeneration((current) => current + 1);
      await loadDetail(refreshedRow, { background: true });
      void loadPage({ bucket, sort, search: appliedSearch });
      return true;
    } catch (error) {
      setSendFeedback({
        tone: "danger",
        message:
          error instanceof Error
            ? error.message
            : "The delivery attempt could not be requested.",
      });
      return false;
    } finally {
      setSendBusy(null);
    }
  }

  async function retryFailedDelivery(
    attempt: Record<string, unknown>,
    delivery: Record<string, unknown>,
  ): Promise<void> {
    const versionId = nullableText(attempt["quoteVersionId"]);
    const deliveryId = nullableText(delivery["id"]);
    const channel = nullableText(delivery["channel"]);
    const publishedVersionId = nullableText(detail?.["publishedVersionId"]);
    if (
      !versionId ||
      !deliveryId ||
      !channel ||
      !quoteV2DeliveryIsRetryable({
        attempt,
        delivery,
        publishedVersionId,
      })
    ) {
      setSendFeedback({
        tone: "danger",
        message:
          "Only a failed channel on the current issued version can be retried.",
      });
      return;
    }
    await queueSendAttempt({
      versionId,
      busyKey: `retry:${deliveryId}`,
      body: {
        confirmation: "send_quote_version",
        retryDeliveryIds: [deliveryId],
      },
      successMessage: `${humanize(channel)} retry requested for the same immutable version, recipient, capability, message, PDF, and expiry. Successful channels were not queued again.`,
    });
  }

  async function resendPublishedVersion(): Promise<void> {
    const versionId = nullableText(detail?.["publishedVersionId"]);
    if (!versionId) {
      setSendFeedback({
        tone: "danger",
        message: "A current issued version is required before resending.",
      });
      return;
    }
    const name = resendDraft.name.trim();
    const email = resendDraft.email.trim();
    const phoneE164 = resendDraft.phoneE164.trim();
    if (!name) {
      setSendFeedback({
        tone: "danger",
        message: "Enter the designated signer’s name.",
      });
      return;
    }
    if (!resendDraft.emailSelected && !resendDraft.smsSelected) {
      setSendFeedback({
        tone: "danger",
        message: "Choose email, SMS, or both for this new send attempt.",
      });
      return;
    }
    if (
      resendDraft.emailSelected &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
    ) {
      setSendFeedback({
        tone: "danger",
        message: "Enter a valid signer email address.",
      });
      return;
    }
    if (resendDraft.smsSelected && !/^\+[1-9]\d{7,14}$/u.test(phoneE164)) {
      setSendFeedback({
        tone: "danger",
        message: "Enter the signer mobile number in E.164 format.",
      });
      return;
    }
    const channels = [
      ...(resendDraft.emailSelected ? (["email"] as const) : []),
      ...(resendDraft.smsSelected ? (["sms"] as const) : []),
    ];
    const sent = await queueSendAttempt({
      versionId,
      busyKey: "resend",
      body: {
        confirmation: "send_quote_version",
        recipients: [
          {
            role: "signer",
            name,
            email: resendDraft.emailSelected ? email : null,
            phoneE164: resendDraft.smsSelected ? phoneE164 : null,
            channels,
          },
        ],
        coverMessage: resendDraft.coverMessage.trim() || null,
        retryDeliveryIds: [],
      },
      successMessage:
        "A new send attempt was requested against the existing issued version. Its price, scope, terms, PDF, issued date, and expiry were not changed.",
    });
    if (sent) {
      setResendOpen(false);
      setResendDraft((current) => ({ ...current, coverMessage: "" }));
    }
  }

  async function manageCapability(
    capability: Record<string, unknown>,
    action: "replace" | "revoke",
  ) {
    if (!selectedRow || !capabilityReason.trim()) {
      setCapabilityMessage(
        `Enter a reason before ${action === "replace" ? "replacing" : "revoking"} this link.`,
      );
      return;
    }
    const capabilityId = nullableText(capability["id"]);
    if (!capabilityId) {
      setCapabilityMessage("The selected access record is invalid.");
      return;
    }
    setCapabilityBusy(`${capabilityId}:${action}`);
    setCapabilityMessage(null);
    if (action === "replace") setOneTimeLink(null);
    try {
      const response = await fetch(
        `/api/team/quotes/v2/quotes/${encodeURIComponent(selectedRow.id)}/capabilities/${encodeURIComponent(capabilityId)}/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": requestId(`capability-${action}`),
            "If-Match": String(selectedRow.quoteRevision),
            "x-correlation-id": requestId(`capability-${action}-correlation`),
          },
          body: JSON.stringify({
            confirmation:
              action === "replace"
                ? "replace_quote_signer_link"
                : "revoke_quote_customer_link",
            quoteRevision: selectedRow.quoteRevision,
            reason: capabilityReason.trim(),
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as unknown;
      const data =
        isRecord(payload) && isRecord(payload["data"]) ? payload["data"] : null;
      if (!response.ok || !data) {
        throw new Error(
          isRecord(payload) && typeof payload["message"] === "string"
            ? payload["message"]
            : `The customer link could not be ${action === "replace" ? "replaced" : "revoked"}.`,
        );
      }
      const nextRevision = Number(data["quoteRevision"]);
      if (
        !Number.isSafeInteger(nextRevision) ||
        nextRevision <= selectedRow.quoteRevision
      ) {
        throw new Error(
          "The server returned an unverified link-management receipt.",
        );
      }
      const link = isRecord(data["oneTimeLink"])
        ? nullableText(data["oneTimeLink"]["href"])
        : null;
      if (action === "replace" && !link) {
        throw new Error(
          data["oneTimeLinkAvailable"] === false
            ? "The link was already replaced, but its one-time URL cannot be replayed. Replace it again if needed."
            : "The replacement succeeded without a verified one-time URL.",
        );
      }
      setSelectedRow((current) =>
        current ? { ...current, quoteRevision: nextRevision } : current,
      );
      setDetail((current) => {
        if (!current) return current;
        return {
          ...current,
          quoteRevision: nextRevision,
          capabilities: records(current["capabilities"]).map((item) =>
            item["id"] === capabilityId
              ? {
                  ...item,
                  status: action === "replace" ? "superseded" : "revoked",
                  allowedActions:
                    action === "replace" ? ["view", "pdf"] : ["view"],
                }
              : item,
          ),
        };
      });
      setCapabilityReason("");
      setOneTimeLink(link);
      setCapabilityMessage(
        action === "replace"
          ? "New signer link created. Copy it now; it will not be shown again."
          : "Customer access was revoked immediately.",
      );
      void loadPage({ bucket, sort, search: appliedSearch });
    } catch (error) {
      setCapabilityMessage(
        error instanceof Error
          ? error.message
          : "The customer link could not be updated.",
      );
    } finally {
      setCapabilityBusy(null);
    }
  }

  const versions = records(detail?.["versions"]);
  const sendAttempts = records(detail?.["sendAttempts"]);
  const responses = records(detail?.["responses"]);
  const changeRequests = records(detail?.["changeRequests"]);
  const activity = records(detail?.["activity"]);
  const capabilities = records(detail?.["capabilities"]);
  const publishedVersionId = nullableText(detail?.["publishedVersionId"]);
  const publishedVersion = versions.find(
    (version) => version["id"] === publishedVersionId,
  );
  const publishedVersionNumber = text(publishedVersion?.["versionNumber"], "—");
  const hasOpenChangeRequest = changeRequests.some((change) =>
    ["open", "acknowledged"].includes(text(change["status"], "")),
  );
  const publishedExpiry = nullableText(publishedVersion?.["expiresAt"]);
  const publishedExpiryTime = publishedExpiry
    ? new Date(publishedExpiry).getTime()
    : Number.NaN;
  const sendVersionActionable = Boolean(
    publishedVersionId &&
      detail?.["aggregateState"] === "open" &&
      publishedVersion?.["state"] === "issued" &&
      Number.isFinite(publishedExpiryTime) &&
      publishedExpiryTime > Date.now() &&
      !hasOpenChangeRequest,
  );
  const sendBlockedReason = !publishedVersionId
    ? "No issued proposal is available to send."
    : detail?.["aggregateState"] !== "open" ||
        publishedVersion?.["state"] !== "issued"
      ? "Only the current open, issued proposal can be sent."
      : !Number.isFinite(publishedExpiryTime) ||
          publishedExpiryTime <= Date.now()
        ? "This proposal has expired. Create and issue a revision before sending it again."
        : hasOpenChangeRequest
          ? "Resolve the open change request before sending this version again."
          : null;

  return (
    <div className="space-y-5">
      <section
        className={TEAM_CARD_PADDED}
        aria-labelledby="quote-v2-manage-title"
      >
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--team-link)]">
              Versioned proposals
            </p>
            <h3
              id="quote-v2-manage-title"
              className="mt-1 text-xl font-semibold"
            >
              Quote management
            </h3>
            <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
              Work from the next required action; open history only when it
              helps.
            </p>
          </div>
          <form
            className="flex w-full flex-col gap-2 sm:flex-row xl:max-w-2xl"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setAppliedSearch(searchInput.trim());
              void loadPage({ bucket, sort, search: searchInput.trim() });
            }}
          >
            <label className="sr-only" htmlFor="quote-v2-search">
              Search quote number, client, company, project, property, or PO
            </label>
            <input
              id="quote-v2-search"
              className={`${TEAM_INPUT} min-w-0 flex-1`}
              value={searchInput}
              maxLength={200}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Quote, client, company, project, property, PO…"
            />
            <label className="sr-only" htmlFor="quote-v2-sort">
              Sort quotes
            </label>
            <select
              id="quote-v2-sort"
              className={TEAM_SELECT}
              value={sort}
              onChange={(event) => {
                const next = event.target.value as QuoteV2ManageSort;
                setSort(next);
                void loadPage({ bucket, sort: next, search: appliedSearch });
              }}
            >
              {SORTS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <button className={teamButtonClass("primary")} disabled={loading}>
              {loading ? "Loading…" : "Search"}
            </button>
          </form>
        </div>

        <div
          className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-5"
          role="group"
          aria-label="Quote buckets"
        >
          {BUCKETS.map((item) => {
            const active = bucket === item.key;
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={active}
                className={`min-h-11 rounded-xl border px-3 py-3 text-left text-sm font-semibold ${TEAM_FOCUS_RING} ${
                  active
                    ? "border-[color:var(--team-focus-ring)] bg-[color:var(--team-action-primary)] text-[color:var(--team-action-primary-text)]"
                    : "border-[color:var(--team-border)] bg-[color:var(--team-surface)] text-[color:var(--team-text)]"
                }`}
                onClick={() => {
                  const next = active ? "all" : item.key;
                  setBucket(next);
                  void loadPage({ bucket: next, sort, search: appliedSearch });
                }}
              >
                <span className="block">{item.label}</span>
                <span className="mt-1 block text-xs font-normal opacity-80">
                  {counts[item.key]} on this page
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {listError ? (
        <div className={teamStatePanelClass("danger")} role="alert">
          {listError} This is not an empty quote list.
        </div>
      ) : null}

      <section className={TEAM_CARD_PADDED} aria-busy={loading}>
        {rows.length === 0 && !loading ? (
          <div className={TEAM_EMPTY_STATE}>
            No quotes match these server-side filters.
          </div>
        ) : (
          <ul
            className="divide-y divide-[color:var(--team-border)]"
            aria-label="Quotes"
          >
            {rows.map((row) => (
              <li
                key={row.id}
                className="grid gap-3 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] lg:items-center"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(row)}`}
                    >
                      {humanize(row.versionState ?? row.aggregateState)}
                    </span>
                    <span className="text-xs font-semibold text-[color:var(--team-text-soft)]">
                      {row.quoteNumber} · v{row.versionNumber ?? "—"}
                    </span>
                  </div>
                  <p className="mt-2 truncate font-semibold">
                    {customerLabel(row)}
                  </p>
                  <p className="truncate text-sm text-[color:var(--team-text-muted)]">
                    {projectLabel(row)}
                    {row.project.purchaseOrder
                      ? ` · PO ${row.project.purchaseOrder}`
                      : ""}
                  </p>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <div>
                    <dt className="text-xs text-[color:var(--team-text-soft)]">
                      Total
                    </dt>
                    <dd className="font-semibold">
                      {quoteV2ManageAmount(row)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[color:var(--team-text-soft)]">
                      Owner
                    </dt>
                    <dd>{row.owner?.name ?? "Unassigned"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[color:var(--team-text-soft)]">
                      Delivery
                    </dt>
                    <dd>{humanize(row.deliveryState ?? "not requested")}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[color:var(--team-text-soft)]">
                      Expiry
                    </dt>
                    <dd>{formatDate(row.expiresAt)}</dd>
                  </div>
                </dl>
                <div className="flex flex-col items-stretch gap-2 lg:items-end">
                  <p className="text-sm font-semibold text-[color:var(--team-link)]">
                    {row.nextAction.label}
                  </p>
                  <button
                    type="button"
                    className={teamButtonClass(
                      row.bucket === "needs_action" ? "primary" : "secondary",
                      "sm",
                    )}
                    onClick={() => void loadDetail(row)}
                  >
                    Open quote
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {nextCursor ? (
          <div className="mt-5 flex justify-center">
            <button
              type="button"
              className={teamButtonClass("secondary")}
              disabled={loading}
              onClick={() =>
                void loadPage({
                  bucket,
                  sort,
                  search: appliedSearch,
                  cursor: nextCursor,
                  append: true,
                })
              }
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        ) : null}
      </section>

      {selectedRow ? (
        <section
          className={TEAM_CARD_PADDED}
          aria-labelledby="quote-v2-detail-title"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--team-link)]">
                {selectedRow.quoteNumber}
              </p>
              <h3
                ref={detailHeadingRef}
                id="quote-v2-detail-title"
                tabIndex={-1}
                className="mt-1 text-xl font-semibold focus:outline-none"
              >
                {customerLabel(selectedRow)} · {projectLabel(selectedRow)}
              </h3>
              <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
                Last updated {formatDate(detail?.["updatedAt"])}
              </p>
            </div>
            <button
              type="button"
              className={teamButtonClass("secondary", "sm")}
              onClick={() => {
                setSelectedRow(null);
                setDetail(null);
                setPreview(null);
              }}
            >
              Close detail
            </button>
          </div>

          <div
            className="mt-5 flex flex-wrap gap-2"
            role="tablist"
            aria-label="Quote detail"
          >
            {(
              [
                ["overview", "Overview"],
                ["proposal", "Proposal & versions"],
                ["delivery", "Delivery & response"],
                ["activity", "Activity"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={detailTab === key}
                className={teamButtonClass(
                  detailTab === key ? "primary" : "secondary",
                  "sm",
                )}
                onClick={() => setDetailTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {detailLoading ? (
            <p className="mt-5 text-sm" role="status">
              Loading quote detail…
            </p>
          ) : null}
          {detailError ? (
            <div
              className={`mt-5 ${teamStatePanelClass("danger")}`}
              role="alert"
            >
              {detailError}
            </div>
          ) : null}

          {detail && detailTab === "overview" ? (
            <div className="mt-5 grid gap-4 lg:grid-cols-3" role="tabpanel">
              <div className="rounded-2xl border border-[color:var(--team-border)] p-4">
                <h4 className="font-semibold">Client and project</h4>
                <p className="mt-2 text-sm">
                  {text(
                    (detail["contact"] as Record<string, unknown> | null)?.[
                      "name"
                    ],
                  )}
                </p>
                <p className="text-sm text-[color:var(--team-text-muted)]">
                  {text(
                    (detail["contact"] as Record<string, unknown> | null)?.[
                      "company"
                    ],
                  )}
                </p>
                <p className="mt-3 text-sm">
                  {text(
                    (detail["opportunity"] as Record<string, unknown> | null)?.[
                      "name"
                    ],
                  )}
                </p>
                <p className="text-sm text-[color:var(--team-text-muted)]">
                  {text(
                    (detail["property"] as Record<string, unknown> | null)?.[
                      "addressLine1"
                    ],
                  )}
                </p>
              </div>
              <div className="rounded-2xl border border-[color:var(--team-border)] p-4">
                <h4 className="font-semibold">Lifecycle</h4>
                <dl className="mt-2 space-y-2 text-sm">
                  <div>
                    <dt className="text-[color:var(--team-text-soft)]">
                      Quote
                    </dt>
                    <dd>{humanize(detail["aggregateState"])}</dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--team-text-soft)]">
                      Opportunity
                    </dt>
                    <dd>
                      {humanize(
                        (
                          detail["opportunity"] as Record<
                            string,
                            unknown
                          > | null
                        )?.["stage"],
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[color:var(--team-text-soft)]">
                      Owner
                    </dt>
                    <dd>
                      {text(
                        (detail["owner"] as Record<string, unknown> | null)?.[
                          "name"
                        ],
                        "Unassigned",
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="rounded-2xl border border-[color:var(--team-border)] p-4">
                <h4 className="font-semibold">Next action</h4>
                <p className="mt-2 text-sm text-[color:var(--team-text-muted)]">
                  {selectedRow.nextAction.label}
                </p>
                {selectedRow.currentVersionId ? (
                  <button
                    type="button"
                    className={`mt-3 ${teamButtonClass("primary", "sm")}`}
                    onClick={() =>
                      void loadPreview(selectedRow.currentVersionId!)
                    }
                  >
                    Review proposal
                  </button>
                ) : null}
              </div>
              <div className="lg:col-span-3">
                <QuoteV2LifecyclePanel
                  key={selectedRow.id}
                  detail={detail}
                  canUpdate={canUpdate}
                  canSend={canSend}
                  onCommitted={refreshAfterLifecycle}
                />
              </div>
            </div>
          ) : null}

          {detail && detailTab === "proposal" ? (
            <div className="mt-5 space-y-4" role="tabpanel">
              {preview ? (
                <div className={teamStatePanelClass("info")}>
                  <p className="font-semibold">
                    Authenticated staff preview · {text(preview["quoteNumber"])}{" "}
                    v{text(preview["versionNumber"])}
                  </p>
                  <p className="mt-1">
                    {text(
                      (preview["document"] as Record<string, unknown> | null)?.[
                        "scope"
                      ],
                      "Scope is incomplete.",
                    )}
                  </p>
                  <p className="mt-2 text-xs">
                    This preview contains no customer action capability.
                  </p>
                </div>
              ) : null}
              <div className="space-y-3">
                {versions.map((version) => (
                  <article
                    key={text(version["id"])}
                    className="rounded-2xl border border-[color:var(--team-border)] p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h4 className="font-semibold">
                          Version {text(version["versionNumber"])} ·{" "}
                          {humanize(version["state"])}
                        </h4>
                        <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
                          {formatCents(version["totalMinCents"])}
                          {version["totalMaxCents"] !== version["totalMinCents"]
                            ? `–${formatCents(version["totalMaxCents"])}`
                            : ""}
                          {Number(version["depositCents"]) > 0
                            ? ` · Deposit ${formatCents(version["depositCents"])}`
                            : ""}
                        </p>
                        <p className="mt-1 text-xs text-[color:var(--team-text-soft)]">
                          Issued {formatDate(version["issuedAt"])} · Expires{" "}
                          {formatDate(version["expiresAt"])}
                        </p>
                      </div>
                      {typeof version["id"] === "string" ? (
                        <button
                          type="button"
                          className={teamButtonClass("secondary", "sm")}
                          onClick={() =>
                            void loadPreview(version["id"] as string)
                          }
                        >
                          Preview
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
              {canUpdate && selectedRow.publishedVersionId ? (
                <div className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <label
                    htmlFor="quote-v2-revision-reason"
                    className="text-sm font-semibold"
                  >
                    Create a revision
                  </label>
                  <textarea
                    id="quote-v2-revision-reason"
                    className={`${TEAM_INPUT} mt-2 w-full`}
                    rows={3}
                    maxLength={1_000}
                    value={revisionReason}
                    onChange={(event) => setRevisionReason(event.target.value)}
                    placeholder="Explain the correction, requested change, or expiry update."
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      className={teamButtonClass("primary", "sm")}
                      disabled={revisionBusy}
                      onClick={() => void createRevision()}
                    >
                      {revisionBusy ? "Creating…" : "Create revision draft"}
                    </button>
                    {revisionMessage ? (
                      <p className="text-sm" role="status">
                        {revisionMessage}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {detail && detailTab === "delivery" ? (
            <div className="mt-5 grid gap-5 xl:grid-cols-2" role="tabpanel">
              <div>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold">Delivery</h4>
                    <p className="mt-1 text-xs text-[color:var(--team-text-soft)]">
                      Last checked {formatDate(detailLastCheckedAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={teamButtonClass("secondary", "sm")}
                    disabled={manualRefreshBusy}
                    onClick={() => {
                      if (!selectedRow) return;
                      setManualRefreshBusy(true);
                      activeSendPollCount.current = 0;
                      setDeliveryPollNotice(null);
                      void loadDetail(selectedRow, {
                        background: true,
                      }).finally(() => {
                        setManualRefreshBusy(false);
                        setPollGeneration((current) => current + 1);
                      });
                    }}
                  >
                    {manualRefreshBusy ? "Refreshing…" : "Refresh delivery"}
                  </button>
                </div>

                {activeSendAttemptCount > 0 ? (
                  <div
                    className={`mt-3 ${teamStatePanelClass("info")}`}
                    role="status"
                    aria-live="polite"
                  >
                    {activeSendAttemptCount} active delivery attempt
                    {activeSendAttemptCount === 1 ? " is" : "s are"} being
                    checked automatically with bounded backoff. Another send is
                    disabled until it finishes.
                  </div>
                ) : null}
                {deliveryPollNotice ? (
                  <div
                    className={`mt-3 ${teamStatePanelClass("warning")}`}
                    role="status"
                  >
                    {deliveryPollNotice}
                  </div>
                ) : null}
                {sendFeedback ? (
                  <div
                    className={`mt-3 ${teamStatePanelClass(sendFeedback.tone)}`}
                    role={sendFeedback.tone === "danger" ? "alert" : "status"}
                    aria-live="polite"
                  >
                    {sendFeedback.message}
                  </div>
                ) : null}
                {!canSend ? (
                  <div className={`mt-3 ${teamStatePanelClass("warning")}`}>
                    Delivery history is read-only. Quote-send permission and an
                    enabled sender rollout are required to retry or resend.
                  </div>
                ) : null}

                <section
                  className="mt-4 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4"
                  aria-labelledby="quote-v2-resend-title"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="max-w-2xl">
                      <h5 id="quote-v2-resend-title" className="font-semibold">
                        Resend issued version {publishedVersionNumber}
                      </h5>
                      <p
                        id="quote-v2-resend-immutable-note"
                        className="mt-1 text-sm text-[color:var(--team-text-muted)]"
                      >
                        This creates a new delivery attempt against the same
                        immutable version. Price, scope, terms, PDF, issued
                        date, and expiry stay unchanged; only the chosen
                        recipient, channel, and optional introduction can
                        differ.
                      </p>
                    </div>
                    {canSend && sendVersionActionable ? (
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        aria-expanded={resendOpen}
                        disabled={
                          sendBusy !== null || activeSendAttemptCount > 0
                        }
                        onClick={() => {
                          setSendFeedback(null);
                          setResendOpen((current) => !current);
                        }}
                      >
                        {resendOpen ? "Close resend" : "New resend attempt"}
                      </button>
                    ) : null}
                  </div>
                  {canSend && sendBlockedReason ? (
                    <p className="mt-3 text-sm text-[color:var(--team-warning-text)]">
                      {sendBlockedReason}
                    </p>
                  ) : null}
                  {canSend && sendVersionActionable && resendOpen ? (
                    <form
                      className="mt-4 space-y-4"
                      aria-describedby="quote-v2-resend-immutable-note"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void resendPublishedVersion();
                      }}
                    >
                      <fieldset
                        className="space-y-4"
                        disabled={
                          sendBusy !== null || activeSendAttemptCount > 0
                        }
                      >
                        <legend className="text-sm font-semibold">
                          Designated signer and channels
                        </legend>
                        <label
                          className="block text-sm"
                          htmlFor="quote-v2-resend-name"
                        >
                          <span className="font-semibold">Signer name</span>
                          <input
                            id="quote-v2-resend-name"
                            className={`${TEAM_INPUT} mt-2 w-full`}
                            value={resendDraft.name}
                            maxLength={240}
                            required
                            autoComplete="name"
                            onChange={(event) =>
                              setResendDraft((current) => ({
                                ...current,
                                name: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3">
                            <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
                              <input
                                type="checkbox"
                                checked={resendDraft.emailSelected}
                                onChange={(event) =>
                                  setResendDraft((current) => ({
                                    ...current,
                                    emailSelected: event.target.checked,
                                  }))
                                }
                              />
                              Email the proposal PDF
                            </label>
                            <label
                              className="mt-2 block text-xs"
                              htmlFor="quote-v2-resend-email"
                            >
                              Email address
                            </label>
                            <input
                              id="quote-v2-resend-email"
                              className={`${TEAM_INPUT} mt-1 w-full`}
                              type="email"
                              value={resendDraft.email}
                              maxLength={320}
                              required={resendDraft.emailSelected}
                              autoComplete="email"
                              onChange={(event) =>
                                setResendDraft((current) => ({
                                  ...current,
                                  email: event.target.value,
                                }))
                              }
                            />
                          </div>
                          <div className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3">
                            <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
                              <input
                                type="checkbox"
                                checked={resendDraft.smsSelected}
                                onChange={(event) =>
                                  setResendDraft((current) => ({
                                    ...current,
                                    smsSelected: event.target.checked,
                                  }))
                                }
                              />
                              Text the secure link
                            </label>
                            <label
                              className="mt-2 block text-xs"
                              htmlFor="quote-v2-resend-phone"
                            >
                              Mobile number (E.164)
                            </label>
                            <input
                              id="quote-v2-resend-phone"
                              className={`${TEAM_INPUT} mt-1 w-full`}
                              type="tel"
                              value={resendDraft.phoneE164}
                              maxLength={32}
                              pattern={"^\\+[1-9]\\d{7,14}$"}
                              required={resendDraft.smsSelected}
                              autoComplete="tel"
                              onChange={(event) =>
                                setResendDraft((current) => ({
                                  ...current,
                                  phoneE164: event.target.value,
                                }))
                              }
                            />
                          </div>
                        </div>
                        <label
                          className="block text-sm"
                          htmlFor="quote-v2-resend-cover"
                        >
                          <span className="font-semibold">
                            Optional introduction
                          </span>
                          <textarea
                            id="quote-v2-resend-cover"
                            className={`${TEAM_INPUT} mt-2 w-full`}
                            rows={3}
                            maxLength={4_000}
                            value={resendDraft.coverMessage}
                            placeholder="Add a concise note; proposal facts remain deterministic."
                            onChange={(event) =>
                              setResendDraft((current) => ({
                                ...current,
                                coverMessage: event.target.value,
                              }))
                            }
                          />
                        </label>
                      </fieldset>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="submit"
                          className={teamButtonClass("primary", "sm")}
                          disabled={
                            sendBusy !== null || activeSendAttemptCount > 0
                          }
                        >
                          {sendBusy === "resend"
                            ? "Requesting send…"
                            : "Send immutable version again"}
                        </button>
                        <button
                          type="button"
                          className={teamButtonClass("secondary", "sm")}
                          disabled={sendBusy !== null}
                          onClick={() => setResendOpen(false)}
                        >
                          Cancel
                        </button>
                        <p className="text-xs text-[color:var(--team-text-soft)]">
                          This may send another message on every selected
                          channel.
                        </p>
                      </div>
                    </form>
                  ) : null}
                </section>

                <div className="mt-3 space-y-3">
                  {sendAttempts.length === 0 ? (
                    <p className={TEAM_EMPTY_STATE}>No send attempt yet.</p>
                  ) : (
                    sendAttempts.map((attempt) => (
                      <article
                        key={text(attempt["id"])}
                        className="rounded-2xl border border-[color:var(--team-border)] p-4 text-sm"
                      >
                        <p className="font-semibold">
                          Attempt {text(attempt["attemptNumber"])} · Version{" "}
                          {text(
                            versions.find(
                              (version) =>
                                version["id"] === attempt["quoteVersionId"],
                            )?.["versionNumber"],
                          )}{" "}
                          · {humanize(attempt["status"])}
                        </p>
                        <p className="mt-1 text-[color:var(--team-text-muted)]">
                          Requested {formatDate(attempt["requestedAt"])}
                        </p>
                        {records(attempt["deliveries"]).map((delivery) => {
                          const deliveryId = text(delivery["id"]);
                          const retryable = quoteV2DeliveryIsRetryable({
                            attempt,
                            delivery,
                            publishedVersionId,
                          });
                          const status = text(delivery["status"], "");
                          return (
                            <div
                              key={deliveryId}
                              className="mt-2 rounded-xl bg-[color:var(--team-surface-muted)] p-3"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="font-semibold">
                                    {humanize(delivery["channel"])} ·{" "}
                                    {humanize(delivery["recipientRole"])} ·{" "}
                                    {humanize(status)}
                                  </p>
                                  <p className="mt-1 text-xs text-[color:var(--team-text-soft)]">
                                    {text(
                                      delivery["recipientDisplayHint"],
                                      "Recipient protected",
                                    )}
                                  </p>
                                </div>
                                {canSend && retryable ? (
                                  <button
                                    type="button"
                                    className={teamButtonClass(
                                      "secondary",
                                      "sm",
                                    )}
                                    disabled={
                                      sendBusy !== null ||
                                      activeSendAttemptCount > 0 ||
                                      !sendVersionActionable
                                    }
                                    onClick={() =>
                                      void retryFailedDelivery(
                                        attempt,
                                        delivery,
                                      )
                                    }
                                  >
                                    {sendBusy === `retry:${deliveryId}`
                                      ? "Requesting retry…"
                                      : `Retry ${humanize(delivery["channel"])}`}
                                  </button>
                                ) : null}
                              </div>
                              {nullableText(delivery["errorDetail"]) ? (
                                <p className="mt-2 text-sm">
                                  {text(delivery["errorDetail"])}
                                </p>
                              ) : null}
                              {canSend && retryable ? (
                                <p className="mt-2 text-xs text-[color:var(--team-text-soft)]">
                                  Retries this failed channel only, using the
                                  same immutable version, recipient, capability,
                                  content, PDF, and original expiry. Successful
                                  channels stay untouched.
                                </p>
                              ) : null}
                              {status === "reconciliation_required" ? (
                                <p className="mt-2 text-xs text-[color:var(--team-warning-text)]">
                                  Provider delivery is uncertain. Reconcile it
                                  before retrying so the client does not receive
                                  a duplicate.
                                </p>
                              ) : null}
                              {status === "failed" && !retryable ? (
                                <p className="mt-2 text-xs text-[color:var(--team-text-soft)]">
                                  This failure belongs to a non-current version
                                  and is retained as read-only history.
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </article>
                    ))
                  )}
                </div>
              </div>
              <div>
                <h4 className="font-semibold">
                  Responses and requested changes
                </h4>
                <div className="mt-3 space-y-3">
                  {[...changeRequests, ...responses].length === 0 ? (
                    <p className={TEAM_EMPTY_STATE}>No client response yet.</p>
                  ) : null}
                  {changeRequests.map((change) => (
                    <article
                      key={text(change["id"])}
                      className="rounded-2xl border border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] p-4 text-sm"
                    >
                      <p className="font-semibold">
                        Change request · {humanize(change["status"])}
                      </p>
                      <p className="mt-2 whitespace-pre-wrap">
                        {text(change["message"], "No message supplied")}
                      </p>
                      <p className="mt-2 text-xs">
                        {formatDate(change["createdAt"])}
                      </p>
                    </article>
                  ))}
                  {responses.map((response) => (
                    <article
                      key={text(response["id"])}
                      className="rounded-2xl border border-[color:var(--team-border)] p-4 text-sm"
                    >
                      <p className="font-semibold">
                        {humanize(response["responseType"])} ·{" "}
                        {humanize(response["source"])}
                      </p>
                      <p className="mt-1 text-[color:var(--team-text-muted)]">
                        {formatDate(response["respondedAt"])} ·{" "}
                        {formatCents(response["totalMinCents"])}
                        {response["totalMaxCents"] !== response["totalMinCents"]
                          ? `–${formatCents(response["totalMaxCents"])}`
                          : ""}
                      </p>
                    </article>
                  ))}
                </div>
              </div>
              <div className="xl:col-span-2">
                <h4 className="font-semibold">Customer access links</h4>
                <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
                  Lifecycle metadata only is shown here. Existing customer URLs
                  and token hashes are never returned to the staff read API.
                </p>
                {oneTimeLink ? (
                  <div className={`mt-3 ${teamStatePanelClass("warning")}`}>
                    <label
                      htmlFor="quote-v2-one-time-link"
                      className="font-semibold"
                    >
                      Copy this replacement signer link now
                    </label>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <input
                        id="quote-v2-one-time-link"
                        className={`${TEAM_INPUT} min-w-0 flex-1 font-mono text-xs`}
                        value={oneTimeLink}
                        readOnly
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={() =>
                          void globalThis.navigator.clipboard
                            ?.writeText(oneTimeLink)
                            .then(() =>
                              setCapabilityMessage(
                                "Replacement link copied. Share it only with the designated signer.",
                              ),
                            )
                        }
                      >
                        Copy link
                      </button>
                    </div>
                    <p className="mt-2 text-xs">
                      It is not retained in this staff response after you leave
                      or refresh.
                    </p>
                  </div>
                ) : null}
                {canSend &&
                capabilities.some((item) => item["status"] === "active") ? (
                  <label className="mt-3 block max-w-2xl text-sm">
                    <span className="font-semibold">
                      Reason for link change
                    </span>
                    <textarea
                      className={`${TEAM_INPUT} mt-2 w-full`}
                      rows={2}
                      maxLength={1_000}
                      value={capabilityReason}
                      onChange={(event) =>
                        setCapabilityReason(event.target.value)
                      }
                      placeholder="Example: Client reported that the original message was forwarded."
                    />
                  </label>
                ) : null}
                {capabilityMessage ? (
                  <p className="mt-3 text-sm" role="status">
                    {capabilityMessage}
                  </p>
                ) : null}
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  {capabilities.length === 0 ? (
                    <p className={TEAM_EMPTY_STATE}>
                      No scoped customer access record is available.
                    </p>
                  ) : (
                    capabilities.map((capability) => {
                      const capabilityId = text(capability["id"]);
                      const active = capability["status"] === "active";
                      const signer = capability["recipientRole"] === "signer";
                      return (
                        <article
                          key={capabilityId}
                          className="rounded-2xl border border-[color:var(--team-border)] p-4 text-sm"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="font-semibold">
                                {humanize(capability["recipientRole"])} ·{" "}
                                {humanize(capability["status"])}
                              </p>
                              <p className="mt-1 text-[color:var(--team-text-muted)]">
                                Actions:{" "}
                                {Array.isArray(capability["allowedActions"])
                                  ? capability["allowedActions"]
                                      .map(humanize)
                                      .join(", ")
                                  : "View only"}
                              </p>
                            </div>
                            <span className="text-xs text-[color:var(--team-text-soft)]">
                              Used {text(capability["useCount"], "0")} times
                            </span>
                          </div>
                          <p className="mt-2 text-xs text-[color:var(--team-text-soft)]">
                            Issued {formatDate(capability["issuedAt"])} · Read
                            access until{" "}
                            {formatDate(capability["readExpiresAt"])}
                          </p>
                          {canSend && active ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {signer ? (
                                <button
                                  type="button"
                                  className={teamButtonClass("secondary", "sm")}
                                  disabled={capabilityBusy !== null}
                                  onClick={() =>
                                    void manageCapability(capability, "replace")
                                  }
                                >
                                  {capabilityBusy === `${capabilityId}:replace`
                                    ? "Replacing…"
                                    : "Replace signer link"}
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className={teamButtonClass("danger", "sm")}
                                disabled={capabilityBusy !== null}
                                onClick={() => {
                                  if (
                                    globalThis.confirm(
                                      "Revoke this customer link immediately? It will stop opening for the recipient.",
                                    )
                                  ) {
                                    void manageCapability(capability, "revoke");
                                  }
                                }}
                              >
                                {capabilityBusy === `${capabilityId}:revoke`
                                  ? "Revoking…"
                                  : "Revoke access"}
                              </button>
                            </div>
                          ) : null}
                        </article>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {detail && detailTab === "activity" ? (
            <div className="mt-5" role="tabpanel">
              {activity.length === 0 ? (
                <p className={TEAM_EMPTY_STATE}>No quote activity recorded.</p>
              ) : (
                <ol className="space-y-3">
                  {activity.map((event) => (
                    <li
                      key={text(event["id"])}
                      className="rounded-2xl border border-[color:var(--team-border)] p-4 text-sm"
                    >
                      <p className="font-semibold">
                        {humanize(event["eventType"])}
                      </p>
                      <p className="mt-1 text-[color:var(--team-text-muted)]">
                        {humanize(event["actorType"])} ·{" "}
                        {formatDate(event["occurredAt"])}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
