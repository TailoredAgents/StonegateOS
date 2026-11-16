import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  MapPin,
  ShieldCheck,
  Sofa,
  Refrigerator,
  Hammer,
  Bath,
  Package,
  Truck,
} from "lucide-react";
import { getOrderedServices } from "@/lib/content";

export function PublicPageIntro({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string | null;
  children?: ReactNode;
}) {
  return (
    <header className="public-page-intro">
      <p className="public-eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {description ? <p className="public-intro-copy">{description}</p> : null}
      {children}
    </header>
  );
}

export function PublicTrustStrip() {
  return (
    <div className="public-trust-strip" aria-label="Our service commitments">
      <span>
        <ShieldCheck size={18} aria-hidden="true" /> Licensed &amp; insured
      </span>
      <span>
        <Check size={18} aria-hidden="true" /> Price approved before pickup
      </span>
      <span>
        <MapPin size={18} aria-hidden="true" /> Locally based in Woodstock
      </span>
    </div>
  );
}

const serviceIcons = {
  furniture: Sofa,
  appliances: Refrigerator,
  "construction-debris": Hammer,
  "hot-tub": Bath,
  "single-item": Package,
};

export function PublicServiceGrid({
  commercial = true,
}: {
  commercial?: boolean;
}) {
  return (
    <div className="public-service-grid">
      {getOrderedServices().map((service) => {
        const Icon =
          serviceIcons[service.slug as keyof typeof serviceIcons] ?? Truck;
        return (
          <Link
            key={service.slug}
            href={`/services/${service.slug}`}
            className="public-service-card"
          >
            <span className="public-service-icon">
              <Icon size={27} strokeWidth={1.5} aria-hidden="true" />
            </span>
            <h3>{service.title}</h3>
            <p>{service.short}</p>
            <span className="public-card-link">
              Explore service <ArrowUpRight size={18} aria-hidden="true" />
            </span>
          </Link>
        );
      })}
      {commercial ? (
        <Link
          href="/contractors"
          className="public-service-card public-service-card-accent"
        >
          <span className="public-service-icon">
            <Truck size={27} strokeWidth={1.5} aria-hidden="true" />
          </span>
          <h3>Contractor services</h3>
          <p>
            Jobsite debris haul-off and light demolition support for your next
            project.
          </p>
          <span className="public-card-link">
            Let’s talk about your project{" "}
            <ArrowUpRight size={18} aria-hidden="true" />
          </span>
        </Link>
      ) : null}
    </div>
  );
}
