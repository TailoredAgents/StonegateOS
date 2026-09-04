"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  CreditCard,
  Landmark,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  type PartnerInvoice,
} from "../lib/portal-v2";
import {
  isInvoiceEligibleForHostedCardPayment,
  isPartnerEmbeddedPaymentIntent,
  isPartnerHostedPaymentIntent,
  isPartnerPaymentIntent,
  isPartnerPaymentIntentId,
  isSafeSquareHostedCheckoutUrl,
  isSquareWebPaymentsSdkUrl,
  resolveEmbeddedDepositAmount,
  squareVerificationAmount,
  type PartnerEmbeddedPaymentIntent,
  type PartnerHostedPaymentIntent,
  type PartnerPaymentIntent,
} from "../lib/portal-payments";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type Notice = {
  tone: "success" | "error" | "warning" | "info";
  text: string;
};

type InvoicePaymentLinkPayload = {
  ok: true;
  eligible: boolean;
  paymentIntent: unknown;
};

type CreatedPaymentIntentPayload = {
  ok: true;
  paymentIntent: unknown;
  reused?: boolean;
};

type PaymentIntentPayload = {
  ok: true;
  paymentIntent: unknown;
};

type SquareTokenResult = {
  status: string;
  token?: string;
  errors?: Array<{ code?: string; message?: string }>;
};

type SquareCard = {
  attach(target: string | HTMLElement): Promise<void>;
  tokenize(details: {
    amount: string;
    currencyCode: "USD";
    intent: "CHARGE";
    customerInitiated: true;
    sellerKeyedIn: false;
    billingContact?: { email?: string };
  }): Promise<SquareTokenResult>;
  destroy?: () => Promise<void> | void;
};

type SquareAch = {
  tokenize(details: {
    intent: "CHARGE";
    accountHolderName: string;
    amount: string;
    currency: "USD";
  }): Promise<SquareTokenResult>;
  destroy?: () => Promise<void> | void;
};

type SquarePayments = {
  card(): Promise<SquareCard>;
  ach(options: { transactionId: string }): Promise<SquareAch>;
};
type SquareWebPaymentsGlobal = {
  payments(
    applicationId: string,
    locationId: string,
  ): SquarePayments | Promise<SquarePayments>;
};

declare global {
  interface Window {
    Square?: SquareWebPaymentsGlobal;
  }
}

const squareSdkLoads = new Map<string, Promise<SquareWebPaymentsGlobal>>();

function loadSquareWebPaymentsSdk(
  sdkUrl: string,
): Promise<SquareWebPaymentsGlobal> {
  if (!isSquareWebPaymentsSdkUrl(sdkUrl)) {
    return Promise.reject(new Error("square_sdk_url_invalid"));
  }
  const existing = squareSdkLoads.get(sdkUrl);
  if (existing) return existing;
  const loading = new Promise<SquareWebPaymentsGlobal>((resolve, reject) => {
    const selector = `script[data-stonegate-square-sdk="${sdkUrl}"]`;
    let script = document.querySelector<HTMLScriptElement>(selector);
    const finish = () => {
      if (window.Square) resolve(window.Square);
      else reject(new Error("square_sdk_unavailable"));
    };
    if (script) {
      if (window.Square) {
        finish();
        return;
      }
      script.addEventListener("load", finish, { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error("square_sdk_load_failed")),
        { once: true },
      );
      return;
    }
    script = document.createElement("script");
    script.src = sdkUrl;
    script.async = true;
    script.dataset["stonegateSquareSdk"] = sdkUrl;
    script.referrerPolicy = "strict-origin-when-cross-origin";
    script.addEventListener("load", finish, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("square_sdk_load_failed")),
      { once: true },
    );
    document.head.append(script);
  });
  squareSdkLoads.set(sdkUrl, loading);
  void loading.catch(() => squareSdkLoads.delete(sdkUrl));
  return loading;
}

function paymentErrorMessage(error: string, status: number): Notice {
  if (error === "rate_limited" || status === 429) {
    return {
      tone: "warning",
      text: "Too many payment attempts were started. Wait a few minutes, then try again.",
    };
  }
  if (error === "review_required") {
    return {
      tone: "warning",
      text: "This invoice needs Stonegate review before an online payment can be started.",
    };
  }
  if (error === "conflict" || status === 409) {
    return {
      tone: "warning",
      text: "The invoice or an earlier payment attempt changed. Refresh the invoice before trying again.",
    };
  }
  if (error === "invalid_fields") {
    return {
      tone: "error",
      text: "The invoice balance changed before checkout started. Refresh this page and review the current balance.",
    };
  }
  if (status === 404) {
    return {
      tone: "error",
      text: "This invoice is no longer available to the selected account.",
    };
  }
  if (status === 403) {
    return {
      tone: "error",
      text: "Your current account role cannot start this payment.",
    };
  }
  return {
    tone: "error",
    text: "Online payment is temporarily unavailable. The invoice has not been marked paid; try again shortly.",
  };
}

