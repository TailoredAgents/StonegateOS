/** File uploads must never be coerced into text fields or mutation payloads. */
export function formEntryText(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}
