import { Button } from "@myst-os/ui";
import { getPublicCompanyProfile } from "@/lib/company";

type CommercialContactActionsProps = {
  placement: string;
  compact?: boolean;
  showEmail?: boolean;
};

export function CommercialContactActions({
  placement,
  compact = false,
  showEmail = true,
}: CommercialContactActionsProps) {
  const company = getPublicCompanyProfile();

  return (
    <div className={showEmail ? "space-y-3" : undefined}>
      <div className={compact ? "flex gap-2" : "flex flex-wrap gap-3"}>
        <Button
          asChild
          size={compact ? "md" : "lg"}
          className={compact ? "min-h-12 flex-1 px-4" : "min-h-12"}
        >
          <a
            href={`tel:${company.phoneE164}`}
            data-cta={`commercial-${placement}-call`}
          >
            <span>Call Us</span>
            <span className={compact ? "hidden md:inline" : "hidden sm:inline"}>
              {company.phoneDisplay}
            </span>
          </a>
        </Button>
        <Button
          asChild
          variant="secondary"
          size={compact ? "md" : "lg"}
          className={compact ? "min-h-12 flex-1 px-4" : "min-h-12"}
        >
          <a
            href={`sms:${company.phoneE164}`}
            data-cta={`commercial-${placement}-text`}
          >
            Text Us
          </a>
        </Button>
      </div>
      {showEmail ? (
        <a
          href={`mailto:${company.email}`}
          data-cta={`commercial-${placement}-email`}
          className="inline-flex min-h-12 max-w-full items-center rounded text-sm text-primary-800 underline decoration-primary-300 underline-offset-4 hover:text-primary-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-500"
        >
          <span className="break-all">{company.email}</span>
        </a>
      ) : null}
    </div>
  );
}
