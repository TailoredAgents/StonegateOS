import Link from "next/link";
import { Phone, Mail, Clock3, ArrowUpRight } from "lucide-react";
import { Button, Section } from "@myst-os/ui";
import { PublicPageIntro } from "@/components/public-site/PublicPageIntro";
import { getPublicCompanyProfile } from "@/lib/company";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata("contact");
export default function ContactPage() {
  const company = getPublicCompanyProfile();
  return (
    <Section className="public-page">
      <div className="public-page-stack space-y-8">
        <PublicPageIntro
          eyebrow="A real crew. An easy conversation."
          title="Let’s make room for what’s next."
          description="Have a question, an unusual item, or a pickup to plan? Call, text, or email us. We’re happy to help you find the right next step."
        />
        <div className="public-contact-grid">
          <div className="public-contact-card">
            <Phone size={28} strokeWidth={1.5} aria-hidden="true" />
            <h2>Call or text the crew</h2>
            <p>
              Talk through your pickup or text us photos of what needs to go.
            </p>
            <a href={`tel:${company.phoneE164}`}>{company.phoneDisplay}</a>
            <br />
            <a href={`sms:${company.phoneE164}`}>
              Send a text <ArrowUpRight size={16} aria-hidden="true" />
            </a>
          </div>
          <div className="public-contact-card">
            <Mail size={28} strokeWidth={1.5} aria-hidden="true" />
            <h2>Drop us a note</h2>
            <p>Tell us about your project, location, and preferred timing.</p>
            <a href={`mailto:${company.email}`}>{company.email}</a>
          </div>
          <div className="public-contact-card">
            <Clock3 size={28} strokeWidth={1.5} aria-hidden="true" />
            <h2>When we’re here</h2>
            <p>{company.hoursSummary}</p>
            <p className="mt-4">{company.serviceAreaSummary}</p>
          </div>
        </div>
        <div className="public-panel public-heading-row">
          <div>
            <h2 className="font-display text-3xl">Prefer to start online?</h2>
            <p className="mt-3 text-neutral-600">
              Tell us what needs to go and get an estimate for your pickup.
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/book">
              Get my instant quote <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </div>
    </Section>
  );
}
