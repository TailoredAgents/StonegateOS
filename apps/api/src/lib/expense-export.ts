function hasSpreadsheetFormulaPrefix(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    const character = value[index] ?? "";
    if (value.charCodeAt(index) > 0x20 && character.trim() !== "") break;
    index += 1;
  }
  return ["=", "+", "-", "@"].includes(value[index] ?? "");
}

/**
 * Prevent spreadsheet applications from interpreting user-controlled text as
 * a formula while retaining the original text for reconciliation.
 */
export function neutralizeSpreadsheetFormula(value: string): string {
  return hasSpreadsheetFormulaPrefix(value) ? `'${value}` : value;
}

export function csvCell(value: string | number | null | undefined): string {
  const raw =
    typeof value === "number"
      ? Number.isFinite(value)
        ? String(value)
        : ""
      : neutralizeSpreadsheetFormula(
          value === null || value === undefined ? "" : value,
        );
  return /[",\r\n]/u.test(raw) ? `"${raw.replace(/"/gu, '""')}"` : raw;
}

export function expenseCsvRow(
  values: readonly (string | number | null | undefined)[],
): string {
  return values.map(csvCell).join(",");
}
