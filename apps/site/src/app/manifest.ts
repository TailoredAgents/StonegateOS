import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "StonegateOS Mobile",
    short_name: "StonegateOS",
    description: "Internal StonegateOS phone app for inbox, contacts, calendar, quotes, and daily work.",
    start_url: "/mobile",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      {
        src: "/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "any"
      },
      {
        src: "/favicon.png",
        sizes: "256x256",
        type: "image/png",
        purpose: "maskable"
      }
    ],
    categories: ["business", "productivity"]
  };
}
