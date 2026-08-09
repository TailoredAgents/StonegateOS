export type ContactResourceFailure =
  | "forbidden"
  | "not-found"
  | "malformed"
  | "server-error"
  | "unavailable";

export function classifyContactResourceResponse(input: {
  status: number;
  parsed: boolean;
  okFlag: unknown;
}): ContactResourceFailure | null {
  if (input.status === 403) return "forbidden";
  if (input.status === 404) return "not-found";
  if (input.status >= 500) return "server-error";
  if (input.status < 200 || input.status >= 300) return "unavailable";
  if (!input.parsed || input.okFlag !== true) return "malformed";
  return null;
}

export function contactResourceFailureMessage(
  resourceLabel: string,
  failure: ContactResourceFailure,
): string {
  switch (failure) {
    case "forbidden":
      return `You do not have permission to view ${resourceLabel}.`;
    case "not-found":
      return `${resourceLabel} is not available for this contact.`;
    case "malformed":
      return `${resourceLabel} returned an incomplete response. Nothing is being shown as empty.`;
    case "server-error":
      return `${resourceLabel} failed on the server. Try again when the service recovers.`;
    case "unavailable":
      return `${resourceLabel} could not be reached. Check your connection and try again.`;
  }
}