function intentNotice(intent: PartnerHostedPaymentIntent): Notice {
  switch (intent.status) {
    case "succeeded":
      return {
        tone: "success",
        text: "Square confirmed the payment and Stonegate applied it to the invoice.",
      };
    case "pending":
    case "provisioning":
      return {
        tone: "info",
        text: "Square is still processing this card payment. The invoice remains due until the payment is confirmed and applied.",
      };
    case "ready":
      return {
        tone: "warning",
        text: "This checkout has not been confirmed as paid. Continue on Square to complete the card payment.",
      };
    case "requires_review":
      return {
        tone: "warning",
        text: "Stonegate needs to review this payment before the invoice status can change.",
      };
    case "failed":
      return {
        tone: "error",
        text: "Square did not complete this payment. The invoice remains due and no success has been recorded.",
      };
    case "canceled":
      return {
        tone: "warning",
        text: "This Square checkout was canceled. The invoice remains due.",
      };
    case "expired":
      return {
        tone: "warning",
        text: "This Square checkout link expired. The invoice remains due; start a new card payment below.",
      };
  }
}

function navigateToSquareCheckout(intent: PartnerHostedPaymentIntent): boolean {
  const url = intent.checkout.url;
  if (
    intent.status !== "ready" ||
    intent.checkout.mode !== "hosted_redirect" ||
    intent.checkout.embedded !== false ||
    !isSafeSquareHostedCheckoutUrl(url)
  ) {
    return false;
  }
  window.location.assign(url);
  return true;
}

function PartnerHostedInvoicePaymentAction({
  invoice,
  canManagePayments,
}: {
  invoice: PartnerInvoice;
  canManagePayments: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const operationKey = React.useRef<string | null>(null);

  const eligible = isInvoiceEligibleForHostedCardPayment({
    status: invoice.status,
    balance: invoice.amounts.balance,
  });

  const createCheckout = React.useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    if (!operationKey.current) {
      operationKey.current = createPortalOperationKey(
        `invoice-card-${invoice.id}`,
      );
    }
    const result = await partnerPortalFetch<CreatedPaymentIntentPayload>(
      `invoices/${encodeURIComponent(invoice.id)}/payment-link`,
      {
        method: "POST",
        headers: { "Idempotency-Key": operationKey.current },
        body: JSON.stringify({
          purpose: "one_off",
          paymentMethod: "card",
          amount: invoice.amounts.balance,
        }),
      },
    ).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      const code = result?.error.error ?? "service_unavailable";
      if (
        ["conflict", "invalid_fields", "review_required", "not_found"].includes(
          code,
        )
      ) {
        operationKey.current = null;
      }
      setNotice(paymentErrorMessage(code, result?.response.status ?? 503));
      return;
    }
    if (!isPartnerHostedPaymentIntent(result.data.paymentIntent)) {
      operationKey.current = null;
      setNotice({
        tone: "error",
        text: "The payment service returned an invalid checkout response. No navigation occurred; try again later.",
      });
      return;
    }
    if (!navigateToSquareCheckout(result.data.paymentIntent)) {
      setNotice(intentNotice(result.data.paymentIntent));
      if (result.data.paymentIntent.status === "succeeded") router.refresh();
    }
  }, [invoice.amounts.balance, invoice.id, router]);

  const beginPayment = React.useCallback(async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    const existing = await partnerPortalFetch<InvoicePaymentLinkPayload>(
      `invoices/${encodeURIComponent(invoice.id)}/payment-link`,
    ).catch(() => null);
    setBusy(false);
    if (!existing?.ok) {
      const code = existing?.error.error ?? "service_unavailable";
      setNotice(paymentErrorMessage(code, existing?.response.status ?? 503));
      return;
    }
    if (!existing.data.eligible) {
      setNotice({
        tone: "warning",
        text: "This invoice is not eligible for online card payment. Contact Stonegate for billing assistance.",
      });
      return;
    }
    if (existing.data.paymentIntent !== null) {
      if (!isPartnerHostedPaymentIntent(existing.data.paymentIntent)) {
        setNotice({
          tone: "error",
          text: "The payment service returned an invalid status. No navigation occurred; try again later.",
        });
        return;
      }
      if (navigateToSquareCheckout(existing.data.paymentIntent)) return;
      setNotice(intentNotice(existing.data.paymentIntent));
      if (existing.data.paymentIntent.status === "succeeded") router.refresh();
      return;
    }
    await createCheckout();
  }, [createCheckout, invoice.id, router]);

  if (!canManagePayments || !eligible) return null;

  return (
    <div className="basis-full">
      <button
        type="button"
        onClick={() => void beginPayment()}
        disabled={busy}
        className={partnerPrimaryButtonClass}
      >
        {busy ? (
          <LoaderCircle
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <CreditCard className="h-4 w-4" aria-hidden="true" />
        )}
        {busy ? "Checking invoice…" : "Pay balance by card"}
        {!busy ? <ArrowUpRight className="h-4 w-4" aria-hidden="true" /> : null}
      </button>
      <p className="mt-2 max-w-md text-xs leading-5 text-slate-600">
        Opens Square’s secure hosted checkout. Card only; checkout is not
        embedded in this portal.
      </p>
      {notice ? (
        <PartnerNotice tone={notice.tone} className="mt-3">
          {notice.text}
        </PartnerNotice>
      ) : null}
    </div>
  );
}

