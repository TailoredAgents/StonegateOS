"use client";

import React from "react";
import Link from "next/link";
import {
  professionalQuoteBundlePresets,
  professionalQuoteServicePresets,
  professionalQuoteZonePresets,
} from "@myst-os/pricing/src/quote-catalog";
import {
  QuoteV2ClientError,
  QuoteV2StaffClient,
  type QuoteV2DraftReceipt,
  type QuoteV2AttachmentItem,
  type QuoteV2IssuerSnapshot,
  type QuoteV2IssueReceipt,
} from "../lib/quote-v2-client";
import {
  QUOTE_V2_COMPOSER_STEPS,
  applyQuoteV2AudienceDefaults,
  calculateQuoteV2OptimisticTotals,
  formatQuoteV2Money,
  newQuoteV2ComposerDraft,
  newQuoteV2LineDraft,
  quoteV2ContactResultLabel,
  quoteV2Readiness,
  type QuoteV2AdjustmentDraft,
  type QuoteV2ComposerDraft,
  type QuoteV2ComposerStep,
  type QuoteV2ContactSearchResult,
  type QuoteV2OptionGroupDraft,
} from "../lib/quote-v2-composer-model";
import {
  TEAM_CARD,
  TEAM_CARD_PADDED,
  TEAM_FOCUS_RING,
  TEAM_INPUT,
  TEAM_INPUT_COMPACT,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  TEAM_SELECT,
  teamButtonClass,
  teamStatePanelClass,
} from "./team-ui";

const STEP_DETAILS: Record<
  QuoteV2ComposerStep,
  { number: number; label: string; shortLabel: string; description: string }
> = {
  client_project: {
    number: 1,
    label: "Client and project",
    shortLabel: "Client",
    description: "Choose the exact client, property, and project context.",
  },
  items_scope: {
    number: 2,
    label: "Items and scope",
    shortLabel: "Items",
    description: "Build transparent pricing and the customer-facing scope.",
  },
  terms_fulfillment: {
    number: 3,
    label: "Terms and fulfillment",
    shortLabel: "Terms",
    description: "Set proposal type, validity, deposit, and scheduling.",
  },
  review_send: {
    number: 4,
    label: "Review and send",
    shortLabel: "Review",
    description: "Verify the exact facts, signer, channels, and readiness.",
  },
};

type SaveStatus =
  | "local"
  | "creating"
  | "saving"
  | "saved"
  | "error"
  | "issuing"
  | "issue_error"
  | "issued";

type QuickCreateDraft = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
};

const EMPTY_QUICK_CREATE: QuickCreateDraft = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  addressLine1: "",
  city: "",
  state: "",
  postalCode: "",
};

type RecoveryEnvelope = {
  version: 1;
  savedAt: string;
  draft: QuoteV2ComposerDraft;
  receipt: QuoteV2DraftReceipt | null;
  createRequestKey: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recoverableEnvelope(value: unknown): RecoveryEnvelope | null {
  if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["draft"])) {
    return null;
  }
  const draft = value["draft"];
  if (
    typeof value["savedAt"] !== "string" ||
    typeof draft["contactId"] !== "string" ||
    typeof draft["propertyId"] !== "string" ||
    typeof draft["projectName"] !== "string" ||
    !Array.isArray(draft["lines"]) ||
    !Array.isArray(draft["optionGroups"]) ||
    !Array.isArray(draft["adjustments"])
  ) {
    return null;
  }
  const receipt = value["receipt"];
  if (
    receipt !== null &&
    receipt !== undefined &&
    (!isRecord(receipt) ||
      typeof receipt["quoteId"] !== "string" ||
      typeof receipt["versionId"] !== "string" ||
      typeof receipt["quoteRevision"] !== "number" ||
      typeof receipt["draftRevision"] !== "number")
  ) {
    return null;
  }
  const createRequestKey = value["createRequestKey"];
  if (
    createRequestKey !== null &&
    createRequestKey !== undefined &&
    (typeof createRequestKey !== "string" || createRequestKey.length > 200)
  ) {
    return null;
  }
  return {
    version: 1,
    savedAt: value["savedAt"],
    draft: {
      ...(draft as QuoteV2ComposerDraft),
      serviceZoneId:
        typeof draft["serviceZoneId"] === "string"
          ? draft["serviceZoneId"]
          : "",
      serviceZoneConfirmed: draft["serviceZoneConfirmed"] === true,
      lines: (draft["lines"] as QuoteV2ComposerDraft["lines"]).map((line) => ({
        ...line,
        catalogKey:
          typeof (line as { catalogKey?: unknown }).catalogKey === "string"
            ? (line as { catalogKey: string }).catalogKey
            : "",
      })),
      additionalRecipients: Array.isArray(draft["additionalRecipients"])
        ? (draft[
            "additionalRecipients"
          ] as QuoteV2ComposerDraft["additionalRecipients"])
        : [],
    },
    receipt: (receipt as QuoteV2DraftReceipt | null | undefined) ?? null,
    createRequestKey: createRequestKey ?? null,
  };
}

function requestKey(scope: string): string {
  return `quote-v2:${scope}:${globalThis.crypto.randomUUID()}`;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="text-xs text-[color:var(--team-danger-text)]">
      {message}
    </p>
  ) : null;
}

function TextListField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
}) {
  return (
    <label htmlFor={id} className="space-y-2 text-sm">
      <span className="block font-medium text-[color:var(--team-text)]">
        {label}
      </span>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className={`${TEAM_INPUT} w-full resize-y`}
        aria-describedby={`${id}-hint`}
      />
      <span
        id={`${id}-hint`}
        className="block text-xs text-[color:var(--team-text-soft)]"
      >
        {hint}
      </span>
    </label>
  );
}

function quoteRangeLabel(
  minimum: number,
  maximum: number,
  documentType: QuoteV2ComposerDraft["documentType"],
): string {
  return documentType === "range" && maximum !== minimum
    ? `${formatQuoteV2Money(minimum)} – ${formatQuoteV2Money(maximum)}`
    : formatQuoteV2Money(minimum);
}

export type QuoteV2ComposerClientProps = {
  canSend: boolean;
  canQuickCreate: boolean;
  preparerName: string;
  issuer: QuoteV2IssuerSnapshot;
  recoveryId: string;
  initialContactId?: string;
  initialPropertyId?: string;
};

