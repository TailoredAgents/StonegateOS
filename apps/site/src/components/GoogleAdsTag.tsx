import { GoogleTag } from "./GoogleTag";

export function GoogleAdsTag({ tagId }: { tagId: string | null }) {
  return <GoogleTag ga4Id={null} googleAdsTagId={tagId} />;
}