function embeddedIntentNotice(intent: PartnerEmbeddedPaymentIntent): Notice {
  const isAch = intent.paymentMethod === "ach";
  switch (intent.status) {
    case "succeeded":
      return {
        tone: "success",
        text: isAch
          ? "Square confirmed the bank transfer and Stonegate applied it to the invoice."
          : "Square confirmed the card payment and Stonegate applied it to the invoice.",
      };
    case "pending":
    case "provisioning":
      return {
        tone: "info",
        text: isAch
          ? "Square received the ACH bank transfer. Settlement usually takes two to three business days, and the invoice remains due until a signed Square update confirms it."
          : "Square received the card payment, but verification is still in progress. The invoice remains due until Stonegate applies it.",
      };
    case "ready":
      return {
        tone: "info",
        text: isAch
          ? "Connect a US bank account below. Square handles authorization and gives Stonegate only a one-use payment token; bank credentials are never sent to Stonegate."
          : "Enter the card details below. Square securely tokenizes the card; Stonegate does not receive or store the card number.",
      };
    case "requires_review":
      return {
        tone: "warning",
        text: "Stonegate needs to review this payment before the invoice status can change. Do not submit another payment.",
      };
    case "failed":
      return {
        tone: "error",
        text: `Square did not complete this ${isAch ? "bank transfer" : "card payment"}. The invoice remains due; you can start a new attempt.`,
      };
    case "canceled":
      return {
        tone: "warning",
        text: `This ${isAch ? "bank transfer" : "card payment"} was canceled. The invoice remains due.`,
      };
    case "expired":
      return {
        tone: "warning",
        text: `This secure ${isAch ? "bank-transfer session" : "card form"} expired. The invoice remains due; start a new deposit payment.`,
      };
  }
}

function formatUsdMinor(amountMinor: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amountMinor / 100);
}

