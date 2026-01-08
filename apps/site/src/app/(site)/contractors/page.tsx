import Link from "next/link";
import type { Metadata } from "next";
import { Badge, Button, Card, Section } from "@myst-os/ui";
import { EstimateRequestForm } from "@/components/EstimateRequestForm";
import { absoluteUrl } from "@/lib/metadata";

const description =
  "Jobsite debris haul-off and light demo (non-structural) for remodels, siding, roofing, and build-outs across North Metro Atlanta. Request a time window and we’ll confirm.";

export const metadata: Metadata = {
  title: "Contractor haul-off + jobsite debris removal",
  description,
  openGraph: {
    title: "Contractor haul-off + jobsite debris removal",
    description,
    url: absoluteUrl("/contractors"),
    type: "website"
  },
  alternates: {
    canonical: absoluteUrl("/contractors")
  }
};

export default function ContractorsPage() {
  return (
    <Section>
      <div className="mx-auto max-w-5xl space-y-10">
        <header className="grid gap-6 lg:grid-cols-[1.1fr,0.9fr] lg:items-start">
          <div className="space-y-4">
            <Badge tone="highlight">For Contractors</Badge>
            <h1 className="font-display text-display text-primary-800">Jobsite debris haul‑off + light demo</h1>
            <p className="text-body text-neutral-600">
              Built for remodelers, construction crews, siding companies, roofing crews, and property turns. Pick a preferred day/time window — we’ll follow up to confirm.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild size="lg">
                <a href="#request-hauloff">Request an estimate</a>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <a href="tel:+14046920768">Call (404) 692-0768</a>
              </Button>
              <Button asChild size="lg" variant="ghost" className="border border-neutral-300/70 text-primary-800 hover:border-primary-300">
                <Link href="/services/construction-debris">Construction debris service details</Link>
              </Button>
            </div>
            <p className="text-xs text-neutral-500">
              Serving Woodstock and the surrounding North Metro Atlanta area.
            </p>
          </div>

          <Card className="space-y-4">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">What you can expect</p>
              <p className="text-lg font-semibold text-primary-900">Simple, jobsite‑friendly haul‑off</p>
            </div>
            <ul className="space-y-2 text-sm text-neutral-700">
              <li>On‑site loading + haul‑off (dumpster trailer)</li>
              <li>Volume‑based estimates and clear communication</li>
              <li>Sweep‑up and tidy where we load</li>
              <li>Same‑week availability when possible</li>
            </ul>
            <p className="text-xs text-neutral-500">
              No hazardous waste. If you have a special material, mention it in the notes and we’ll confirm.
            </p>
          </Card>
        </header>

        <section className="grid gap-6 md:grid-cols-3">
          <Card className="space-y-2">
            <p className="text-sm font-semibold text-primary-900">Construction debris haul‑off</p>
            <p className="text-sm text-neutral-600">
              Drywall, lumber, flooring, siding, tile, cabinets, and mixed jobsite debris — loaded and hauled in one visit.
            </p>
          </Card>
          <Card className="space-y-2">
            <p className="text-sm font-semibold text-primary-900">Light demo + haul‑off</p>
            <p className="text-sm text-neutral-600">
              Non‑structural demo support (like cabinets, flooring, or fixture removal) paired with fast cleanup and haul‑off.
            </p>
          </Card>
          <Card className="space-y-2">
            <p className="text-sm font-semibold text-primary-900">Property turns & cleanouts</p>
            <p className="text-sm text-neutral-600">
              Rental turns, investor cleanouts, and commercial spaces — clear the site so the next trade can start.
            </p>
          </Card>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <Card className="space-y-3">
            <p className="text-sm font-semibold text-primary-900">Common materials we haul</p>
            <ul className="grid gap-2 text-sm text-neutral-700 sm:grid-cols-2">
              <li>Drywall & insulation</li>
              <li>Lumber & framing scraps</li>
              <li>Flooring, carpet, padding</li>
              <li>Siding & trim</li>
              <li>Tile, bags, and demo debris</li>
              <li>Cabinets & fixtures</li>
              <li>Packaging & jobsite trash</li>
              <li>Mixed construction debris</li>
            </ul>
            <p className="text-xs text-neutral-500">
              Not sure? Tell us what it is and we’ll confirm what we can take.
            </p>
          </Card>

          <Card className="space-y-3">
            <p className="text-sm font-semibold text-primary-900">A faster alternative to dumpsters</p>
            <ul className="space-y-2 text-sm text-neutral-700">
              <li>One‑time pickups or repeat haul‑offs</li>
              <li>Keep the driveway and staging area clear</li>
              <li>Reduce jobsite clutter and trip hazards</li>
              <li>We load, haul, and clean up — your crew keeps building</li>
            </ul>
          </Card>
        </section>

        <Card className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">How it works</p>
            <h2 className="font-display text-2xl text-primary-900">3 simple steps</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-neutral-200 bg-white p-4">
              <p className="text-sm font-semibold text-primary-900">1) Tell us the scope</p>
              <p className="mt-1 text-sm text-neutral-600">
                Share the jobsite address and what you need hauled (and whether light demo is needed).
              </p>
            </div>
            <div className="rounded-2xl border border-neutral-200 bg-white p-4">
              <p className="text-sm font-semibold text-primary-900">2) Pick a time window</p>
              <p className="mt-1 text-sm text-neutral-600">
                Choose a preferred day/time window. We’ll follow up to confirm the exact arrival time.
              </p>
            </div>
            <div className="rounded-2xl border border-neutral-200 bg-white p-4">
              <p className="text-sm font-semibold text-primary-900">3) We haul it off</p>
              <p className="mt-1 text-sm text-neutral-600">
                On‑site loading, haul‑off, and a quick sweep‑up where we load.
              </p>
            </div>
          </div>
        </Card>

        <section id="request-hauloff" className="grid gap-6 lg:grid-cols-[1fr,1fr] lg:items-start">
          <div className="space-y-3">
            <h2 className="font-display text-3xl text-primary-900">Request a jobsite haul‑off estimate</h2>
            <p className="text-body text-neutral-600">
              Submit the jobsite address and preferred window. We’ll confirm details by text/call before any work is scheduled.
            </p>
            <p className="text-xs text-neutral-500">
              Tip: Include the debris type (drywall, siding, flooring, etc.) and access notes (stairs, gated entry, loading location) in the notes.
            </p>
          </div>
          <EstimateRequestForm className="lg:mt-1" context="contractor" initialServices={["construction-debris"]} />
        </section>
      </div>
    </Section>
  );
}
