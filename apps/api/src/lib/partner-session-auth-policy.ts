import { isPartnerRoutineMagicLinkLoginEnabled } from "@/lib/partner-portal-feature-flags";

export type RetiredPartnerSessionAuthMethod =
  | "legacy"
  | "magic_link"
  | "mfa_step_up";

export type ActivePartnerSessionAuthMethod =
  | "magic_link"
  | "password"
  | "passkey";

export function retiredPartnerSessionAuthMethods(): RetiredPartnerSessionAuthMethod[] {
  const methods: RetiredPartnerSessionAuthMethod[] = ["legacy", "mfa_step_up"];
  if (!isPartnerRoutineMagicLinkLoginEnabled()) methods.push("magic_link");
  return methods;
}

export function isRetiredPartnerSessionAuthMethod(authMethod: string): boolean {
  return activePartnerSessionAuthMethod(authMethod) === null;
}

export function activePartnerSessionAuthMethod(
  authMethod: string,
): ActivePartnerSessionAuthMethod | null {
  if (authMethod === "password" || authMethod === "passkey") {
    return authMethod;
  }
  if (authMethod === "magic_link" && isPartnerRoutineMagicLinkLoginEnabled()) {
    return authMethod;
  }
  return null;
}

export function publicPartnerSessionAuthMethod(authMethod: string): string {
  return isRetiredPartnerSessionAuthMethod(authMethod) ? "retired" : authMethod;
}