export default function QuoteV2ComposerClient({
  canSend,
  canQuickCreate,
  preparerName,
  issuer,
  recoveryId,
  initialContactId,
  initialPropertyId,
}: QuoteV2ComposerClientProps) {
  const client = React.useMemo(() => new QuoteV2StaffClient(), []);
  const [step, setStep] = React.useState<QuoteV2ComposerStep>("client_project");
  const [draft, setDraft] = React.useState<QuoteV2ComposerDraft>(() =>
    newQuoteV2ComposerDraft(recoveryId),
  );
  const [contactQuery, setContactQuery] = React.useState("");
  const [servicePresetId, setServicePresetId] = React.useState("");
  const [bundlePresetId, setBundlePresetId] = React.useState("");
  const [contactResults, setContactResults] = React.useState<
    QuoteV2ContactSearchResult[]
  >([]);
  const [contactSearchState, setContactSearchState] = React.useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [contactSearchMessage, setContactSearchMessage] = React.useState<
    string | null
  >(null);
  const [quickCreateOpen, setQuickCreateOpen] = React.useState(false);
  const [quickCreate, setQuickCreate] =
    React.useState<QuickCreateDraft>(EMPTY_QUICK_CREATE);
  const [quickCreateSaving, setQuickCreateSaving] = React.useState(false);
  const [recovery, setRecovery] = React.useState<RecoveryEnvelope | null>(null);
  const [hydrated, setHydrated] = React.useState(false);
  const [receipt, setReceipt] = React.useState<QuoteV2DraftReceipt | null>(
    null,
  );
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>("local");
  const [saveMessage, setSaveMessage] = React.useState(
    "Saved locally until the client, property, and project are complete.",
  );
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>(
    {},
  );
  const [retryCreate, setRetryCreate] = React.useState(0);
  const [issueReceipt, setIssueReceipt] =
    React.useState<QuoteV2IssueReceipt | null>(null);
  const [attachments, setAttachments] = React.useState<QuoteV2AttachmentItem[]>(
    [],
  );
  const [attachmentPurpose, setAttachmentPurpose] =
    React.useState<QuoteV2AttachmentItem["purpose"]>("scope_evidence");
  const [attachmentCustomerVisible, setAttachmentCustomerVisible] =
    React.useState(true);
  const [attachmentLabel, setAttachmentLabel] = React.useState("");
  const [attachmentStatus, setAttachmentStatus] = React.useState<
    "idle" | "uploading" | "error"
  >("idle");
  const [attachmentMessage, setAttachmentMessage] = React.useState<
    string | null
  >(null);
  const [removingAttachmentId, setRemovingAttachmentId] = React.useState<
    string | null
  >(null);
  const attachmentInputRef = React.useRef<HTMLInputElement | null>(null);
  const loadedAttachmentVersionRef = React.useRef<string | null>(null);
  const stepHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
  const createKeyRef = React.useRef<string | null>(null);
  const savedFingerprintRef = React.useRef<string | null>(null);
  const saveSequenceRef = React.useRef(0);
  const pendingSaveRef = React.useRef<{
    fingerprint: string;
    revision: number;
    idempotencyKey: string;
  } | null>(null);
  const finalizeKeyRef = React.useRef<string | null>(null);
  const issueKeyRef = React.useRef<string | null>(null);
  const recoveryKey = React.useMemo(
    () =>
      `stonegate:quote-v2:${initialContactId ?? "blank"}:${initialPropertyId ?? "blank"}`,
    [initialContactId, initialPropertyId],
  );

  const optimisticTotals = React.useMemo(
    () => calculateQuoteV2OptimisticTotals(draft),
    [draft],
  );
  const draftFingerprint = React.useMemo(() => JSON.stringify(draft), [draft]);
  const draftIsServerSaved = Boolean(
    receipt && savedFingerprintRef.current === draftFingerprint,
  );
  const displayedTotals =
    draftIsServerSaved && receipt?.authoritativeTotals
      ? receipt.authoritativeTotals
      : optimisticTotals;
  const readiness = React.useMemo(
    () => quoteV2Readiness(draft, optimisticTotals),
    [draft, optimisticTotals],
  );
  const totalsMismatch = Boolean(
    draftIsServerSaved &&
      receipt?.authoritativeTotals &&
      (receipt.authoritativeTotals.totalMinCents !==
        optimisticTotals.totalMinCents ||
        receipt.authoritativeTotals.totalMaxCents !==
          optimisticTotals.totalMaxCents),
  );
  const selectedProperty = draft.contact?.properties.find(
    (property) => property.id === draft.propertyId,
  );
  const selectedZone = professionalQuoteZonePresets.find(
    (zone) => zone.id === draft.serviceZoneId,
  );

  const updateDraft = React.useCallback(
    <K extends keyof QuoteV2ComposerDraft>(
      key: K,
      value: QuoteV2ComposerDraft[K],
    ) => {
      setDraft((current) => ({ ...current, [key]: value }));
      setIssueReceipt(null);
      setSaveStatus((current) =>
        current === "error" || current === "issue_error" ? "local" : current,
      );
      setFieldErrors((current) => {
        if (!(String(key) in current)) return current;
        const next = { ...current };
        delete next[String(key)];
        return next;
      });
    },
    [],
  );

  const chooseContact = React.useCallback(
    (contact: QuoteV2ContactSearchResult) => {
      setDraft((current) => ({
        ...current,
        contact,
        contactId: contact.id,
        propertyId: "",
        serviceZoneId: "",
        serviceZoneConfirmed: false,
        adjustments: current.adjustments.filter(
          (item) => item.id !== "service-zone-travel",
        ),
        attentionName: contact.name,
        attentionTitle: contact.title || "",
        billingAddress: "",
        recipient: {
          ...current.recipient,
          name: contact.name,
          email: contact.email ?? "",
          phoneE164: contact.phoneE164 ?? "",
          emailSelected: Boolean(contact.email),
          smsSelected: !contact.email && Boolean(contact.phoneE164),
        },
      }));
      setContactQuery("");
      setContactResults([]);
      setContactSearchState("idle");
      setIssueReceipt(null);
    },
    [],
  );

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(recoveryKey);
      if (raw && raw.length <= 300_000) {
        const parsed = recoverableEnvelope(JSON.parse(raw) as unknown);
        if (parsed) setRecovery(parsed);
      }
    } catch {
      window.localStorage.removeItem(recoveryKey);
    } finally {
      setHydrated(true);
    }
  }, [recoveryKey]);

  React.useEffect(() => {
    if (!hydrated || recovery || saveStatus === "issued") return;
    const timer = window.setTimeout(() => {
      const envelope: RecoveryEnvelope = {
        version: 1,
        savedAt: new Date().toISOString(),
        draft,
        receipt,
        createRequestKey: createKeyRef.current,
      };
      try {
        window.localStorage.setItem(recoveryKey, JSON.stringify(envelope));
      } catch {
        setSaveStatus("error");
        setSaveMessage(
          "Local recovery is unavailable. Keep this page open until the server save completes.",
        );
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, hydrated, receipt, recovery, recoveryKey, saveStatus]);

  React.useEffect(() => {
    if (!initialContactId || recovery) return;
    const controller = new AbortController();
    setContactSearchState("loading");
    void client
      .searchContacts({
        contactId: initialContactId,
        signal: controller.signal,
      })
      .then((contacts) => {
        const contact = contacts.find(
          (candidate) => candidate.id === initialContactId,
        );
        if (!contact) {
          setContactSearchState("error");
          setContactSearchMessage(
            "The linked client could not be verified. Search and select a client explicitly.",
          );
          return;
        }
        chooseContact(contact);
        if (initialPropertyId) {
          const property = contact.properties.find(
            (candidate) => candidate.id === initialPropertyId,
          );
          if (property) {
            setDraft((current) => ({
              ...current,
              propertyId: property.id,
              billingAddress: property.billingLabel ?? current.billingAddress,
            }));
          } else {
            setContactSearchMessage(
              "The linked property does not belong to this client. Choose the correct property.",
            );
          }
        }
        setContactSearchState("loaded");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setContactSearchState("error");
        setContactSearchMessage(
          error instanceof Error
            ? error.message
            : "The linked client could not be loaded.",
        );
      });
    return () => controller.abort();
  }, [chooseContact, client, initialContactId, initialPropertyId, recovery]);

  React.useEffect(() => {
    const query = contactQuery.trim();
    if (query.length < 2) {
      setContactResults([]);
      if (!initialContactId) setContactSearchState("idle");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setContactSearchState("loading");
      setContactSearchMessage(null);
      void client
        .searchContacts({ query, signal: controller.signal })
        .then((contacts) => {
          setContactResults(contacts);
          setContactSearchState("loaded");
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setContactSearchState("error");
          setContactSearchMessage(
            error instanceof Error
              ? error.message
              : "Client search is unavailable.",
          );
        });
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, contactQuery, initialContactId]);

  const stepOneComplete = Boolean(
    draft.contactId && draft.propertyId && draft.projectName.trim(),
  );
  React.useEffect(() => {
    if (!hydrated || recovery || receipt || !stepOneComplete) return;
    const timer = window.setTimeout(() => {
      createKeyRef.current ??= requestKey("create");
      try {
        window.localStorage.setItem(
          recoveryKey,
          JSON.stringify({
            version: 1,
            savedAt: new Date().toISOString(),
            draft,
            receipt: null,
            createRequestKey: createKeyRef.current,
          } satisfies RecoveryEnvelope),
        );
      } catch {
        // The visible save state still reports any subsequent recovery failure.
      }
      setSaveStatus("creating");
      setSaveMessage("Creating the server draft…");
      void client
        .createDraft(draft, createKeyRef.current)
        .then((nextReceipt) => {
          setReceipt(nextReceipt);
          savedFingerprintRef.current = null;
          createKeyRef.current = null;
          setSaveStatus("local");
          setSaveMessage("Draft created. Saving proposal details…");
          setFieldErrors({});
        })
        .catch((error: unknown) => {
          const detail =
            error instanceof QuoteV2ClientError
              ? error.detail
              : {
                  message: "The quote draft could not be created.",
                  fieldErrors: {},
                  correlationId: null,
                };
          setFieldErrors(detail.fieldErrors);
          setSaveStatus("error");
          setSaveMessage(
            `${detail.message}${detail.correlationId ? ` Reference ${detail.correlationId}.` : ""}`,
          );
        });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [
    client,
    draft,
    hydrated,
    receipt,
    recovery,
    recoveryKey,
    retryCreate,
    stepOneComplete,
  ]);

  React.useEffect(() => {
    if (
      !receipt ||
      recovery ||
      saveStatus === "creating" ||
      saveStatus === "saving" ||
      saveStatus === "error" ||
      saveStatus === "issue_error" ||
      saveStatus === "issuing" ||
      saveStatus === "issued" ||
      savedFingerprintRef.current === draftFingerprint
    ) {
      return;
    }
    const sequence = saveSequenceRef.current + 1;
    saveSequenceRef.current = sequence;
    const pending = pendingSaveRef.current;
    const saveAttempt =
      pending?.fingerprint === draftFingerprint &&
      pending.revision === receipt.draftRevision
        ? pending
        : {
            fingerprint: draftFingerprint,
            revision: receipt.draftRevision,
            idempotencyKey: requestKey(`save-${receipt.draftRevision}`),
          };
    pendingSaveRef.current = saveAttempt;
    const timer = window.setTimeout(() => {
      setSaveStatus("saving");
      setSaveMessage("Saving draft…");
      void client
        .saveDraft({
          quoteId: receipt.quoteId,
          versionId: receipt.versionId,
          draftRevision: receipt.draftRevision,
          draft,
          preparerName,
          issuer,
          idempotencyKey: saveAttempt.idempotencyKey,
        })
        .then((nextReceipt) => {
          if (saveSequenceRef.current !== sequence) return;
          savedFingerprintRef.current = draftFingerprint;
          pendingSaveRef.current = null;
          setReceipt(nextReceipt);
          setFieldErrors({});
          setSaveStatus("saved");
          setSaveMessage(
            `Saved ${new Intl.DateTimeFormat("en-US", {
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
            }).format(new Date())}`,
          );
        })
        .catch((error: unknown) => {
          if (saveSequenceRef.current !== sequence) return;
          const detail =
            error instanceof QuoteV2ClientError
              ? error.detail
              : {
                  message: "The draft could not be saved.",
                  fieldErrors: {},
                  correlationId: null,
                };
          setFieldErrors(detail.fieldErrors);
          setSaveStatus("error");
          setSaveMessage(
            `${detail.message}${detail.correlationId ? ` Reference ${detail.correlationId}.` : ""}`,
          );
        });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [
    client,
    draft,
    draftFingerprint,
    issuer,
    preparerName,
    receipt,
    recovery,
    saveStatus,
  ]);

  React.useEffect(() => {
    const shouldWarn =
      saveStatus === "creating" ||
      saveStatus === "saving" ||
      saveStatus === "error" ||
      saveStatus === "issue_error" ||
      (receipt !== null && savedFingerprintRef.current !== draftFingerprint);
    if (!shouldWarn) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draftFingerprint, receipt, saveStatus]);

  React.useEffect(() => {
    const versionId = receipt?.versionId ?? null;
    if (!versionId || loadedAttachmentVersionRef.current === versionId) return;
    loadedAttachmentVersionRef.current = versionId;
    void client
      .listAttachments(versionId)
      .then((items) => setAttachments(items))
      .catch((error: unknown) => {
        loadedAttachmentVersionRef.current = null;
        setAttachmentStatus("error");
        setAttachmentMessage(
          error instanceof Error
            ? error.message
            : "Attachments could not be loaded.",
        );
      });
  }, [client, receipt?.versionId]);

  React.useEffect(() => {
    if (saveStatus !== "issue_error" || draftIsServerSaved) return;
    finalizeKeyRef.current = null;
    issueKeyRef.current = null;
    setSaveStatus("local");
    setSaveMessage(
      "Proposal changed after the failed issue attempt. Saving a new draft state…",
    );
  }, [draftIsServerSaved, saveStatus]);

  React.useEffect(() => {
    stepHeadingRef.current?.focus({ preventScroll: true });
  }, [step]);

  function selectStep(nextStep: QuoteV2ComposerStep) {
    setStep(nextStep);
    window.requestAnimationFrame(() => {
      document.getElementById("quote-v2-composer")?.scrollIntoView({
        block: "start",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    });
  }

  function moveStep(direction: -1 | 1) {
    const current = QUOTE_V2_COMPOSER_STEPS.indexOf(step);
    const next = QUOTE_V2_COMPOSER_STEPS[current + direction];
    if (next) selectStep(next);
  }

  async function createClientInline() {
    if (
      !quickCreate.firstName.trim() ||
      !quickCreate.lastName.trim() ||
      !quickCreate.addressLine1.trim() ||
      !quickCreate.city.trim() ||
      !quickCreate.state.trim() ||
      !quickCreate.postalCode.trim()
    ) {
      setContactSearchState("error");
      setContactSearchMessage(
        "First name, last name, street, city, state, and postal code are required.",
      );
      return;
    }
    setQuickCreateSaving(true);
    setContactSearchMessage(null);
    try {
      const contact = await client.quickCreateContact(
        quickCreate,
        requestKey("quick-create-client"),
      );
      chooseContact(contact);
      setDraft((current) => ({
        ...current,
        propertyId: contact.properties[0]?.id ?? "",
      }));
      setQuickCreate(EMPTY_QUICK_CREATE);
      setQuickCreateOpen(false);
      setContactSearchMessage(
        "Client and property created. Review both before continuing.",
      );
      setContactSearchState("loaded");
    } catch (error) {
      setContactSearchState("error");
      setContactSearchMessage(
        error instanceof Error
          ? error.message
          : "The client could not be created.",
      );
    } finally {
      setQuickCreateSaving(false);
    }
  }

  async function uploadAttachment(file: File) {
    if (
      !receipt ||
      !draftIsServerSaved ||
      saveStatus !== "saved" ||
      attachments.length >= 10
    ) {
      setAttachmentStatus("error");
      setAttachmentMessage(
        attachments.length >= 10
          ? "Remove an attachment before adding another."
          : "Wait for the current draft save to finish before adding a file.",
      );
      return;
    }
    setAttachmentStatus("uploading");
    setAttachmentMessage(`Uploading ${file.name}…`);
    try {
      const result = await client.uploadAttachment({
        quoteId: receipt.quoteId,
        versionId: receipt.versionId,
        draftRevision: receipt.draftRevision,
        file,
        purpose: attachmentCustomerVisible
          ? attachmentPurpose === "internal"
            ? "scope_evidence"
            : attachmentPurpose
          : "internal",
        customerVisible: attachmentCustomerVisible,
        label: attachmentLabel,
        idempotencyKey: requestKey(`attachment-${receipt.draftRevision}`),
      });
      setAttachments((current) => [...current, result.attachment]);
      setReceipt({
        ...result.draft,
        authoritativeTotals:
          result.draft.authoritativeTotals ?? receipt.authoritativeTotals,
      });
      setAttachmentLabel("");
      setAttachmentStatus("idle");
      setAttachmentMessage(
        attachmentCustomerVisible
          ? "Attachment added to the customer proposal."
          : "Internal attachment added. It is excluded from every customer render.",
      );
    } catch (error) {
      setAttachmentStatus("error");
      setAttachmentMessage(
        error instanceof Error
          ? error.message
          : "The attachment could not be added.",
      );
    } finally {
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  }

  async function removeAttachment(attachment: QuoteV2AttachmentItem) {
    if (!receipt || removingAttachmentId) return;
    setRemovingAttachmentId(attachment.attachmentId);
    setAttachmentMessage(`Removing ${attachment.fileName}…`);
    try {
      const nextReceipt = await client.removeAttachment({
        versionId: receipt.versionId,
        attachmentId: attachment.attachmentId,
        draftRevision: receipt.draftRevision,
        idempotencyKey: requestKey(
          `remove-attachment-${receipt.draftRevision}`,
        ),
      });
      setAttachments((current) =>
        current.filter(
          (candidate) => candidate.attachmentId !== attachment.attachmentId,
        ),
      );
      setReceipt({
        ...nextReceipt,
        authoritativeTotals:
          nextReceipt.authoritativeTotals ?? receipt.authoritativeTotals,
      });
      setAttachmentStatus("idle");
      setAttachmentMessage("Attachment removed from this draft.");
    } catch (error) {
      setAttachmentStatus("error");
      setAttachmentMessage(
        error instanceof Error
          ? error.message
          : "The attachment could not be removed.",
      );
    } finally {
      setRemovingAttachmentId(null);
    }
  }

  async function issueProposal() {
    if (
      !receipt ||
      !readiness.ready ||
      (saveStatus !== "saved" && saveStatus !== "issue_error") ||
      !draftIsServerSaved ||
      !canSend
    ) {
      const firstIncomplete = readiness.requirements.find(
        (item) => !item.complete,
      );
      if (firstIncomplete) selectStep(firstIncomplete.step);
      setSaveStatus("error");
      setSaveMessage(
        firstIncomplete
          ? `Complete “${firstIncomplete.label}” before issuing.`
          : "Wait for the current autosave to finish before issuing.",
      );
      return;
    }
    setSaveStatus("issuing");
    setSaveMessage("Freezing the reviewed version and requesting delivery…");
    try {
      finalizeKeyRef.current ??= requestKey("finalize");
      const finalized = await client.finalize({
        quoteId: receipt.quoteId,
        draftRevision: receipt.draftRevision,
        idempotencyKey: finalizeKeyRef.current,
      });
      issueKeyRef.current ??= requestKey("issue");
      const issued = await client.issue({
        quoteId: finalized.quoteId,
        versionId: finalized.versionId,
        quoteRevision: finalized.quoteRevision,
        draft,
        idempotencyKey: issueKeyRef.current,
      });
      setReceipt(finalized);
      setIssueReceipt(issued);
      setSaveStatus("issued");
      finalizeKeyRef.current = null;
      issueKeyRef.current = null;
      setSaveMessage(
        `Proposal delivery ${issued.overallState.replaceAll("_", " ")}.`,
      );
      window.localStorage.removeItem(recoveryKey);
    } catch (error) {
      const detail =
        error instanceof QuoteV2ClientError
          ? error.detail
          : {
              message: "The proposal could not be issued.",
              fieldErrors: {},
              correlationId: null,
            };
      setFieldErrors(detail.fieldErrors);
      setSaveStatus("issue_error");
      setSaveMessage(
        `${detail.message}${detail.correlationId ? ` Reference ${detail.correlationId}.` : ""}`,
      );
    }
  }

  function addLine() {
    setDraft((current) => ({
      ...current,
      lines: [
        ...current.lines,
        newQuoteV2LineDraft(`${recoveryId}-line-${current.lines.length + 1}`),
      ],
    }));
  }

  function updateLine(
    id: string,
    patch: Partial<QuoteV2ComposerDraft["lines"][number]>,
  ) {
    setDraft((current) => ({
      ...current,
      lines: current.lines.map((line) =>
        line.id === id ? { ...line, ...patch } : line,
      ),
    }));
  }

  function addOptionGroup() {
    const group: QuoteV2OptionGroupDraft = {
      id: `${recoveryId}-option-${draft.optionGroups.length + 1}`,
      label: "",
      mode: "single",
      minimumSelections: "1",
      maximumSelections: "1",
    };
    updateDraft("optionGroups", [...draft.optionGroups, group]);
  }

  function addAdjustment(kind: QuoteV2AdjustmentDraft["kind"] = "discount") {
    const adjustment: QuoteV2AdjustmentDraft = {
      id: `${recoveryId}-adjustment-${draft.adjustments.length + 1}`,
      kind,
      label:
        kind === "discount"
          ? "Approved discount"
          : kind === "travel"
            ? "Travel"
            : "Fee",
      calculation: "fixed",
      value: "",
    };
    updateDraft("adjustments", [...draft.adjustments, adjustment]);
  }

  function addServicePreset() {
    const preset = professionalQuoteServicePresets.find(
      (candidate) => candidate.id === servicePresetId,
    );
    if (!preset) return;
    const line = {
      ...newQuoteV2LineDraft(`${recoveryId}-line-${draft.lines.length + 1}`),
      catalogKey: preset.catalogKey,
      name: preset.name,
      description: preset.description,
      unit: preset.unit,
      unitPriceMin:
        preset.suggestedUnitPriceCents > 0
          ? (preset.suggestedUnitPriceCents / 100).toFixed(2)
          : "",
    };
    const first = draft.lines[0];
    const replaceBlankFirst =
      draft.lines.length === 1 &&
      first &&
      !first.name.trim() &&
      !first.unitPriceMin.trim();
    updateDraft("lines", replaceBlankFirst ? [line] : [...draft.lines, line]);
    setServicePresetId("");
  }

  function applyBundlePreset() {
    const preset = professionalQuoteBundlePresets.find(
      (candidate) => candidate.id === bundlePresetId,
    );
    if (!preset) return;
    const selectedCatalogKeys = new Set(
      draft.lines.map((line) => line.catalogKey).filter(Boolean),
    );
    if (
      !preset.requiredCatalogKeys.every((catalogKey) =>
        selectedCatalogKeys.has(catalogKey),
      )
    ) {
      setSaveStatus("error");
      setSaveMessage(
        `Add every service required by “${preset.name}” before approving its discount.`,
      );
      return;
    }
    const adjustment: QuoteV2AdjustmentDraft = {
      id: preset.adjustmentId,
      kind: "discount",
      label: `${preset.name} · staff approved`,
      calculation: "percentage",
      value: (preset.basisPoints / 100).toFixed(2).replace(/\.00$/u, ""),
    };
    updateDraft("adjustments", [
      ...draft.adjustments.filter((item) => item.id !== preset.adjustmentId),
      adjustment,
    ]);
    setBundlePresetId("");
  }

  function chooseServiceZone(zoneId: string) {
    const zone = professionalQuoteZonePresets.find(
      (candidate) => candidate.id === zoneId,
    );
    const withoutPriorTravel = draft.adjustments.filter(
      (item) => item.id !== "service-zone-travel",
    );
    updateDraft("serviceZoneId", zone?.id ?? "");
    updateDraft("serviceZoneConfirmed", false);
    updateDraft(
      "adjustments",
      zone && zone.travelFeeCents > 0
        ? [
            ...withoutPriorTravel,
            {
              id: "service-zone-travel",
              kind: "travel",
              label: `${zone.name} travel`,
              calculation: "fixed",
              value: (zone.travelFeeCents / 100).toFixed(2),
            },
          ]
        : withoutPriorTravel,
    );
  }

  function addViewRecipient() {
    updateDraft("additionalRecipients", [
      ...draft.additionalRecipients,
      {
        id: `${recoveryId}-viewer-${draft.additionalRecipients.length + 1}`,
        role: "cc",
        name: "",
        email: "",
        phoneE164: "",
        emailSelected: true,
        smsSelected: false,
      },
    ]);
  }

  function updateViewRecipient(
    id: string,
    patch: Partial<QuoteV2ComposerDraft["additionalRecipients"][number]>,
  ) {
    updateDraft(
      "additionalRecipients",
      draft.additionalRecipients.map((recipient) =>
        recipient.id === id ? { ...recipient, ...patch } : recipient,
      ),
    );
  }

  const statusTone =
    saveStatus === "error" || saveStatus === "issue_error"
      ? "danger"
      : saveStatus === "issued" || saveStatus === "saved"
        ? "success"
        : "info";

  if (issueReceipt && saveStatus === "issued") {
    return (
      <section className={`${TEAM_CARD_PADDED} text-center`} role="status">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--team-success-text)]">
          Proposal issued
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-[color:var(--team-text)]">
          {issueReceipt.quoteNumber ?? "Professional proposal"}
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm text-[color:var(--team-text-muted)]">
          The immutable version is complete and delivery is{" "}
          {issueReceipt.overallState.replaceAll("_", " ")}. Further content or
          recipient changes require a revision or a new send attempt.
        </p>
        {issueReceipt.correlationId ? (
          <p className="mt-2 text-xs text-[color:var(--team-text-soft)]">
            Reference {issueReceipt.correlationId}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link
            href="/team/quotes/manage"
            className={teamButtonClass("primary")}
          >
            Open quote management
          </Link>
          <Link
            href="/team/quotes/create"
            className={teamButtonClass("secondary")}
          >
            Create another quote
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section id="quote-v2-composer" className="space-y-4 scroll-mt-24">
      <div className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--team-link)]">
              Versioned proposal
            </p>
            <h2 className={TEAM_SECTION_TITLE}>Create professional quote</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              One guided workflow for residential and commercial proposals.
              Nothing is sent until the final review.
            </p>
          </div>
          <div
            className={teamStatePanelClass(statusTone)}
            role={saveStatus === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            <p className="font-semibold">
              {saveStatus === "local"
                ? "Local recovery"
                : saveStatus === "creating"
                  ? "Creating draft"
                  : saveStatus === "saving"
                    ? "Autosaving"
                    : saveStatus === "saved"
                      ? "Server draft saved"
                      : saveStatus === "issuing"
                        ? "Issuing proposal"
                        : saveStatus === "issue_error"
                          ? "Delivery needs attention"
                          : saveStatus === "issued"
                            ? "Proposal issued"
                            : "Action needed"}
            </p>
            <p className="mt-1 max-w-xl text-xs">{saveMessage}</p>
            {saveStatus === "error" && !receipt && stepOneComplete ? (
              <button
                type="button"
                className={`mt-2 ${teamButtonClass("secondary", "sm")}`}
                onClick={() => setRetryCreate((value) => value + 1)}
              >
                Retry draft creation
              </button>
            ) : null}
            {saveStatus === "error" && receipt ? (
              <button
                type="button"
                className={`mt-2 ${teamButtonClass("secondary", "sm")}`}
                onClick={() => {
                  savedFingerprintRef.current = null;
                  setSaveStatus("local");
                  setSaveMessage(
                    "Retrying the current draft with a new safe request key…",
                  );
                }}
              >
                Retry autosave
              </button>
            ) : null}
            {saveStatus === "issue_error" ? (
              <button
                type="button"
                className={`mt-2 ${teamButtonClass("secondary", "sm")}`}
                onClick={() => void issueProposal()}
              >
                Retry the same issue request
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {recovery ? (
        <section
          className={teamStatePanelClass("warning")}
          aria-labelledby="quote-recovery-title"
        >
          <h3 id="quote-recovery-title" className="font-semibold">
            Recover an unfinished proposal?
          </h3>
          <p className="mt-1">
            A local draft from {new Date(recovery.savedAt).toLocaleString()} is
            available. Review it before any server save.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={teamButtonClass("primary", "sm")}
              onClick={() => {
                setDraft(recovery.draft);
                setReceipt(recovery.receipt);
                createKeyRef.current = recovery.createRequestKey;
                savedFingerprintRef.current = null;
                setRecovery(null);
                setSaveStatus("local");
                setSaveMessage(
                  "Recovered locally. Review the client and project.",
                );
              }}
            >
              Recover draft
            </button>
            <button
              type="button"
              className={teamButtonClass("secondary", "sm")}
              onClick={() => {
                window.localStorage.removeItem(recoveryKey);
                setRecovery(null);
              }}
            >
              Start clean
            </button>
          </div>
        </section>
      ) : null}

      <nav className={`${TEAM_CARD} p-2`} aria-label="Quote creation steps">
        <ol className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {QUOTE_V2_COMPOSER_STEPS.map((item) => {
            const detail = STEP_DETAILS[item];
            const active = item === step;
            return (
              <li key={item}>
                <button
                  type="button"
                  onClick={() => selectStep(item)}
                  aria-current={active ? "step" : undefined}
                  className={`min-h-11 w-full rounded-2xl px-3 py-2 text-left text-sm transition ${TEAM_FOCUS_RING} ${
                    active
                      ? "bg-[color:var(--team-action-primary)] text-[color:var(--team-action-primary-text)]"
                      : "text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)]"
                  }`}
                >
                  <span
                    className={`block text-xs font-semibold ${active ? "" : "opacity-80"}`}
                  >
                    Step {detail.number}
                  </span>
                  <span className="block font-semibold sm:hidden">
                    {detail.shortLabel}
                  </span>
                  <span className="hidden font-semibold sm:block">
                    {detail.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className={TEAM_CARD_PADDED}>
          <header className="border-b border-[color:var(--team-border)] pb-4">
            <h3
              ref={stepHeadingRef}
              tabIndex={-1}
              className="text-lg font-semibold text-[color:var(--team-text)] focus:outline-none"
            >
              {STEP_DETAILS[step].label}
            </h3>
            <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
              {STEP_DETAILS[step].description}
            </p>
          </header>

          <div className="mt-5">
            {step === "client_project" ? (
              <div className="space-y-6">
                <fieldset>
                  <legend className="text-sm font-semibold text-[color:var(--team-text)]">
                    Proposal presentation
                  </legend>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {(["residential", "commercial"] as const).map(
                      (audience) => (
                        <label
                          key={audience}
                          className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-2xl border p-3 ${
                            draft.audience === audience
                              ? "border-[color:var(--team-focus-ring)] bg-[color:var(--team-surface-muted)]"
                              : "border-[color:var(--team-border)]"
                          }`}
                        >
                          <input
                            type="radio"
                            name="quote-audience"
                            value={audience}
                            checked={draft.audience === audience}
                            onChange={() =>
                              setDraft((current) =>
                                applyQuoteV2AudienceDefaults(current, audience),
                              )
                            }
                          />
                          <span>
                            <span className="block text-sm font-semibold capitalize">
                              {audience}
                            </span>
                            <span className="block text-xs text-[color:var(--team-text-soft)]">
                              {audience === "commercial"
                                ? "Company, attention, PO, and staff follow-up defaults"
                                : "Simple client language and self-scheduling defaults"}
                            </span>
                          </span>
                        </label>
                      ),
                    )}
                  </div>
                </fieldset>

                <section className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h4 className="font-semibold text-[color:var(--team-text)]">
                        Client and service property
                      </h4>
                      <p className="mt-1 text-xs text-[color:var(--team-text-soft)]">
                        Search remotely. No client or property is selected by
                        default.
                      </p>
                    </div>
                    {canQuickCreate ? (
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={() => setQuickCreateOpen((value) => !value)}
                        aria-expanded={quickCreateOpen}
                        aria-controls="quote-v2-quick-client"
                      >
                        {quickCreateOpen
                          ? "Close quick create"
                          : "Quick-create client"}
                      </button>
                    ) : null}
                  </div>

                  {canQuickCreate && quickCreateOpen ? (
                    <div
                      id="quote-v2-quick-client"
                      className="mt-4 space-y-3 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4"
                    >
                      <p className="text-sm font-semibold">
                        New client and property
                      </p>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {(
                          [
                            ["firstName", "First name"],
                            ["lastName", "Last name"],
                            ["email", "Email (optional)"],
                            ["phone", "Mobile (optional)"],
                            ["addressLine1", "Service street"],
                            ["city", "City"],
                            ["state", "State"],
                            ["postalCode", "Postal code"],
                          ] as const
                        ).map(([key, label]) => (
                          <label key={key} className="space-y-1 text-sm">
                            <span className="font-medium">{label}</span>
                            <input
                              value={quickCreate[key]}
                              onChange={(event) =>
                                setQuickCreate((current) => ({
                                  ...current,
                                  [key]: event.target.value,
                                }))
                              }
                              className={`${TEAM_INPUT_COMPACT} w-full`}
                              autoComplete="off"
                            />
                          </label>
                        ))}
                      </div>
                      <button
                        type="button"
                        className={teamButtonClass("primary", "sm")}
                        disabled={quickCreateSaving}
                        onClick={() => void createClientInline()}
                      >
                        {quickCreateSaving ? "Creating…" : "Create and select"}
                      </button>
                    </div>
                  ) : null}

                  <label
                    htmlFor="quote-client-search"
                    className="mt-4 block space-y-2 text-sm"
                  >
                    <span className="font-medium">Search clients</span>
                    <input
                      id="quote-client-search"
                      type="search"
                      value={contactQuery}
                      onChange={(event) => setContactQuery(event.target.value)}
                      placeholder="Name, company, email, phone, or address"
                      autoComplete="off"
                      className={`${TEAM_INPUT} w-full`}
                      aria-describedby="quote-client-search-status"
                    />
                  </label>
                  <div
                    id="quote-client-search-status"
                    className="mt-2 text-xs text-[color:var(--team-text-soft)]"
                    role={contactSearchState === "error" ? "alert" : "status"}
                    aria-live="polite"
                  >
                    {contactSearchMessage ??
                      (contactSearchState === "loading"
                        ? "Searching…"
                        : contactQuery.trim().length < 2
                          ? "Enter at least two characters."
                          : contactSearchState === "loaded" &&
                              contactResults.length === 0
                            ? "No matching clients."
                            : "")}
                  </div>
                  {contactResults.length > 0 ? (
                    <ul
                      className="mt-3 max-h-72 space-y-2 overflow-y-auto"
                      aria-label="Client search results"
                    >
                      {contactResults.map((contact) => (
                        <li key={contact.id}>
                          <button
                            type="button"
                            className={`min-h-11 w-full rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3 text-left ${TEAM_FOCUS_RING}`}
                            onClick={() => chooseContact(contact)}
                          >
                            <span className="block font-semibold text-[color:var(--team-text)]">
                              {quoteV2ContactResultLabel(contact)}
                            </span>
                            <span className="mt-1 block text-xs text-[color:var(--team-text-soft)]">
                              {[
                                contact.email,
                                contact.phoneE164,
                                contact.properties[0]?.label,
                              ]
                                .filter(Boolean)
                                .join(" · ") ||
                                "No delivery details or property"}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  <div className="mt-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                      Selected client
                    </p>
                    <p className="mt-1 font-semibold text-[color:var(--team-text)]">
                      {draft.contact
                        ? quoteV2ContactResultLabel(draft.contact)
                        : "No client selected"}
                    </p>
                    {draft.contact ? (
                      <button
                        type="button"
                        className={`mt-2 text-xs font-semibold text-[color:var(--team-link)] underline ${TEAM_FOCUS_RING}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            contact: null,
                            contactId: "",
                            propertyId: "",
                            serviceZoneId: "",
                            serviceZoneConfirmed: false,
                            adjustments: current.adjustments.filter(
                              (item) => item.id !== "service-zone-travel",
                            ),
                            attentionName: "",
                            attentionTitle: "",
                            billingAddress: "",
                            recipient: {
                              name: "",
                              email: "",
                              phoneE164: "",
                              emailSelected: true,
                              smsSelected: false,
                            },
                          }))
                        }
                      >
                        Clear client
                      </button>
                    ) : null}
                  </div>

                  <label
                    htmlFor="quote-property"
                    className="mt-4 block space-y-2 text-sm"
                  >
                    <span className="font-medium">Service property</span>
                    <select
                      id="quote-property"
                      value={draft.propertyId}
                      onChange={(event) => {
                        updateDraft("propertyId", event.target.value);
                        updateDraft("serviceZoneId", "");
                        updateDraft("serviceZoneConfirmed", false);
                        updateDraft(
                          "adjustments",
                          draft.adjustments.filter(
                            (item) => item.id !== "service-zone-travel",
                          ),
                        );
                      }}
                      disabled={!draft.contact}
                      className={`${TEAM_SELECT} w-full`}
                      aria-invalid={Boolean(fieldErrors["propertyId"])}
                      aria-describedby="quote-property-error"
                    >
                      <option value="">Choose a property</option>
                      {draft.contact?.properties.map((property) => (
                        <option key={property.id} value={property.id}>
                          {property.label}
                        </option>
                      ))}
                    </select>
                    <FieldError
                      id="quote-property-error"
                      message={fieldErrors["propertyId"]}
                    />
                  </label>
                </section>

                <fieldset className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <legend className="px-2 text-sm font-semibold">
                    Service zone and travel
                  </legend>
                  <p className="text-xs text-[color:var(--team-text-soft)]">
                    This property cannot be mapped automatically from the
                    current postal policy. Choose the correct zone and confirm
                    it; any configured travel charge is added visibly.
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Service zone</span>
                      <select
                        className={`${TEAM_SELECT} w-full`}
                        value={draft.serviceZoneId}
                        onChange={(event) =>
                          chooseServiceZone(event.target.value)
                        }
                        aria-invalid={Boolean(fieldErrors["serviceZoneId"])}
                      >
                        <option value="">Choose a zone</option>
                        {professionalQuoteZonePresets.map((zone) => (
                          <option key={zone.id} value={zone.id}>
                            {zone.name}
                            {zone.travelFeeCents > 0
                              ? ` · ${formatQuoteV2Money(zone.travelFeeCents)} travel`
                              : " · no travel charge"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex min-h-11 items-center gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        checked={draft.serviceZoneConfirmed}
                        disabled={!selectedZone}
                        onChange={(event) =>
                          updateDraft(
                            "serviceZoneConfirmed",
                            event.target.checked,
                          )
                        }
                      />
                      <span>
                        I confirmed this zone against the service-area policy
                        {selectedZone
                          ? ` (${selectedZone.name}${selectedZone.travelFeeCents > 0 ? `, ${formatQuoteV2Money(selectedZone.travelFeeCents)} travel` : ""})`
                          : ""}
                      </span>
                    </label>
                  </div>
                </fieldset>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label
                    htmlFor="quote-project-name"
                    className="space-y-2 text-sm sm:col-span-2"
                  >
                    <span className="font-medium">Project name</span>
                    <input
                      id="quote-project-name"
                      value={draft.projectName}
                      onChange={(event) =>
                        updateDraft("projectName", event.target.value)
                      }
                      maxLength={240}
                      placeholder="Example: North warehouse cleanout"
                      className={`${TEAM_INPUT} w-full`}
                      aria-invalid={Boolean(fieldErrors["projectName"])}
                    />
                  </label>
                  <label
                    htmlFor="quote-project-reference"
                    className="space-y-2 text-sm"
                  >
                    <span className="font-medium">
                      Project reference (optional)
                    </span>
                    <input
                      id="quote-project-reference"
                      value={draft.projectReference}
                      onChange={(event) =>
                        updateDraft("projectReference", event.target.value)
                      }
                      maxLength={160}
                      className={`${TEAM_INPUT} w-full`}
                    />
                  </label>
                  <label htmlFor="quote-po" className="space-y-2 text-sm">
                    <span className="font-medium">PO number (optional)</span>
                    <input
                      id="quote-po"
                      value={draft.purchaseOrder}
                      onChange={(event) =>
                        updateDraft("purchaseOrder", event.target.value)
                      }
                      maxLength={160}
                      className={`${TEAM_INPUT} w-full`}
                    />
                  </label>
                  {draft.audience === "commercial" ? (
                    <>
                      <label
                        htmlFor="quote-attention"
                        className="space-y-2 text-sm"
                      >
                        <span className="font-medium">Attention contact</span>
                        <input
                          id="quote-attention"
                          value={draft.attentionName}
                          onChange={(event) =>
                            updateDraft("attentionName", event.target.value)
                          }
                          className={`${TEAM_INPUT} w-full`}
                        />
                      </label>
                      <label
                        htmlFor="quote-attention-title"
                        className="space-y-2 text-sm"
                      >
                        <span className="font-medium">Attention title</span>
                        <input
                          id="quote-attention-title"
                          value={draft.attentionTitle}
                          onChange={(event) =>
                            updateDraft("attentionTitle", event.target.value)
                          }
                          className={`${TEAM_INPUT} w-full`}
                        />
                      </label>
                      <label
                        htmlFor="quote-billing-address"
                        className="space-y-2 text-sm sm:col-span-2"
                      >
                        <span className="font-medium">
                          Billing address (optional)
                        </span>
                        <textarea
                          id="quote-billing-address"
                          value={draft.billingAddress}
                          onChange={(event) =>
                            updateDraft("billingAddress", event.target.value)
                          }
                          rows={2}
                          className={`${TEAM_INPUT} w-full`}
                        />
                      </label>
                    </>
                  ) : null}
                </div>
              </div>
            ) : null}

            {step === "items_scope" ? (
              <div className="space-y-6">
                <section>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="font-semibold">Line items</h4>
                      <p className="text-xs text-[color:var(--team-text-soft)]">
                        USD amounts support quantities with up to three
                        decimals.
                      </p>
                    </div>
                    <button
                      type="button"
                      className={teamButtonClass("secondary", "sm")}
                      onClick={addLine}
                    >
                      Add line item
                    </button>
                  </div>
                  <div className="mt-3 flex flex-col gap-2 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-3 sm:flex-row sm:items-end">
                    <label className="min-w-0 flex-1 space-y-1 text-sm">
                      <span className="font-medium">
                        Reusable service preset
                      </span>
                      <select
                        className={`${TEAM_SELECT} w-full`}
                        value={servicePresetId}
                        onChange={(event) =>
                          setServicePresetId(event.target.value)
                        }
                      >
                        <option value="">Choose a catalog service</option>
                        {professionalQuoteServicePresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className={teamButtonClass("secondary", "sm")}
                      onClick={addServicePreset}
                      disabled={!servicePresetId}
                    >
                      Add preset
                    </button>
                  </div>
                  <div className="mt-3 flex flex-col gap-2 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-3 sm:flex-row sm:items-end">
                    <label className="min-w-0 flex-1 space-y-1 text-sm">
                      <span className="font-medium">
                        Approved bundle preset
                      </span>
                      <select
                        className={`${TEAM_SELECT} w-full`}
                        value={bundlePresetId}
                        onChange={(event) =>
                          setBundlePresetId(event.target.value)
                        }
                      >
                        <option value="">Choose an eligible bundle</option>
                        {professionalQuoteBundlePresets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {preset.name} · {preset.basisPoints / 100}%
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      className={teamButtonClass("secondary", "sm")}
                      onClick={applyBundlePreset}
                      disabled={!bundlePresetId}
                    >
                      Apply visible discount
                    </button>
                  </div>
                  <div className="mt-3 space-y-3">
                    {draft.lines.map((line, index) => (
                      <fieldset
                        key={line.id}
                        className="rounded-2xl border border-[color:var(--team-border)] p-4"
                      >
                        <legend className="px-2 text-sm font-semibold">
                          Item {index + 1}
                        </legend>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          <label className="space-y-1 text-sm sm:col-span-2">
                            <span className="font-medium">Name</span>
                            <input
                              value={line.name}
                              onChange={(event) =>
                                updateLine(line.id, {
                                  name: event.target.value,
                                })
                              }
                              className={`${TEAM_INPUT_COMPACT} w-full`}
                              aria-invalid={Boolean(
                                optimisticTotals.errors[`lines.${index}.name`],
                              )}
                            />
                          </label>
                          <label className="space-y-1 text-sm">
                            <span className="font-medium">Quantity</span>
                            <input
                              value={line.quantity}
                              onChange={(event) =>
                                updateLine(line.id, {
                                  quantity: event.target.value,
                                })
                              }
                              inputMode="decimal"
                              className={`${TEAM_INPUT_COMPACT} w-full`}
                              aria-invalid={Boolean(
                                optimisticTotals.errors[
                                  `lines.${index}.quantity`
                                ],
                              )}
                            />
                          </label>
                          <label className="space-y-1 text-sm">
                            <span className="font-medium">Unit</span>
                            <input
                              value={line.unit}
                              onChange={(event) =>
                                updateLine(line.id, {
                                  unit: event.target.value,
                                })
                              }
                              maxLength={40}
                              className={`${TEAM_INPUT_COMPACT} w-full`}
                            />
                          </label>
                          <label className="space-y-1 text-sm">
                            <span className="font-medium">Unit price</span>
                            <input
                              value={line.unitPriceMin}
                              onChange={(event) =>
                                updateLine(line.id, {
                                  unitPriceMin: event.target.value,
                                })
                              }
                              inputMode="decimal"
                              placeholder="$0.00"
                              className={`${TEAM_INPUT_COMPACT} w-full`}
                              aria-invalid={Boolean(
                                optimisticTotals.errors[
                                  `lines.${index}.unitPriceMin`
                                ],
                              )}
                            />
                          </label>
                          <label className="space-y-1 text-sm">
                            <span className="font-medium">High unit price</span>
                            <input
                              value={line.unitPriceMax}
                              onChange={(event) =>
                                updateLine(line.id, {
                                  unitPriceMax: event.target.value,
                                })
                              }
                              inputMode="decimal"
                              disabled={draft.documentType !== "range"}
                              placeholder={
                                draft.documentType === "range"
                                  ? "$0.00"
                                  : "Firm price"
                              }
                              className={`${TEAM_INPUT_COMPACT} w-full`}
                            />
                          </label>
                          <label className="space-y-1 text-sm sm:col-span-2">
                            <span className="font-medium">
                              Customer option group
                            </span>
                            <select
                              value={line.optionGroupId}
                              onChange={(event) =>
                                updateLine(line.id, {
                                  optionGroupId: event.target.value,
                                })
                              }
                              className={`${TEAM_SELECT} w-full`}
                            >
                              <option value="">Included base item</option>
                              {draft.optionGroups.map((group) => (
                                <option key={group.id} value={group.id}>
                                  {group.label || "Unnamed option group"}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="space-y-1 text-sm sm:col-span-2 lg:col-span-4">
                            <span className="font-medium">
                              Description (optional)
                            </span>
                            <textarea
                              value={line.description}
                              onChange={(event) =>
                                updateLine(line.id, {
                                  description: event.target.value,
                                })
                              }
                              rows={2}
                              className={`${TEAM_INPUT_COMPACT} w-full`}
                            />
                          </label>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                          {line.optionGroupId ? (
                            <label className="inline-flex min-h-11 items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={line.selectedByDefault}
                                onChange={(event) =>
                                  updateLine(line.id, {
                                    selectedByDefault: event.target.checked,
                                  })
                                }
                              />
                              Selected by default
                            </label>
                          ) : (
                            <span />
                          )}
                          <button
                            type="button"
                            className={teamButtonClass("danger", "sm")}
                            aria-label={`Remove line item ${index + 1}${line.name ? `: ${line.name}` : ""}`}
                            disabled={draft.lines.length === 1}
                            onClick={() =>
                              updateDraft(
                                "lines",
                                draft.lines.filter(
                                  (item) => item.id !== line.id,
                                ),
                              )
                            }
                          >
                            Remove item
                          </button>
                        </div>
                      </fieldset>
                    ))}
                  </div>
                  {!optimisticTotals.valid ? (
                    <div
                      className={`mt-3 ${teamStatePanelClass("danger")}`}
                      role="status"
                      aria-live="polite"
                    >
                      <p className="font-semibold">Pricing needs attention</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {[...new Set(Object.values(optimisticTotals.errors))]
                          .slice(0, 6)
                          .map((message) => (
                            <li key={message}>{message}</li>
                          ))}
                      </ul>
                    </div>
                  ) : null}
                </section>

                <section className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="font-semibold">
                        Customer-selectable options
                      </h4>
                      <p className="text-xs text-[color:var(--team-text-soft)]">
                        Create choose-one or choose-any groups, then assign line
                        items.
                      </p>
                    </div>
                    <button
                      type="button"
                      className={teamButtonClass("secondary", "sm")}
                      onClick={addOptionGroup}
                    >
                      Add option group
                    </button>
                  </div>
                  {draft.optionGroups.length === 0 ? (
                    <p className="mt-3 text-sm text-[color:var(--team-text-soft)]">
                      No customer choices. Every base item is included.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {draft.optionGroups.map((group, index) => (
                        <div
                          key={group.id}
                          className="grid gap-3 rounded-xl bg-[color:var(--team-surface-muted)] p-3 sm:grid-cols-4"
                        >
                          <label className="space-y-1 text-sm sm:col-span-2">
                            <span className="font-medium">Group label</span>
                            <input
                              value={group.label}
                              onChange={(event) =>
                                updateDraft(
                                  "optionGroups",
                                  draft.optionGroups.map((item) =>
                                    item.id === group.id
                                      ? { ...item, label: event.target.value }
                                      : item,
                                  ),
                                )
                              }
                              className={`${TEAM_INPUT_COMPACT} w-full`}
                            />
                          </label>
                          <label className="space-y-1 text-sm">
                            <span className="font-medium">Choice rule</span>
                            <select
                              value={group.mode}
                              onChange={(event) =>
                                updateDraft(
                                  "optionGroups",
                                  draft.optionGroups.map((item) =>
                                    item.id === group.id
                                      ? {
                                          ...item,
                                          mode: event.target.value as
                                            | "single"
                                            | "multiple",
                                          maximumSelections:
                                            event.target.value === "single"
                                              ? "1"
                                              : item.maximumSelections,
                                        }
                                      : item,
                                  ),
                                )
                              }
                              className={`${TEAM_SELECT} w-full`}
                            >
                              <option value="single">Choose one</option>
                              <option value="multiple">Choose any</option>
                            </select>
                          </label>
                          {group.mode === "multiple" ? (
                            <div className="grid grid-cols-2 gap-2 sm:col-span-2">
                              <label className="space-y-1 text-sm">
                                <span className="font-medium">Minimum</span>
                                <input
                                  type="number"
                                  min="0"
                                  max="100"
                                  value={group.minimumSelections}
                                  onChange={(event) =>
                                    updateDraft(
                                      "optionGroups",
                                      draft.optionGroups.map((item) =>
                                        item.id === group.id
                                          ? {
                                              ...item,
                                              minimumSelections:
                                                event.target.value,
                                            }
                                          : item,
                                      ),
                                    )
                                  }
                                  className={`${TEAM_INPUT_COMPACT} w-full`}
                                />
                              </label>
                              <label className="space-y-1 text-sm">
                                <span className="font-medium">Maximum</span>
                                <input
                                  type="number"
                                  min="1"
                                  max="100"
                                  value={group.maximumSelections}
                                  onChange={(event) =>
                                    updateDraft(
                                      "optionGroups",
                                      draft.optionGroups.map((item) =>
                                        item.id === group.id
                                          ? {
                                              ...item,
                                              maximumSelections:
                                                event.target.value,
                                            }
                                          : item,
                                      ),
                                    )
                                  }
                                  className={`${TEAM_INPUT_COMPACT} w-full`}
                                />
                              </label>
                            </div>
                          ) : null}
                          <button
                            type="button"
                            className={teamButtonClass("danger", "sm")}
                            aria-label={`Remove option group ${index + 1}${group.label ? `: ${group.label}` : ""}`}
                            onClick={() => {
                              updateDraft(
                                "optionGroups",
                                draft.optionGroups.filter(
                                  (item) => item.id !== group.id,
                                ),
                              );
                              updateDraft(
                                "lines",
                                draft.lines.map((line) =>
                                  line.optionGroupId === group.id
                                    ? {
                                        ...line,
                                        optionGroupId: "",
                                        selectedByDefault: false,
                                      }
                                    : line,
                                ),
                              );
                            }}
                          >
                            Remove group {index + 1}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="font-semibold">Discounts and charges</h4>
                      <p className="text-xs text-[color:var(--team-text-soft)]">
                        All adjustments remain visible to staff and customers.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={() => addAdjustment("discount")}
                      >
                        Add discount
                      </button>
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={() => addAdjustment("fee")}
                      >
                        Add fee
                      </button>
                      <button
                        type="button"
                        className={teamButtonClass("secondary", "sm")}
                        onClick={() => addAdjustment("travel")}
                      >
                        Add travel
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 space-y-3">
                    {draft.adjustments.map((adjustment) => (
                      <div
                        key={adjustment.id}
                        className="grid gap-3 rounded-xl bg-[color:var(--team-surface-muted)] p-3 sm:grid-cols-4"
                      >
                        <label className="space-y-1 text-sm">
                          <span className="font-medium">Type</span>
                          <select
                            value={adjustment.kind}
                            onChange={(event) =>
                              updateDraft(
                                "adjustments",
                                draft.adjustments.map((item) =>
                                  item.id === adjustment.id
                                    ? {
                                        ...item,
                                        kind: event.target
                                          .value as QuoteV2AdjustmentDraft["kind"],
                                      }
                                    : item,
                                ),
                              )
                            }
                            className={`${TEAM_SELECT} w-full`}
                          >
                            <option value="discount">Discount</option>
                            <option value="fee">Fee</option>
                            <option value="travel">Travel</option>
                          </select>
                        </label>
                        <label className="space-y-1 text-sm">
                          <span className="font-medium">Label</span>
                          <input
                            value={adjustment.label}
                            onChange={(event) =>
                              updateDraft(
                                "adjustments",
                                draft.adjustments.map((item) =>
                                  item.id === adjustment.id
                                    ? { ...item, label: event.target.value }
                                    : item,
                                ),
                              )
                            }
                            className={`${TEAM_INPUT_COMPACT} w-full`}
                          />
                        </label>
                        <label className="space-y-1 text-sm">
                          <span className="font-medium">Calculation</span>
                          <select
                            value={adjustment.calculation}
                            onChange={(event) =>
                              updateDraft(
                                "adjustments",
                                draft.adjustments.map((item) =>
                                  item.id === adjustment.id
                                    ? {
                                        ...item,
                                        calculation: event.target.value as
                                          | "fixed"
                                          | "percentage",
                                        value: "",
                                      }
                                    : item,
                                ),
                              )
                            }
                            className={`${TEAM_SELECT} w-full`}
                          >
                            <option value="fixed">Fixed USD</option>
                            <option value="percentage">Percentage</option>
                          </select>
                        </label>
                        <label className="space-y-1 text-sm">
                          <span className="font-medium">
                            {adjustment.calculation === "fixed"
                              ? "Amount"
                              : "Percent"}
                          </span>
                          <input
                            value={adjustment.value}
                            onChange={(event) =>
                              updateDraft(
                                "adjustments",
                                draft.adjustments.map((item) =>
                                  item.id === adjustment.id
                                    ? { ...item, value: event.target.value }
                                    : item,
                                ),
                              )
                            }
                            inputMode="decimal"
                            className={`${TEAM_INPUT_COMPACT} w-full`}
                          />
                        </label>
                        <button
                          type="button"
                          className={teamButtonClass("danger", "sm")}
                          aria-label={`Remove ${adjustment.label || adjustment.kind}`}
                          onClick={() =>
                            updateDraft(
                              "adjustments",
                              draft.adjustments.filter(
                                (item) => item.id !== adjustment.id,
                              ),
                            )
                          }
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </section>

                <label htmlFor="quote-scope" className="space-y-2 text-sm">
                  <span className="block font-medium">
                    Customer-facing scope
                  </span>
                  <textarea
                    id="quote-scope"
                    value={draft.scope}
                    onChange={(event) =>
                      updateDraft("scope", event.target.value)
                    }
                    rows={6}
                    maxLength={12_000}
                    className={`${TEAM_INPUT} w-full resize-y`}
                    aria-invalid={Boolean(fieldErrors["scope"])}
                    aria-describedby="quote-scope-hint quote-scope-error"
                    placeholder="Describe exactly what Stonegate will complete."
                  />
                  <span
                    id="quote-scope-hint"
                    className="block text-xs text-[color:var(--team-text-soft)]"
                  >
                    This appears in web, email, and PDF proposal views.
                  </span>
                  <FieldError
                    id="quote-scope-error"
                    message={fieldErrors["scope"]}
                  />
                </label>
                <div className="grid gap-4 lg:grid-cols-3">
                  <TextListField
                    id="quote-inclusions"
                    label="Inclusions"
                    value={draft.inclusions}
                    onChange={(value) => updateDraft("inclusions", value)}
                    hint="One customer-visible item per line."
                  />
                  <TextListField
                    id="quote-exclusions"
                    label="Exclusions"
                    value={draft.exclusions}
                    onChange={(value) => updateDraft("exclusions", value)}
                    hint="One customer-visible item per line."
                  />
                  <TextListField
                    id="quote-assumptions"
                    label="Assumptions"
                    value={draft.assumptions}
                    onChange={(value) => updateDraft("assumptions", value)}
                    hint="One customer-visible item per line."
                  />
                </div>

                <section className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <div>
                    <h4 className="font-semibold">Proposal attachments</h4>
                    <p className="text-xs text-[color:var(--team-text-soft)]">
                      Add up to 10 verified JPEG, PNG, WebP, HEIC, or PDF files,
                      10 MB each. Customer files are frozen into this version;
                      internal files never enter customer render data.
                    </p>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Visibility</span>
                      <select
                        value={
                          attachmentCustomerVisible ? "customer" : "internal"
                        }
                        onChange={(event) => {
                          const customer = event.target.value === "customer";
                          setAttachmentCustomerVisible(customer);
                          setAttachmentPurpose(
                            customer ? "scope_evidence" : "internal",
                          );
                        }}
                        className={`${TEAM_SELECT} w-full`}
                      >
                        <option value="customer">Customer-visible</option>
                        <option value="internal">Internal-only</option>
                      </select>
                    </label>
                    {attachmentCustomerVisible ? (
                      <label className="space-y-1 text-sm">
                        <span className="font-medium">Purpose</span>
                        <select
                          value={attachmentPurpose}
                          onChange={(event) =>
                            setAttachmentPurpose(
                              event.target
                                .value as QuoteV2AttachmentItem["purpose"],
                            )
                          }
                          className={`${TEAM_SELECT} w-full`}
                        >
                          <option value="scope_evidence">Scope evidence</option>
                          <option value="site_plan">Site plan</option>
                          <option value="specification">Specification</option>
                          <option value="terms">Supplemental terms</option>
                          <option value="other">Other</option>
                        </select>
                      </label>
                    ) : (
                      <div className="rounded-xl bg-[color:var(--team-warning-surface)] p-3 text-xs text-[color:var(--team-warning-text)]">
                        Internal-only files are structurally filtered from web,
                        email, PDF, delivery, and customer access.
                      </div>
                    )}
                    <label className="space-y-1 text-sm sm:col-span-2">
                      <span className="font-medium">
                        Customer caption (optional)
                      </span>
                      <input
                        value={attachmentLabel}
                        onChange={(event) =>
                          setAttachmentLabel(event.target.value.slice(0, 240))
                        }
                        disabled={!attachmentCustomerVisible}
                        className={`${TEAM_INPUT_COMPACT} w-full`}
                        placeholder="Example: Site access diagram"
                      />
                    </label>
                    <label className="space-y-1 text-sm sm:col-span-2">
                      <span className="font-medium">Choose file</span>
                      <input
                        ref={attachmentInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                        disabled={
                          !receipt ||
                          !draftIsServerSaved ||
                          saveStatus !== "saved" ||
                          attachmentStatus === "uploading" ||
                          attachments.length >= 10
                        }
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadAttachment(file);
                        }}
                        className={`${TEAM_INPUT} w-full file:mr-3 file:rounded-lg file:border-0 file:bg-[color:var(--team-surface-muted)] file:px-3 file:py-2 file:font-semibold`}
                        aria-describedby="quote-attachment-status"
                      />
                    </label>
                  </div>
                  <p
                    id="quote-attachment-status"
                    className={`mt-2 text-xs ${
                      attachmentStatus === "error"
                        ? "text-[color:var(--team-danger-text)]"
                        : "text-[color:var(--team-text-soft)]"
                    }`}
                    role="status"
                    aria-live="polite"
                  >
                    {attachmentMessage ??
                      (!receipt || !draftIsServerSaved
                        ? "Complete this step and wait for the saved status before uploading."
                        : `${attachments.length} of 10 attachments added.`)}
                  </p>
                  {attachments.length > 0 ? (
                    <ul className="mt-3 grid gap-2">
                      {attachments.map((attachment) => (
                        <li
                          key={attachment.attachmentId}
                          className="flex min-h-11 items-center justify-between gap-3 rounded-xl bg-[color:var(--team-surface-muted)] px-3 py-2 text-sm"
                        >
                          <span className="min-w-0 break-words">
                            <span className="font-medium">
                              {attachment.label ?? attachment.fileName}
                            </span>
                            <span className="block text-xs text-[color:var(--team-text-soft)]">
                              {attachment.customerVisible
                                ? "Customer-visible"
                                : "Internal-only"}{" "}
                              · {(attachment.byteSize / 1024 / 1024).toFixed(1)}{" "}
                              MB
                            </span>
                          </span>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-xs font-semibold text-[color:var(--team-success-text)]">
                              Verified
                            </span>
                            <button
                              type="button"
                              className={teamButtonClass("danger", "sm")}
                              disabled={removingAttachmentId !== null}
                              onClick={() => void removeAttachment(attachment)}
                              aria-label={`Remove ${attachment.fileName}`}
                            >
                              {removingAttachmentId === attachment.attachmentId
                                ? "Removing…"
                                : "Remove"}
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>

                <section className="rounded-2xl border-2 border-dashed border-[color:var(--team-warning-border)] bg-[color:var(--team-warning-surface)] p-4 text-[color:var(--team-warning-text)]">
                  <label
                    htmlFor="quote-internal-notes"
                    className="space-y-2 text-sm"
                  >
                    <span className="block font-semibold">
                      Internal notes — never customer visible
                    </span>
                    <textarea
                      id="quote-internal-notes"
                      value={draft.internalNotes}
                      onChange={(event) =>
                        updateDraft("internalNotes", event.target.value)
                      }
                      rows={4}
                      maxLength={8_000}
                      className={`${TEAM_INPUT} w-full resize-y`}
                      placeholder="Operational context for staff only"
                    />
                    <span className="block text-xs">
                      Structurally excluded from proposal render data,
                      documents, delivery, and AI prompts.
                    </span>
                  </label>
                </section>
              </div>
            ) : null}

            {step === "terms_fulfillment" ? (
              <div className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label
                    htmlFor="quote-document-type"
                    className="space-y-2 text-sm"
                  >
                    <span className="font-medium">Proposal type</span>
                    <select
                      id="quote-document-type"
                      value={draft.documentType}
                      onChange={(event) => {
                        const documentType = event.target
                          .value as QuoteV2ComposerDraft["documentType"];
                        setDraft((current) => ({
                          ...current,
                          documentType,
                          lines:
                            documentType === "range"
                              ? current.lines
                              : current.lines.map((line) => ({
                                  ...line,
                                  unitPriceMax: "",
                                })),
                          deposit:
                            documentType === "range" &&
                            current.deposit.mode === "percentage"
                              ? { mode: "none", value: "" }
                              : current.deposit,
                        }));
                      }}
                      className={`${TEAM_SELECT} w-full`}
                    >
                      <option value="fixed_quote">
                        Fixed quote · firm scoped total
                      </option>
                      <option value="estimate">
                        Estimate · non-binding estimated total
                      </option>
                      <option value="range">
                        Range · non-binding low to high
                      </option>
                    </select>
                  </label>
                  <label
                    htmlFor="quote-scheduling-mode"
                    className="space-y-2 text-sm"
                  >
                    <span className="font-medium">After approval</span>
                    <select
                      id="quote-scheduling-mode"
                      value={draft.schedulingMode}
                      onChange={(event) =>
                        updateDraft(
                          "schedulingMode",
                          event.target
                            .value as QuoteV2ComposerDraft["schedulingMode"],
                        )
                      }
                      className={`${TEAM_SELECT} w-full`}
                    >
                      <option value="self_schedule">
                        Client may self-schedule
                      </option>
                      <option value="staff_followup">
                        Staff follows up to schedule
                      </option>
                      <option value="approval_only">Approval only</option>
                    </select>
                  </label>
                  <label htmlFor="quote-validity" className="space-y-2 text-sm">
                    <span className="font-medium">Valid for (days)</span>
                    <input
                      id="quote-validity"
                      type="number"
                      min="1"
                      max="120"
                      value={draft.validityDays}
                      onChange={(event) =>
                        updateDraft("validityDays", event.target.value)
                      }
                      className={`${TEAM_INPUT} w-full`}
                    />
                  </label>
                  <label htmlFor="quote-duration" className="space-y-2 text-sm">
                    <span className="font-medium">
                      Estimated duration (minutes)
                    </span>
                    <input
                      id="quote-duration"
                      type="number"
                      min="15"
                      max="43200"
                      step="15"
                      value={draft.durationMinutes}
                      onChange={(event) =>
                        updateDraft("durationMinutes", event.target.value)
                      }
                      className={`${TEAM_INPUT} w-full`}
                    />
                  </label>
                </div>

                <fieldset className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <legend className="px-2 text-sm font-semibold">
                    Deposit
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-2 text-sm">
                      <span className="font-medium">Deposit mode</span>
                      <select
                        value={draft.deposit.mode}
                        onChange={(event) =>
                          updateDraft("deposit", {
                            mode: event.target
                              .value as QuoteV2ComposerDraft["deposit"]["mode"],
                            value: "",
                          })
                        }
                        className={`${TEAM_SELECT} w-full`}
                      >
                        <option value="none">No deposit</option>
                        <option value="fixed">Fixed USD deposit</option>
                        {draft.documentType !== "range" ? (
                          <option value="percentage">Percentage deposit</option>
                        ) : null}
                      </select>
                    </label>
                    {draft.deposit.mode !== "none" ? (
                      <label className="space-y-2 text-sm">
                        <span className="font-medium">
                          {draft.deposit.mode === "fixed"
                            ? "Deposit amount"
                            : "Deposit percent"}
                        </span>
                        <input
                          value={draft.deposit.value}
                          onChange={(event) =>
                            updateDraft("deposit", {
                              ...draft.deposit,
                              value: event.target.value,
                            })
                          }
                          inputMode="decimal"
                          className={`${TEAM_INPUT} w-full`}
                          aria-invalid={Boolean(
                            optimisticTotals.errors["deposit"],
                          )}
                          aria-describedby="quote-deposit-error"
                        />
                        <FieldError
                          id="quote-deposit-error"
                          message={optimisticTotals.errors["deposit"]}
                        />
                      </label>
                    ) : null}
                  </div>
                </fieldset>

                <label
                  htmlFor="quote-payment-terms"
                  className="space-y-2 text-sm"
                >
                  <span className="font-medium">Payment terms</span>
                  <textarea
                    id="quote-payment-terms"
                    value={draft.paymentTerms}
                    onChange={(event) =>
                      updateDraft("paymentTerms", event.target.value)
                    }
                    rows={3}
                    className={`${TEAM_INPUT} w-full`}
                  />
                </label>
                <label
                  htmlFor="quote-change-orders"
                  className="space-y-2 text-sm"
                >
                  <span className="font-medium">Change-order rules</span>
                  <textarea
                    id="quote-change-orders"
                    value={draft.changeOrderRules}
                    onChange={(event) =>
                      updateDraft("changeOrderRules", event.target.value)
                    }
                    rows={3}
                    className={`${TEAM_INPUT} w-full`}
                  />
                </label>
                <label htmlFor="quote-terms" className="space-y-2 text-sm">
                  <span className="font-medium">Proposal terms</span>
                  <textarea
                    id="quote-terms"
                    value={draft.terms}
                    onChange={(event) =>
                      updateDraft("terms", event.target.value)
                    }
                    rows={6}
                    className={`${TEAM_INPUT} w-full`}
                    aria-invalid={Boolean(fieldErrors["terms"])}
                  />
                </label>
              </div>
            ) : null}

            {step === "review_send" ? (
              <div className="space-y-6">
                <section className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <h4 className="font-semibold">Proposal facts</h4>
                  <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-[color:var(--team-text-soft)]">
                        Client
                      </dt>
                      <dd className="font-semibold">
                        {draft.contact?.companyName ??
                          draft.contact?.name ??
                          "Not selected"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[color:var(--team-text-soft)]">
                        Project
                      </dt>
                      <dd className="font-semibold">
                        {draft.projectName || "Not added"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[color:var(--team-text-soft)]">
                        Service site
                      </dt>
                      <dd>{selectedProperty?.label ?? "Not selected"}</dd>
                    </div>
                    <div>
                      <dt className="text-[color:var(--team-text-soft)]">
                        Prepared by
                      </dt>
                      <dd>{preparerName}</dd>
                    </div>
                    <div>
                      <dt className="text-[color:var(--team-text-soft)]">
                        Issued by
                      </dt>
                      <dd>{issuer.displayName}</dd>
                    </div>
                    <div>
                      <dt className="text-[color:var(--team-text-soft)]">
                        Type
                      </dt>
                      <dd className="capitalize">
                        {draft.documentType.replaceAll("_", " ")}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[color:var(--team-text-soft)]">
                        Valid
                      </dt>
                      <dd>{draft.validityDays || "—"} days from issue</dd>
                    </div>
                    <div>
                      <dt className="text-[color:var(--team-text-soft)]">
                        Total
                      </dt>
                      <dd className="font-semibold">
                        {quoteRangeLabel(
                          displayedTotals.totalMinCents,
                          displayedTotals.totalMaxCents,
                          draft.documentType,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[color:var(--team-text-soft)]">
                        Deposit
                      </dt>
                      <dd>
                        {formatQuoteV2Money(displayedTotals.depositCents)}
                      </dd>
                    </div>
                  </dl>
                </section>

                <details className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <summary
                    className={`min-h-11 cursor-pointer py-3 font-semibold ${TEAM_FOCUS_RING}`}
                  >
                    Exact customer terms and fulfillment details
                  </summary>
                  <dl className="mt-3 space-y-4 text-sm">
                    <div>
                      <dt className="font-semibold">Payment terms</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-[color:var(--team-text-muted)]">
                        {draft.paymentTerms}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold">Change-order rules</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-[color:var(--team-text-muted)]">
                        {draft.changeOrderRules}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold">Proposal terms</dt>
                      <dd className="mt-1 whitespace-pre-wrap text-[color:var(--team-text-muted)]">
                        {draft.terms}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-semibold">Scheduling</dt>
                      <dd className="mt-1 capitalize text-[color:var(--team-text-muted)]">
                        {draft.schedulingMode.replaceAll("_", " ")}
                      </dd>
                    </div>
                  </dl>
                </details>

                <fieldset className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <legend className="px-2 text-sm font-semibold">
                    Designated signer
                  </legend>
                  <p className="text-xs text-[color:var(--team-text-soft)]">
                    Exactly one person receives approval capability. Everyone
                    else receives a separate view/PDF-only link.
                  </p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Signer name</span>
                      <input
                        value={draft.recipient.name}
                        onChange={(event) =>
                          updateDraft("recipient", {
                            ...draft.recipient,
                            name: event.target.value,
                          })
                        }
                        className={`${TEAM_INPUT} w-full`}
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Email</span>
                      <input
                        type="email"
                        value={draft.recipient.email}
                        onChange={(event) =>
                          updateDraft("recipient", {
                            ...draft.recipient,
                            email: event.target.value,
                          })
                        }
                        className={`${TEAM_INPUT} w-full`}
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span className="font-medium">Mobile (E.164)</span>
                      <input
                        type="tel"
                        value={draft.recipient.phoneE164}
                        onChange={(event) =>
                          updateDraft("recipient", {
                            ...draft.recipient,
                            phoneE164: event.target.value,
                          })
                        }
                        placeholder="+14045550123"
                        className={`${TEAM_INPUT} w-full`}
                      />
                    </label>
                    <div className="space-y-2 text-sm">
                      <span className="font-medium">Delivery channels</span>
                      <div className="flex min-h-11 flex-wrap items-center gap-4">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={draft.recipient.emailSelected}
                            onChange={(event) =>
                              updateDraft("recipient", {
                                ...draft.recipient,
                                emailSelected: event.target.checked,
                              })
                            }
                          />
                          Email + PDF
                        </label>
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={draft.recipient.smsSelected}
                            onChange={(event) =>
                              updateDraft("recipient", {
                                ...draft.recipient,
                                smsSelected: event.target.checked,
                              })
                            }
                          />
                          SMS link
                        </label>
                      </div>
                    </div>
                  </div>
                </fieldset>

                <fieldset className="rounded-2xl border border-[color:var(--team-border)] p-4">
                  <legend className="px-2 text-sm font-semibold">
                    View-only recipients
                  </legend>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <p className="max-w-2xl text-xs text-[color:var(--team-text-soft)]">
                      Add CC or BCC recipients explicitly. They can view and
                      download this version but cannot approve, decline, request
                      changes, pay, or book.
                    </p>
                    <button
                      type="button"
                      className={teamButtonClass("secondary", "sm")}
                      onClick={addViewRecipient}
                      disabled={draft.additionalRecipients.length >= 19}
                    >
                      Add recipient
                    </button>
                  </div>
                  {draft.additionalRecipients.length === 0 ? (
                    <p className="mt-3 text-sm text-[color:var(--team-text-muted)]">
                      No view-only recipients.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-3">
                      {draft.additionalRecipients.map((recipient, index) => (
                        <div
                          key={recipient.id}
                          className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <p className="text-sm font-semibold">
                              Recipient {index + 1}
                            </p>
                            <button
                              type="button"
                              className={teamButtonClass("danger", "sm")}
                              onClick={() =>
                                updateDraft(
                                  "additionalRecipients",
                                  draft.additionalRecipients.filter(
                                    (item) => item.id !== recipient.id,
                                  ),
                                )
                              }
                            >
                              Remove
                            </button>
                          </div>
                          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <label className="space-y-1 text-sm">
                              <span className="font-medium">
                                Recipient type
                              </span>
                              <select
                                className={`${TEAM_SELECT} w-full`}
                                value={recipient.role}
                                onChange={(event) =>
                                  updateViewRecipient(recipient.id, {
                                    role: event.target.value as "cc" | "bcc",
                                  })
                                }
                              >
                                <option value="cc">
                                  CC · visible recipient
                                </option>
                                <option value="bcc">
                                  BCC · hidden recipient
                                </option>
                              </select>
                            </label>
                            <label className="space-y-1 text-sm">
                              <span className="font-medium">Name</span>
                              <input
                                className={`${TEAM_INPUT_COMPACT} w-full`}
                                value={recipient.name}
                                maxLength={240}
                                onChange={(event) =>
                                  updateViewRecipient(recipient.id, {
                                    name: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <label className="space-y-1 text-sm">
                              <span className="font-medium">Email</span>
                              <input
                                type="email"
                                className={`${TEAM_INPUT_COMPACT} w-full`}
                                value={recipient.email}
                                onChange={(event) =>
                                  updateViewRecipient(recipient.id, {
                                    email: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <label className="space-y-1 text-sm">
                              <span className="font-medium">
                                Mobile (E.164)
                              </span>
                              <input
                                type="tel"
                                className={`${TEAM_INPUT_COMPACT} w-full`}
                                value={recipient.phoneE164}
                                placeholder="+14045550123"
                                onChange={(event) =>
                                  updateViewRecipient(recipient.id, {
                                    phoneE164: event.target.value,
                                  })
                                }
                              />
                            </label>
                          </div>
                          <div className="mt-3 flex min-h-11 flex-wrap items-center gap-4 text-sm">
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={recipient.emailSelected}
                                onChange={(event) =>
                                  updateViewRecipient(recipient.id, {
                                    emailSelected: event.target.checked,
                                  })
                                }
                              />
                              Email + PDF
                            </label>
                            <label className="inline-flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={recipient.smsSelected}
                                onChange={(event) =>
                                  updateViewRecipient(recipient.id, {
                                    smsSelected: event.target.checked,
                                  })
                                }
                              />
                              SMS link
                            </label>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </fieldset>

                <label
                  htmlFor="quote-cover-message"
                  className="space-y-2 text-sm"
                >
                  <span className="font-medium">Optional introduction</span>
                  <textarea
                    id="quote-cover-message"
                    value={draft.coverMessage}
                    onChange={(event) =>
                      updateDraft("coverMessage", event.target.value)
                    }
                    rows={4}
                    maxLength={4_000}
                    className={`${TEAM_INPUT} w-full`}
                    placeholder="A short personal note before the deterministic proposal facts."
                  />
                  <span className="block text-xs text-[color:var(--team-text-soft)]">
                    Price, scope, terms, expiry, payment, and secure links
                    cannot be changed by this message.
                  </span>
                </label>

                <section className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                  <h4 className="font-semibold">Readiness checklist</h4>
                  <ul className="mt-3 space-y-2 text-sm">
                    {readiness.requirements.map((item) => (
                      <li
                        key={item.id}
                        className="flex items-start justify-between gap-3"
                      >
                        <span>{item.label}</span>
                        <button
                          type="button"
                          className={`min-h-11 shrink-0 rounded-full px-3 text-xs font-semibold ${TEAM_FOCUS_RING} ${item.complete ? "text-[color:var(--team-success-text)]" : "text-[color:var(--team-link)] underline"}`}
                          onClick={() => selectStep(item.step)}
                        >
                          {item.complete ? "Complete" : "Fix"}
                        </button>
                      </li>
                    ))}
                    <li className="flex items-start justify-between gap-3">
                      <span>Immutable PDF generated</span>
                      <span className="min-h-11 px-3 py-3 text-xs text-[color:var(--team-text-soft)]">
                        Checked by server at issue
                      </span>
                    </li>
                  </ul>
                </section>

                {issueReceipt ? (
                  <section
                    className={teamStatePanelClass("success")}
                    role="status"
                  >
                    <h4 className="font-semibold">Delivery requested</h4>
                    <p className="mt-1">
                      {issueReceipt.quoteNumber
                        ? `${issueReceipt.quoteNumber} · `
                        : ""}
                      {issueReceipt.overallState.replaceAll("_", " ")}
                    </p>
                    {issueReceipt.correlationId ? (
                      <p className="mt-1 text-xs">
                        Reference {issueReceipt.correlationId}
                      </p>
                    ) : null}
                  </section>
                ) : null}

                <button
                  type="button"
                  className={`${teamButtonClass("primary")} w-full sm:w-auto`}
                  disabled={
                    !canSend ||
                    !readiness.ready ||
                    !receipt ||
                    (saveStatus !== "saved" && saveStatus !== "issue_error") ||
                    !draftIsServerSaved
                  }
                  onClick={() => void issueProposal()}
                >
                  {!canSend
                    ? "Send permission required"
                    : saveStatus === "issuing"
                      ? "Issuing…"
                      : "Freeze version and send"}
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--team-border)] pt-4">
            <button
              type="button"
              className={teamButtonClass("secondary")}
              disabled={step === "client_project"}
              onClick={() => moveStep(-1)}
            >
              Previous
            </button>
            {step !== "review_send" ? (
              <button
                type="button"
                className={teamButtonClass("primary")}
                onClick={() => moveStep(1)}
              >
                Continue
              </button>
            ) : null}
          </div>
        </div>

        <aside
          className={`${TEAM_CARD_PADDED} sticky bottom-3 z-10 xl:top-24 xl:bottom-auto`}
          aria-label="Quote totals and readiness"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--team-text-soft)]">
            Authoritative summary
          </p>
          <p className="mt-2 text-2xl font-semibold text-[color:var(--team-text)]">
            {quoteRangeLabel(
              displayedTotals.totalMinCents,
              displayedTotals.totalMaxCents,
              draft.documentType,
            )}
          </p>
          <dl className="mt-3 hidden space-y-2 text-sm sm:block">
            <div className="flex justify-between gap-3">
              <dt>Subtotal</dt>
              <dd>
                {quoteRangeLabel(
                  displayedTotals.subtotalMinCents,
                  displayedTotals.subtotalMaxCents,
                  draft.documentType,
                )}
              </dd>
            </div>
            {displayedTotals.discountMaxCents > 0 ? (
              <div className="flex justify-between gap-3">
                <dt>Discounts</dt>
                <dd>
                  −
                  {quoteRangeLabel(
                    displayedTotals.discountMinCents,
                    displayedTotals.discountMaxCents,
                    draft.documentType,
                  )}
                </dd>
              </div>
            ) : null}
            {displayedTotals.feeMaxCents > 0 ? (
              <div className="flex justify-between gap-3">
                <dt>Fees and travel</dt>
                <dd>
                  {quoteRangeLabel(
                    displayedTotals.feeMinCents,
                    displayedTotals.feeMaxCents,
                    draft.documentType,
                  )}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3 border-t border-[color:var(--team-border)] pt-2">
              <dt>Deposit</dt>
              <dd>{formatQuoteV2Money(displayedTotals.depositCents)}</dd>
            </div>
            <div className="flex justify-between gap-3 font-semibold">
              <dt>Balance</dt>
              <dd>
                {quoteRangeLabel(
                  displayedTotals.balanceMinCents,
                  displayedTotals.balanceMaxCents,
                  draft.documentType,
                )}
              </dd>
            </div>
          </dl>
          <div className="mt-4 border-t border-[color:var(--team-border)] pt-4">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span>Readiness</span>
              <strong>
                {readiness.completedCount}/{readiness.requirements.length}
              </strong>
            </div>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-[color:var(--team-surface-muted)]"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={readiness.requirements.length}
              aria-valuenow={readiness.completedCount}
              aria-label="Proposal readiness"
            >
              <div
                className="h-full bg-[color:var(--team-action-primary)] transition-[width] motion-reduce:transition-none"
                style={{
                  width: `${(readiness.completedCount / readiness.requirements.length) * 100}%`,
                }}
              />
            </div>
          </div>
          {totalsMismatch ? (
            <p
              className="mt-3 text-xs text-[color:var(--team-warning-text)]"
              role="status"
            >
              The server total differs from the newest local edits. Wait for
              autosave before issuing.
            </p>
          ) : (
            <p className="mt-3 text-xs text-[color:var(--team-text-soft)]">
              {draftIsServerSaved && receipt?.authoritativeTotals
                ? "Totals reconciled by the server."
                : "Local preview only; the server will reconcile every cent."}
            </p>
          )}
        </aside>
      </div>

      <div className="sr-only" aria-live="assertive">
        {Object.values(fieldErrors)[0] ?? ""}
      </div>
    </section>
  );
}
