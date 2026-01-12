import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";
import typography from "@tailwindcss/typography";
import { createDesignSystemPlugin } from "../../packages/ui/src/theme/tokens";

const config: Config = {
  content: [
    "./src/**/*.{ts,tsx,mdx}",
    "../../packages/ui/src/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: "var(--color-primary-50)",
          100: "var(--color-primary-100)",
          200: "var(--color-primary-200)",
          300: "var(--color-primary-300)",
          400: "var(--color-primary-400)",
          500: "var(--color-primary-500)",
          600: "var(--color-primary-600)",
          900: "var(--color-primary-900)",
          800: "var(--color-primary-800)",
          700: "var(--color-primary-700)"
        },
        accent: {
          600: "var(--color-accent-600)",
          500: "var(--color-accent-500)",
          200: "var(--color-accent-200)"
        },
        sand: {
          300: "var(--color-sand-300)",
          100: "var(--color-sand-100)"
        },
        neutral: {
          50: "var(--color-neutral-50)",
          900: "var(--color-neutral-900)",
          800: "var(--color-neutral-800)",
          700: "var(--color-neutral-700)",
          500: "var(--color-neutral-500)",
          400: "var(--color-neutral-400)",
          300: "var(--color-neutral-300)",
          200: "var(--color-neutral-200)",
          100: "var(--color-neutral-100)"
        },
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        danger: "var(--color-danger)"
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "\"Playfair Display\"", "serif"]
      },
      fontSize: {
        display: "var(--text-size-h1)",
        headline: "var(--text-size-h2)",
        body: "var(--text-size-body)",
        label: "var(--text-size-label)",
        overline: "var(--text-size-overline)"
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        xl: "var(--radius-xl)",
        pill: "var(--radius-pill)"
      },
      spacing: {
        xs: "var(--spacing-xs)",
        sm: "var(--spacing-sm)",
        md: "var(--spacing-md)",
        lg: "var(--spacing-lg)",
        xl: "var(--spacing-xl)",
        "2xl": "var(--spacing-2xl)",
        "3xl": "var(--spacing-3xl)"
      },
      boxShadow: {
        soft: "var(--shadow-soft)",
        float: "var(--shadow-float)"
      },
      backgroundImage: {
        hero: "var(--gradient-hero)"
      }
    }
  },
  plugins: [createDesignSystemPlugin(), tailwindcssAnimate, typography]
};

export default config;
