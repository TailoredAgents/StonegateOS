import { PartnerAccessHelp } from "./PartnerAccessHelp";
import type {
  PartnerOnboardingApplication,
  PartnerOnboardingRequirements,
} from "../lib/onboarding";

/** Compatibility only: self-service company application editing has been retired. */
export function PartnerApplicationWorkspace(_props: {
  initialApplication: PartnerOnboardingApplication;
  requirements: PartnerOnboardingRequirements;
  justVerified: boolean;
}) {
  return <PartnerAccessHelp />;
}
