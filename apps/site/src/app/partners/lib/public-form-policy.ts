export const PARTNER_PUBLIC_FORM_ACTIONS = {
  recovery: {
    endpoint: "password-recovery/request",
    page: "/partners/forgot-password",
    success: "/partners/forgot-password?sent=1",
  },
  reset: {
    endpoint: "password-recovery/complete",
    page: "/partners/reset-password",
    success: "/partners/login?reset=1",
  },
  activation: {
    endpoint: "activation/complete",
    page: "/partners/activate",
    success: "/partners/overview",
  },
  email_change: {
    endpoint: "email-change/confirm",
    page: "/partners/confirm-email",
    success: "/partners/login?emailChanged=1",
  },
} as const;

export function parsePartnerPublicForm(form: URLSearchParams) {
  const operation = form.get("operation");
  if (
    !operation ||
    !Object.prototype.hasOwnProperty.call(
      PARTNER_PUBLIC_FORM_ACTIONS,
      operation,
    )
  )
    return null;
  const key = form.get("operationKey") ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      key,
    )
  )
    return null;
  const fields = [
    "operation",
    "operationKey",
    "email",
    "password",
    "confirmPassword",
    "rememberMe",
  ];
  if (
    [...form.keys()].some(
      (field) => !fields.includes(field) || form.getAll(field).length !== 1,
    )
  )
    return null;
  const action = operation as keyof typeof PARTNER_PUBLIC_FORM_ACTIONS;
  const email = (form.get("email") ?? "").trim();
  const password = form.get("password") ?? "";
  const confirmPassword =
    form.get("confirmPassword") ?? (action === "activation" ? password : "");
  let body: Record<string, unknown>;
  if (action === "recovery") {
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
      return null;
    body = { email };
  } else if (action === "email_change") {
    body = {};
  } else {
    if (!password || password.length > 128 || password !== confirmPassword)
      return null;
    if (action === "reset" && password.length < 15) return null;
    body =
      action === "reset"
        ? { newPassword: password, confirmPassword }
        : {
            password,
            confirmPassword,
            rememberMe: form.get("rememberMe") === "on",
          };
  }
  return { ...PARTNER_PUBLIC_FORM_ACTIONS[action], body, key };
}

export function partnerPublicFormError(status: number): string {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 410) return "invalid_or_expired";
  if (status === 400 || status === 422) return "invalid_fields";
  return "temporarily_unavailable";
}

export function partnerPublicFormErrorMessage(
  value: string | undefined,
): string | null {
  switch (value) {
    case "rate_limited":
      return "Too many attempts. Wait a few minutes, then try again.";
    case "invalid_or_expired":
      return "This link is invalid, expired, or already used. Contact Stonegate if you need a replacement.";
    case "invalid_fields":
      return "Check the form details. Passwords must match; a new password needs 15–128 characters.";
    case "temporarily_unavailable":
      return "We couldn’t complete that request right now. Try again or contact Stonegate.";
    default:
      return null;
  }
}
