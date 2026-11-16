import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@myst-os/ui";
import { getPublicCompanyProfile } from "@/lib/company";
import { CookieSettingsButton } from "@/components/CookieSettingsButton";

export function Footer() {
  const company = getPublicCompanyProfile();
  return (
    <footer className="public-footer">
      <div className="public-container">
        <div className="public-footer-cta">
          <div>
            <p className="public-eyebrow">Make room for what’s next</p>
            <h2>Ready to reclaim your space?</h2>
            <p>Tell us what needs to go. We’ll help with the rest.</p>
          </div>
          <Button asChild size="lg" className="public-hero-primary">
            <Link href="/book">
              Get my instant quote <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </Button>
        </div>
        <div className="public-footer-grid">
          <div>
            <h3>{company.name}</h3>
            <p>
              Careful work. Clear communication.
              <br />A fresh start for your space.
            </p>
            <p className="mt-4">
              Based in {company.hqCity}, {company.hqState}.<br />
              {company.serviceAreaSummary}
            </p>
          </div>
          <nav aria-label="Explore Stonegate">
            <h3>Explore</h3>
            <Link href="/services">Our services</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/areas">Service areas</Link>
            <Link href="/gallery">Our work</Link>
            <Link href="/reviews">Customer reviews</Link>
            <Link href="/about">About us</Link>
            <Link href="/blog">Tips &amp; guides</Link>
          </nav>
          <nav aria-label="Contact Stonegate">
            <h3>Let’s talk</h3>
            <a href={`tel:${company.phoneE164}`} data-cta="footer-call">
              {company.phoneDisplay}
            </a>
            <a href={`sms:${company.phoneE164}`}>Text the crew</a>
            <a href={`mailto:${company.email}`}>{company.email}</a>
            <Link href="/contact">Contact us</Link>
            <p className="mt-4">{company.hoursSummary}</p>
          </nav>
          <nav aria-label="Partner resources">
            <h3>Work with us</h3>
            <Link href="/contractors">Contractor services</Link>
            <Link href="/partners">For partners</Link>
            <Link href="/partners/login">Partner sign in</Link>
            <Link href="/partners/request-access">
              Partner access &amp; help
            </Link>
            <Link href="/estimate">On-site estimates</Link>
          </nav>
        </div>
        <div className="public-footer-legal">
          <p>
            © {new Date().getFullYear()} {company.name}. Licensed &amp;
            insured.
          </p>
          <nav aria-label="Legal">
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/service-agreement">Service agreement</Link>
            <CookieSettingsButton />
          </nav>
        </div>
      </div>
    </footer>
  );
}
