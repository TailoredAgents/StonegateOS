import { redirect } from "next/navigation";

export default function CrewRedirect() {
  redirect("/team?tab=calendar");
}