function PartnerEmbeddedDepositPaymentAction({
  invoice,
  depositAmount,
  canManagePayments,
  payerEmail,
  payerName,
}: {
  invoice: PartnerInvoice;
  depositAmount: PartnerInvoice["amounts"]["deposit"];
  canManagePayments: boolean;
  payerEmail: string | null;
  payerName: string | null;
}) {
  const router = useRouter();
  const cardContainerId = React.useId().replace(/[^A-Za-z0-9_-]/gu, "");
  const [intent, setIntent] =
    React.useState<PartnerEmbeddedPaymentIntent | null>(null);
  const [cardStatus, setCardStatus] = React.useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [achStatus, setAchStatus] = React.useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const prepareKeys = React.useRef<Partial<Record<"card" | "ach", string>>>({});
  const completeKey = React.useRef<string | null>(null);
  const card = React.useRef<SquareCard | null>(null);
  const ach = React.useRef<SquareAch | null>(null);
  const pendingMethod = React.useRef<"card" | "ach">("card");
  const pollCount = React.useRef(0);

  React.useEffect(() => {
    if (
      !intent ||
      intent.status !== "ready" ||
      intent.paymentMethod !== "card"
    ) {
      return;
    }
    let active = true;
    let attachedCard: SquareCard | null = null;
    setCardStatus("loading");
    void (async () => {
      try {
        const square = await loadSquareWebPaymentsSdk(
          intent.webPayments.sdkUrl,
        );
        const payments = await square.payments(
          intent.webPayments.applicationId,
          intent.webPayments.locationId,
        );
        attachedCard = await payments.card();
        await attachedCard.attach(`#${cardContainerId}`);
        if (!active) {
          await attachedCard.destroy?.();
          return;
        }
        card.current = attachedCard;
        setCardStatus("ready");
      } catch {
        if (!active) return;
        card.current = null;
        setCardStatus("error");
        setNotice({
          tone: "error",
          text: "The secure Square card form could not load. No payment was submitted; check the connection and try again.",
        });
      }
    })();
    return () => {
      active = false;
      if (card.current === attachedCard) card.current = null;
      void attachedCard?.destroy?.();
    };
  }, [cardContainerId, intent]);

  React.useEffect(() => {
    if (
      !intent ||
      intent.status !== "ready" ||
      intent.paymentMethod !== "ach"
    ) {
      return;
    }
    let active = true;
    let initializedAch: SquareAch | null = null;
    setAchStatus("loading");
    void (async () => {
      try {
        const square = await loadSquareWebPaymentsSdk(
          intent.webPayments.sdkUrl,
        );
        const payments = await square.payments(
          intent.webPayments.applicationId,
          intent.webPayments.locationId,
        );
        initializedAch = await payments.ach({ transactionId: intent.id });
        if (!active) {
          await initializedAch.destroy?.();
          return;
        }
        ach.current = initializedAch;
        setAchStatus("ready");
      } catch {
        if (!active) return;
        ach.current = null;
        setAchStatus("error");
        setNotice({
          tone: "error",
          text: "Square’s secure bank connection could not load. No bank credentials or payment were submitted; try again later.",
        });
      }
    })();
    return () => {
      active = false;
      if (ach.current === initializedAch) ach.current = null;
      void initializedAch?.destroy?.();
    };
  }, [intent]);

  const preparePayment = React.useCallback(
    async (paymentMethod: "card" | "ach"): Promise<void> => {
      setBusy(true);
      setNotice(null);
      if (!prepareKeys.current[paymentMethod]) {
        prepareKeys.current[paymentMethod] = createPortalOperationKey(
          `invoice-deposit-${paymentMethod}-${invoice.id}`,
        );
      }
      const result = await partnerPortalFetch<CreatedPaymentIntentPayload>(
        "payment-intents",
        {
          method: "POST",
          headers: {
            "Idempotency-Key": prepareKeys.current[paymentMethod],
          },
          body: JSON.stringify({
            invoiceId: invoice.id,
            purpose: "deposit",
            paymentMethod,
            amount: depositAmount,
          }),
        },
      ).catch(() => null);
      setBusy(false);
      if (!result?.ok) {
        const code = result?.error.error ?? "service_unavailable";
        if (
          [
            "conflict",
            "invalid_fields",
            "review_required",
            "not_found",
          ].includes(code)
        ) {
          delete prepareKeys.current[paymentMethod];
        }
        setNotice(
          paymentMethod === "ach" && code === "invalid_fields"
            ? {
                tone: "warning",
                text: "ACH bank transfer is not enabled for this account. No payment was started; choose card or contact Stonegate.",
              }
            : paymentErrorMessage(code, result?.response.status ?? 503),
        );
        return;
      }
      const nextIntent = result.data.paymentIntent;
      if (
        !isPartnerEmbeddedPaymentIntent(nextIntent) ||
        nextIntent.paymentMethod !== paymentMethod ||
        nextIntent.invoiceId !== invoice.id ||
        nextIntent.purpose !== "deposit" ||
        nextIntent.amount.amountMinor !== depositAmount.amountMinor ||
        nextIntent.amount.currency !== depositAmount.currency ||
        nextIntent.amount.minorUnit !== depositAmount.minorUnit
      ) {
        delete prepareKeys.current[paymentMethod];
        setNotice({
          tone: "error",
          text: "The payment service returned an invalid deposit response. No payment details were submitted.",
        });
        return;
      }
      completeKey.current = null;
      setIntent(nextIntent);
      setNotice(embeddedIntentNotice(nextIntent));
    },
    [depositAmount, invoice.id],
  );

  const beginPayment = React.useCallback(
    async (paymentMethod: "card" | "ach"): Promise<void> => {
      pendingMethod.current = paymentMethod;
      await preparePayment(paymentMethod);
    },
    [preparePayment],
  );

  async function submitCard(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const currentIntent = intent;
    const currentCard = card.current;
    const verificationAmount = squareVerificationAmount(depositAmount);
    if (
      !currentIntent ||
      currentIntent.status !== "ready" ||
      currentIntent.paymentMethod !== "card" ||
      !currentCard ||
      cardStatus !== "ready" ||
      !verificationAmount
    ) {
      setNotice({
        tone: "error",
        text: "The secure card form is not ready. No payment was submitted.",
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    let tokenResult: SquareTokenResult;
    try {
      tokenResult = await currentCard.tokenize({
        amount: verificationAmount,
        currencyCode: "USD",
        intent: "CHARGE",
        customerInitiated: true,
        sellerKeyedIn: false,
        ...(payerEmail ? { billingContact: { email: payerEmail } } : {}),
      });
    } catch {
      setBusy(false);
      setNotice({
        tone: "error",
        text: "Square could not securely tokenize the card. No payment was submitted; review the card details and try again.",
      });
      return;
    }
    if (
      tokenResult.status !== "OK" ||
      typeof tokenResult.token !== "string" ||
      tokenResult.token.length < 8 ||
      tokenResult.token.length > 2_048
    ) {
      setBusy(false);
      setNotice({
        tone: "error",
        text: "Square did not accept the card details. No payment was submitted; check the highlighted fields and try again.",
      });
      return;
    }
    if (!completeKey.current) {
      completeKey.current = createPortalOperationKey(
        `embedded-card-${currentIntent.id}`,
      );
    }
    let oneUseToken = tokenResult.token;
    tokenResult.token = undefined;
    const result = await partnerPortalFetch<PaymentIntentPayload>(
      `payment-intents/${encodeURIComponent(currentIntent.id)}/complete`,
      {
        method: "POST",
        headers: { "Idempotency-Key": completeKey.current },
        body: JSON.stringify({
          sourceToken: oneUseToken,
          paymentMethod: "card",
        }),
      },
    ).catch(() => null);
    // Do not retain the opaque one-use provider token in state, storage, logs,
    // analytics, or error messages after the completion request is created.
    oneUseToken = "";
    setBusy(false);
    if (!result?.ok) {
      const code = result?.error.error ?? "service_unavailable";
      completeKey.current = null;
      if (code === "invalid_fields") {
        setIntent(null);
        delete prepareKeys.current.card;
        setCardStatus("idle");
        setNotice({
          tone: "error",
          text: "Square did not complete this card payment. The invoice remains due; start a new attempt and review the card details.",
        });
      } else if (
        code === "review_required" ||
        code === "conflict" ||
        code === "not_found"
      ) {
        setIntent({ ...currentIntent, status: "requires_review" });
        setNotice(paymentErrorMessage(code, result?.response.status ?? 503));
      } else {
        setNotice(paymentErrorMessage(code, result?.response.status ?? 503));
      }
      return;
    }
    const nextIntent = result.data.paymentIntent;
    if (
      !isPartnerEmbeddedPaymentIntent(nextIntent) ||
      nextIntent.paymentMethod !== "card" ||
      nextIntent.id !== currentIntent.id ||
      nextIntent.invoiceId !== invoice.id ||
      nextIntent.amount.amountMinor !== depositAmount.amountMinor
    ) {
      setNotice({
        tone: "warning",
        text: "The payment response could not be verified in this browser. Do not submit again; use Check status or contact Stonegate.",
      });
      setIntent({ ...currentIntent, status: "requires_review" });
      return;
    }
    setIntent(nextIntent);
    setNotice(embeddedIntentNotice(nextIntent));
    if (nextIntent.status === "succeeded") router.refresh();
  }

  async function submitAch(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const currentIntent = intent;
    const currentAch = ach.current;
    const verificationAmount = squareVerificationAmount(depositAmount);
    const formData = new FormData(event.currentTarget);
    const rawName = formData.get("accountHolderName");
    const accountHolderName =
      typeof rawName === "string"
        ? rawName.normalize("NFKC").replace(/\s+/gu, " ").trim()
        : "";
    if (
      !currentIntent ||
      currentIntent.status !== "ready" ||
      currentIntent.paymentMethod !== "ach" ||
      !currentAch ||
      achStatus !== "ready" ||
      !verificationAmount
    ) {
      setNotice({
        tone: "error",
        text: "The secure Square bank connection is not ready. No payment was submitted.",
      });
      return;
    }
    if (
      accountHolderName.length < 2 ||
      accountHolderName.length > 128 ||
      [...accountHolderName].some((character) => {
        const point = character.codePointAt(0) ?? 0;
        return point < 32 || point === 127;
      })
    ) {
      setNotice({
        tone: "error",
        text: "Enter the bank account holder’s full name before continuing.",
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    let tokenResult: SquareTokenResult;
    try {
      tokenResult = await currentAch.tokenize({
        intent: "CHARGE",
        accountHolderName,
        amount: verificationAmount,
        currency: "USD",
      });
    } catch {
      setBusy(false);
      setNotice({
        tone: "error",
        text: "Square could not authorize the bank account. No payment was submitted; review the connection and try again.",
      });
      return;
    }
    if (
      tokenResult.status !== "OK" ||
      typeof tokenResult.token !== "string" ||
      !tokenResult.token.startsWith("bauth:") ||
      tokenResult.token.length > 2_048
    ) {
      setBusy(false);
      setNotice({
        tone: "error",
        text: "Square did not authorize the bank account. No payment was submitted; reconnect it or choose card.",
      });
      return;
    }
    if (!completeKey.current) {
      completeKey.current = createPortalOperationKey(
        `embedded-ach-${currentIntent.id}`,
      );
    }
    let oneUseToken = tokenResult.token;
    tokenResult.token = undefined;
    const result = await partnerPortalFetch<PaymentIntentPayload>(
      `payment-intents/${encodeURIComponent(currentIntent.id)}/complete`,
      {
        method: "POST",
        headers: { "Idempotency-Key": completeKey.current },
        body: JSON.stringify({
          sourceToken: oneUseToken,
          paymentMethod: "ach",
        }),
      },
    ).catch(() => null);
    // The one-use bank authorization token is never retained, logged, or
    // exposed after the server request has been created.
    oneUseToken = "";
    setBusy(false);
    if (!result?.ok) {
      const code = result?.error.error ?? "service_unavailable";
      completeKey.current = null;
      if (code === "invalid_fields") {
        setIntent(null);
        delete prepareKeys.current.ach;
        setAchStatus("idle");
        setNotice({
          tone: "error",
          text: "Square did not start this bank transfer. The invoice remains due; reconnect the bank account or choose card.",
        });
      } else if (
        code === "review_required" ||
        code === "conflict" ||
        code === "not_found"
      ) {
        setIntent({ ...currentIntent, status: "requires_review" });
        setNotice(paymentErrorMessage(code, result?.response.status ?? 503));
      } else {
        setNotice(paymentErrorMessage(code, result?.response.status ?? 503));
      }
      return;
    }
    const nextIntent = result.data.paymentIntent;
    if (
      !isPartnerEmbeddedPaymentIntent(nextIntent) ||
      nextIntent.paymentMethod !== "ach" ||
      nextIntent.id !== currentIntent.id ||
      nextIntent.invoiceId !== invoice.id ||
      nextIntent.amount.amountMinor !== depositAmount.amountMinor ||
      nextIntent.status === "succeeded"
    ) {
      setNotice({
        tone: "warning",
        text: "The bank-transfer response could not be safely verified in this browser. Do not submit again; use Check status or contact Stonegate.",
      });
      setIntent({ ...currentIntent, status: "requires_review" });
      return;
    }
    setIntent(nextIntent);
    setNotice(embeddedIntentNotice(nextIntent));
  }

  const checkEmbeddedStatus = React.useCallback(
    async (paymentIntentId: string): Promise<void> => {
      const result = await partnerPortalFetch<PaymentIntentPayload>(
        `payment-intents/${encodeURIComponent(paymentIntentId)}`,
      ).catch(() => null);
      pollCount.current += 1;
      if (!result?.ok) {
        const code = result?.error.error ?? "service_unavailable";
        setNotice(paymentErrorMessage(code, result?.response.status ?? 503));
        return;
      }
      if (!isPartnerEmbeddedPaymentIntent(result.data.paymentIntent)) {
        setNotice({
          tone: "warning",
          text: "The payment status could not be verified in this browser. Do not submit another payment; try status again or contact Stonegate.",
        });
        return;
      }
      const nextIntent = result.data.paymentIntent;
      if (
        nextIntent.id !== paymentIntentId ||
        nextIntent.invoiceId !== invoice.id
      ) {
        return;
      }
      setIntent(nextIntent);
      setNotice(embeddedIntentNotice(nextIntent));
      if (nextIntent.status === "succeeded") router.refresh();
    },
    [invoice.id, router],
  );

  React.useEffect(() => {
    if (
      !intent ||
      intent.paymentMethod === "ach" ||
      !["pending", "provisioning"].includes(intent.status) ||
      pollCount.current >= 15
    ) {
      return;
    }
    const timer = setTimeout(() => {
      void checkEmbeddedStatus(intent.id);
    }, 3_000);
    return () => clearTimeout(timer);
  }, [checkEmbeddedStatus, intent]);

  if (!canManagePayments) return null;

  return (
    <div className="basis-full">
      {!intent || ["failed", "canceled", "expired"].includes(intent.status) ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void beginPayment("card")}
            disabled={busy}
            className={partnerPrimaryButtonClass}
          >
            {busy && pendingMethod.current === "card" ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <CreditCard className="h-4 w-4" aria-hidden="true" />
            )}
            {busy && pendingMethod.current === "card"
              ? "Preparing card form…"
              : `Pay ${formatUsdMinor(depositAmount.amountMinor)} by card`}
          </button>
          <button
            type="button"
            onClick={() => void beginPayment("ach")}
            disabled={busy}
            className={partnerSecondaryButtonClass}
          >
            {busy && pendingMethod.current === "ach" ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Landmark className="h-4 w-4" aria-hidden="true" />
            )}
            {busy && pendingMethod.current === "ach"
              ? "Preparing bank connection…"
              : "Pay by ACH bank transfer"}
          </button>
        </div>
      ) : null}
      <p className="mt-2 max-w-md text-xs leading-5 text-slate-600">
        Required deposit only. Square securely tokenizes card or bank details;
        Stonegate never receives or stores account credentials. ACH starts only
        when the account and signed-webhook integration are enabled.
      </p>
      {notice ? (
        <PartnerNotice tone={notice.tone} className="mt-3">
          {notice.text}
        </PartnerNotice>
      ) : null}
      {intent?.status === "ready" && intent.paymentMethod === "card" ? (
        <form
          onSubmit={(event) => void submitCard(event)}
          className="mt-4 max-w-xl rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          data-partner-analytics="embedded_card_submit"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="font-semibold text-slate-950">
                Secure card payment
              </h4>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                Deposit amount: {formatUsdMinor(depositAmount.amountMinor)}
              </p>
            </div>
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
              Powered by Square
            </span>
          </div>
          <div
            id={cardContainerId}
            className="mt-4 min-h-12 rounded-lg border border-slate-300 bg-white p-2"
            aria-label="Secure Square card details"
          />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || cardStatus !== "ready"}
              className={partnerPrimaryButtonClass}
            >
              {busy || cardStatus === "loading" ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              )}
              {busy
                ? "Submitting securely…"
                : cardStatus === "loading"
                  ? "Loading secure form…"
                  : `Pay ${formatUsdMinor(depositAmount.amountMinor)}`}
            </button>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            The amount and USD currency are verified again by Stonegate and
            Square before the invoice changes. Do not refresh while submitting.
          </p>
        </form>
      ) : null}
      {intent?.status === "ready" && intent.paymentMethod === "ach" ? (
        <form
          onSubmit={(event) => void submitAch(event)}
          className="mt-4 max-w-xl rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          data-partner-analytics="embedded_ach_submit"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="font-semibold text-slate-950">
                Secure ACH bank transfer
              </h4>
              <p className="mt-1 text-xs leading-5 text-slate-600">
                Deposit amount: {formatUsdMinor(depositAmount.amountMinor)}
              </p>
            </div>
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-800">
              Powered by Square
            </span>
          </div>
          <label className="mt-4 block">
            <span className="text-sm font-semibold text-slate-800">
              Bank account holder name
            </span>
            <input
              name="accountHolderName"
              type="text"
              required
              minLength={2}
              maxLength={128}
              autoComplete="name"
              defaultValue={payerName ?? ""}
              className={partnerFieldClass}
            />
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || achStatus !== "ready"}
              className={partnerPrimaryButtonClass}
            >
              {busy || achStatus === "loading" ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Landmark className="h-4 w-4" aria-hidden="true" />
              )}
              {busy
                ? "Opening Square securely…"
                : achStatus === "loading"
                  ? "Loading bank connection…"
                  : `Authorize ${formatUsdMinor(depositAmount.amountMinor)}`}
            </button>
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-500">
            Square provides the bank authorization flow. ACH remains pending,
            typically for two to three business days. The invoice remains due
            until a signed Square update is received and reconciled.
          </p>
        </form>
      ) : null}
      {intent && ["pending", "provisioning"].includes(intent.status) ? (
        <p
          className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-slate-700"
          role="status"
          aria-live="polite"
        >
          <LoaderCircle
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {intent.paymentMethod === "ach"
            ? "Bank transfer pending settlement…"
            : "Verifying payment status…"}
        </p>
      ) : null}
      {intent &&
      ["pending", "provisioning", "requires_review"].includes(intent.status) ? (
        <button
          type="button"
          onClick={() => {
            pollCount.current = 0;
            setBusy(true);
            void checkEmbeddedStatus(intent.id).finally(() => setBusy(false));
          }}
          disabled={busy}
          className={cn(partnerSecondaryButtonClass, "mt-3")}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Check payment status
        </button>
      ) : null}
      {intent?.status === "ready" &&
      intent.paymentMethod === "card" &&
      cardStatus === "error" ? (
        <button
          type="button"
          onClick={() => {
            setNotice(embeddedIntentNotice(intent));
            setIntent({ ...intent });
          }}
          className={cn(partnerSecondaryButtonClass, "mt-3")}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Retry secure card form
        </button>
      ) : null}
      {intent?.status === "ready" &&
      intent.paymentMethod === "ach" &&
      achStatus === "error" ? (
        <button
          type="button"
          onClick={() => {
            setNotice(embeddedIntentNotice(intent));
            setIntent({ ...intent });
          }}
          className={cn(partnerSecondaryButtonClass, "mt-3")}
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Retry secure bank connection
        </button>
      ) : null}
    </div>
  );
}

