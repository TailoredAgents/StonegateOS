function isExplicitlyEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on";
}

export function isSquarePosEnabled(): boolean {
  return isExplicitlyEnabled(process.env["SQUARE_POS_ENABLED"]);
}
