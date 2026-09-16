import { Button } from "@myst-os/ui";
import { getPublicCompanyProfile } from "@/lib/company";
import styles from "./CommercialTheme.module.css";

type CommercialContactActionsProps = {
  placement: string;
  compact?: boolean;
  showEmail?: boolean;
  textLabel?: string;
};

export function CommercialContactActions({
  placement,
  compact = false,
  showEmail = true,
  textLabel = "Text Us",
}: CommercialContactActionsProps) {
  const company = getPublicCompanyProfile();

  return (
    <div className={showEmail ? "space-y-3" : undefined}>
      <div className={compact ? "flex gap-2" : "flex flex-wrap gap-3"}>
        <Button
          asChild
          size={compact ? "md" : "lg"}
          className={`${styles["call"]} ${compact ? "min-h-12 flex-1 px-4" : "min-h-12"}`}
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
          className={`${styles["text"]} ${compact ? "min-h-12 flex-1 px-4" : "min-h-12"}`}
        >
          <a
            href={`sms:${company.phoneE164}`}
            data-cta={`commercial-${placement}-text`}
          >
            {textLabel}
          </a>
        </Button>
      </div>
      {showEmail ? (
        <a
          href={`mailto:${company.email}`}
          data-cta={`commercial-${placement}-email`}
          className={`${styles["email"]} inline-flex min-h-12 max-w-full items-center rounded text-sm underline underline-offset-4 hover:text-primary-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary-500`}
        >
          <span className="break-all">{company.email}</span>
        </a>
      ) : null}
    </div>
  );
}
