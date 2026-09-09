import type { Route } from "next";
import Link from "next/link";
import { partnerSecondaryButtonClass } from "./PartnerPortalUi";

export function PartnerCollectionPagination({ basePath, cursorKey, nextCursor, params, label }: {
  basePath: "/partners/billing" | "/partners/reports";
  cursorKey: string;
  nextCursor: string | null;
  params: Record<string, string>;
  label: string;
}) {
  const newest = new URLSearchParams(params);
  newest.delete(cursorKey);
  const older = new URLSearchParams(params);
  if (nextCursor) older.set(cursorKey, nextCursor);
  if (!nextCursor && !params[cursorKey]) return null;
  return <nav aria-label={`${label} pages`} className="mt-4 flex flex-wrap gap-2">
    {params[cursorKey] ? <Link className={partnerSecondaryButtonClass}
      href={`${basePath}${newest.size ? `?${newest}` : ""}` as Route}>Newest {label}</Link> : null}
    {nextCursor ? <Link className={partnerSecondaryButtonClass}
      href={`${basePath}?${older}` as Route}>Older {label}</Link> : null}
  </nav>;
}
