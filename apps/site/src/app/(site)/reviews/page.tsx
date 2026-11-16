import { Section } from "@myst-os/ui";
import { ArrowUpRight } from "lucide-react";
import { PublicPageIntro } from "@/components/public-site/PublicPageIntro";
import { testimonials } from "@/components/public-site/content";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata("reviews");
export default function ReviewsPage() {
  const reviewsUrl =
    process.env["NEXT_PUBLIC_GOOGLE_BUSINESS_PROFILE_URL"]?.trim() ||
    "https://www.google.com/maps/place/Stonegate+Junk+Removal/@34.1041655,-84.462036,10z/data=!4m8!3m7!1s0x2077851b6c5fd83:0xddcf0b747e40a4ee!8m2!3d34.1041654!4d-84.462036!9m1!1b1!16s%2Fg%2F11yvx_5c88";
  return (
    <Section className="public-page">
      <div className="public-page-stack space-y-8">
        <PublicPageIntro
          eyebrow="From the people we’ve helped"
          title="Good work leaves a good impression."
          description="Customer experiences from local pickups. The same care, communication, and follow-through we aim to bring to your home."
        />
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
        <div className="public-panel public-heading-row">
          <div>
            <h2 className="text-xl font-semibold">
              More stories, straight from our customers.
            </h2>
            <p className="mt-2 text-sm text-neutral-600">
              Read the reviews or share your own experience with the crew.
            </p>
          </div>
          <a
            className="public-text-link"
            href={reviewsUrl}
            target="_blank"
            rel="noreferrer"
          >
            Visit Google reviews <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        </div>
      </div>
    </Section>
  );
}
