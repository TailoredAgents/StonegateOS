/** The contact agreed for a job must not change when a saved site is edited. */
export function partnerJobContact(
  scope: unknown,
  savedContact: unknown,
): Record<string, string> | null {
  const record =
    scope && typeof scope === "object" && !Array.isArray(scope)
      ? (scope as Record<string, unknown>)
      : {};
  const value = Object.prototype.hasOwnProperty.call(record, "onSiteContact")
    ? record["onSiteContact"]
    : savedContact;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const contact = value as Record<string, unknown>;
  return Object.fromEntries(
    ["name", "phone", "email"].flatMap((key) =>
      typeof contact[key] === "string" ? [[key, contact[key]]] : [],
    ),
  );
}
