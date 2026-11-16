import Link from "next/link";
import { Suspense } from "react";
import { ArrowUpRight } from "lucide-react";
import { BeforeAfterSlider } from "@myst-os/ui";
import { HeroV2 } from "@/components/HeroV2";
import { LeadForm } from "@/components/LeadForm";
import { PublicServiceGrid, PublicTrustStrip } from "./PublicPageIntro";
import { homeFaqs, testimonials, transformationShowcases } from "./content";
import { getOrderedAreas } from "@/lib/content";
import { createPageMetadata } from "@/lib/metadata";

export const metadata = createPageMetadata("home");

export default function HomePage() {
  const areas = getOrderedAreas();
  const faqStructuredData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: homeFaqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: { "@type": "Answer", text: faq.answer },
    })),
  };
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqStructuredData) }}
      />
      <div className="public-container public-hero-wrap">
        <HeroV2 variant="full" />
        <PublicTrustStrip />
      </div>
      <section className="public-section">
        <div className="public-container">
          <div className="public-heading-row">
            <div className="public-section-heading">
              <p className="public-eyebrow">A little less on your to-do list</p>
              <h2>
                Big cleanout or one bulky item.
                <br />
                We’ll take it from here.
              </h2>
              <p>
                From the old sofa to a garage full of “someday.” Choose the
                pickup that fits your space.
              </p>
            </div>
            <Link className="public-text-link" href="/services">
              All our services <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <PublicServiceGrid />
        </div>
      </section>
      <section className="public-section public-section-tint">
        <div className="public-container">
          <div className="public-section-heading">
            <p className="public-eyebrow">Simple from start to swept clean</p>
            <h2>A clear plan. A clear price. A clear space.</h2>
          </div>
          <div className="public-steps">
            {[
              [
                "01",
                "Tell us what needs to go",
                "Get an estimate online. Tell us about your items and add photos to help us understand the job.",
              ],
              [
                "02",
                "Approve the price",
                "We confirm your scope and total before work begins. Additional items? You approve an updated quote first.",
              ],
              [
                "03",
                "Leave the lifting to us",
                "Choose a pickup window. We load, haul, and finish with a walkthrough of your cleared space.",
              ],
            ].map(([number, title, copy]) => (
              <div key={number} className="public-step">
                <span className="public-step-number">{number}</span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container">
          <div className="public-heading-row">
            <div className="public-section-heading">
              <p className="public-eyebrow">The space on the other side</p>
              <h2>Real pickups. A visible difference.</h2>
              <p>
                Recent residential cleanouts. Drag the sliders to see the before
                and after.
              </p>
            </div>
            <Link href="/gallery" className="public-text-link">
              See our work <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <div className="public-work-grid">
            {transformationShowcases.map((work) => (
              <article key={work.title}>
                <BeforeAfterSlider
                  beforeImage={work.beforeImage}
                  afterImage={work.afterImage}
                  alt={work.alt}
                  aspectRatio="4/3"
                  imageSizes="(min-width: 768px) 360px, 100vw"
                />
                <h3>{work.title}</h3>
                <p>{work.description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section className="public-section public-section-tint">
        <div className="public-container">
          <div className="public-heading-row">
            <div className="public-section-heading">
              <p className="public-eyebrow">Good neighbors. Good words.</p>
              <h2>A little peace of mind, from our customers.</h2>
            </div>
            <Link href="/reviews" className="public-text-link">
              Customer reviews <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <div className="public-review-grid">
            {testimonials.map((review) => (
              <figure className="public-review" key={review.name}>
                <div className="public-stars" aria-label="5 stars">
                  ★★★★★
                </div>
                <blockquote>“{review.quote}”</blockquote>
                <figcaption>
                  {review.name}
                  <span>{review.location}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>
      <section id="schedule-estimate" className="public-section scroll-mt-28">
        <div className="public-container public-split">
          <div className="public-section-heading">
            <p className="public-eyebrow">Your fresh start begins here</p>
            <h2>What can we take off your hands?</h2>
            <p>
              Tell us a little about your pickup to get an estimate. Book
              online, call us, or keep the quote for later.
            </p>
            <Link href="/pricing" className="public-text-link">
              Explore our pricing <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <Suspense fallback={<p role="status">Loading your quote form…</p>}>
            <LeadForm />
          </Suspense>
        </div>
      </section>
      <section className="public-section public-section-tint">
        <div className="public-container public-split">
          <div className="public-section-heading">
            <p className="public-eyebrow">Local crew. Nearby communities.</p>
            <h2>At home in North Metro Atlanta.</h2>
            <p>
              Based in Woodstock. We cover up to 25 miles for half-load jobs and
              larger, and up to 15 miles for minimum-pickup and quarter-load
              jobs.
            </p>
            <Link href="/areas" className="public-text-link">
              Check our coverage <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <div
            className="public-area-grid"
            style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
          >
            {areas.map((area) => (
              <Link
                key={area.slug}
                href={`/areas/${area.slug}`}
                className="public-area-link"
              >
                {area.city || "Cherokee County"}
                <ArrowUpRight size={17} aria-hidden="true" />
              </Link>
            ))}
          </div>
        </div>
      </section>
      <section className="public-section">
        <div className="public-container public-split">
          <div className="public-section-heading">
            <p className="public-eyebrow">Before we stop by</p>
            <h2>A few things you might be wondering.</h2>
            <p>Clear answers, from pricing to pickup.</p>
          </div>
          <div>
            {homeFaqs.map((faq) => (
              <details className="public-faq" key={faq.question}>
                <summary>{faq.question}</summary>
                <p>{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