export function PartnerInvoicePaymentAction({
  invoice,
  canManagePayments,
  payerEmail = null,
  payerName = null,
}: {
  invoice: PartnerInvoice;
  canManagePayments: boolean;
  payerEmail?: string | null;
  payerName?: string | null;
}) {
  const depositAmount = resolveEmbeddedDepositAmount({
    status: invoice.status,
    deposit: invoice.amounts.deposit,
    paid: invoice.amounts.paid,
    balance: invoice.amounts.balance,
  });
  return depositAmount ? (
    <PartnerEmbeddedDepositPaymentAction
      invoice={invoice}
      depositAmount={depositAmount}
      canManagePayments={canManagePayments}
      payerEmail={payerEmail}
      payerName={payerName}
    />
  ) : (
    <PartnerHostedInvoicePaymentAction
      invoice={invoice}
      canManagePayments={canManagePayments}
    />
  );
}

const POLLABLE_STATUSES = new Set(["pending", "provisioning"]);
const MAX_AUTOMATIC_POLLS = 15;

export function PartnerPaymentReturnStatus({
  paymentIntentId,
  accessAvailable,
  canManagePayments,
}: {
  paymentIntentId: string | null;
  accessAvailable: boolean;
  canManagePayments: boolean;
}) {
  const router = useRouter();
  const [intent, setIntent] = React.useState<PartnerPaymentIntent | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [busy, setBusy] = React.useState(false);
  const mounted = React.useRef(true);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCount = React.useRef(0);
  const refreshedForSuccess = React.useRef(false);

  const checkStatus = React.useCallback(async (): Promise<void> => {
    if (!paymentIntentId || !isPartnerPaymentIntentId(paymentIntentId)) return;
    if (timer.current) clearTimeout(timer.current);
    setBusy(true);
    const result = await partnerPortalFetch<PaymentIntentPayload>(
      `payment-intents/${encodeURIComponent(paymentIntentId)}`,
    ).catch(() => null);
    if (!mounted.current) return;
    setBusy(false);
    if (!result?.ok) {
      const code = result?.error.error ?? "service_unavailable";
      setNotice(paymentErrorMessage(code, result?.response.status ?? 503));
      return;
    }
    if (
      !isPartnerPaymentIntent(result.data.paymentIntent) ||
      result.data.paymentIntent.id !== paymentIntentId
    ) {
      setNotice({
        tone: "error",
        text: "The payment service returned an invalid status. The invoice has not been treated as paid.",
      });
      return;
    }
    const nextIntent = result.data.paymentIntent;
    setIntent(nextIntent);
    setNotice(
      isPartnerEmbeddedPaymentIntent(nextIntent)
        ? embeddedIntentNotice(nextIntent)
        : intentNotice(nextIntent),
    );
    if (nextIntent.status === "succeeded" && !refreshedForSuccess.current) {
      refreshedForSuccess.current = true;
      router.refresh();
      return;
    }
    if (
      POLLABLE_STATUSES.has(nextIntent.status) &&
      (!isPartnerEmbeddedPaymentIntent(nextIntent) ||
        nextIntent.paymentMethod === "card") &&
      pollCount.current < MAX_AUTOMATIC_POLLS
    ) {
      pollCount.current += 1;
      timer.current = setTimeout(() => void checkStatus(), 3_000);
    }
  }, [paymentIntentId, router]);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  React.useEffect(() => {
    if (
      paymentIntentId &&
      isPartnerPaymentIntentId(paymentIntentId) &&
      canManagePayments
    ) {
      void checkStatus();
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [canManagePayments, checkStatus, paymentIntentId]);

  if (!paymentIntentId || !isPartnerPaymentIntentId(paymentIntentId))
    return null;

  if (!accessAvailable) {
    return (
      <PartnerNotice tone="warning" className="mb-4">
        We couldn’t verify protected payment access right now. The invoice has
        not been treated as paid; refresh this page before relying on its
        status.
      </PartnerNotice>
    );
  }

  if (!canManagePayments) {
    return (
      <PartnerNotice tone="warning" className="mb-4">
        This payment return belongs to a protected billing action. Switch to an
        authorized account or ask an account billing user to verify its status.
      </PartnerNotice>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-slate-950">Card payment status</h3>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Stonegate marks an invoice paid only after Square confirmation and
            invoice reconciliation.
          </p>
        </div>
        {busy ? (
          <span
            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600"
            role="status"
          >
            <LoaderCircle
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            Checking…
          </span>
        ) : null}
      </div>
      {notice ? (
        <PartnerNotice tone={notice.tone} className="mt-3">
          {notice.text}
        </PartnerNotice>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {intent?.status === "ready" &&
        isPartnerHostedPaymentIntent(intent) &&
        isSafeSquareHostedCheckoutUrl(intent.checkout.url) ? (
          <button
            type="button"
            onClick={() => void navigateToSquareCheckout(intent)}
            className={partnerPrimaryButtonClass}
            data-partner-analytics="hosted_payment_open"
          >
            Continue on Square
            <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        {intent?.status !== "succeeded" ? (
          <button
            type="button"
            onClick={() => {
              pollCount.current = 0;
              void checkStatus();
            }}
            disabled={busy}
            className={partnerSecondaryButtonClass}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Check status again
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => router.replace("/partners/billing")}
          className={cn(partnerSecondaryButtonClass, "shadow-none")}
        >
          Dismiss status
        </button>
      </div>
    </div>
  );
}
