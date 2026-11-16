import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, MapPin } from "lucide-react";
import { Button } from "@myst-os/ui";

export function PublicPickupCard({ local = false }: { local?: boolean }) {
  return (
    <aside className="public-pickup-card">
      <div className="public-pickup-image">
        <Image
          src="/images/gallery/trailer_16x9.jpg"
          alt="Stonegate’s trailer ready for a local junk removal pickup"
          fill
          sizes="(min-width: 768px) 440px, 100vw"
          className="object-cover"
        />
      </div>
      <div className="public-pickup-copy">
        <p className="public-eyebrow">
          <MapPin size={15} aria-hidden="true" /> Based in Woodstock
        </p>
        <h2>
          {local
            ? "A local crew, ready to help."
            : "You point. We take care of the rest."}
        </h2>
        <p>
          {local
            ? "Coverage extends up to 25 miles for half-load jobs and larger, and 15 miles for smaller pickups. Share your ZIP code to check your location."
            : "Tell us what needs to go. We confirm the scope and price before we start, then take care of the lifting and loading."}
        </p>
        <Button asChild className="w-full">
          <Link href="/book">
            Get my instant quote <ArrowUpRight size={17} aria-hidden="true" />
          </Link>
        </Button>
        <Link href="/estimate" className="public-text-link">
          Prefer an on-site estimate?
        </Link>
      </div>
    </aside>
  );
}
