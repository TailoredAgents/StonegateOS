import plugin from "tailwindcss/plugin";

export const colors = {
  primary: {
    50: "#F8FAFC",
    100: "#F1F5F9",
    200: "#E2E8F0",
    300: "#CBD5E1",
    400: "#94A3B8",
    500: "#64748B",
    600: "#475569",
    900: "#0B1220",
    800: "#0F172A",
    700: "#1E293B"
  },
  accent: {
    600: "#14B8A6",
    500: "#2DD4BF",
    200: "#99F6E4"
  },
  sand: {
    300: "#F1E9D2",
    100: "#FAF7EF"
  },
  neutral: {
    50: "#F8FAFC",
    900: "#0F172A",
    800: "#1E293B",
    700: "#334155",
    500: "#64748B",
    400: "#94A3B8",
    300: "#CBD5E1",
    200: "#E2E8F0",
    100: "#F1F5F9"
  },
  feedback: {
    success: "#22C55E",
    warning: "#F59E0B",
    danger: "#EF4444"
  }
} as const;

export const gradients = {
  hero: "linear-gradient(135deg, #0F172A 0%, #14B8A6 100%)"
} as const;

export const typography = {
  fonts: {
    display: '"Playfair Display", "Times New Roman", serif',
    sans: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  },
  weights: {
    sans: {
      regular: 400,
      medium: 500,
      semibold: 600
    },
    display: {
      bold: 700
    }
  },
  scale: {
    h1: "clamp(2.25rem, 4vw + 1rem, 3.25rem)",
    h2: "clamp(1.75rem, 2.5vw + 0.5rem, 2.25rem)",
    body: "1rem",
    label: "0.875rem",
    overline: "0.75rem"
  }
} as const;

export const spacing = {
  none: "0px",
  xs: "4px",
  sm: "8px",
  md: "16px",
  lg: "24px",
  xl: "32px",
  "2xl": "48px",
  "3xl": "64px"
} as const;

export const radii = {
  sm: "10px",
  md: "16px",
  xl: "24px",
  pill: "999px"
} as const;

export const shadows = {
  soft: "0px 20px 40px rgba(15, 23, 42, 0.12)",
  float: "0px 35px 65px rgba(15, 23, 42, 0.18)"
} as const;

export const designTokens = {
  colors,
  gradients,
  typography,
  spacing,
  radii,
  shadows
} as const;

const cssVariableEntries = {
  ...Object.entries(colors.primary).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[`--color-primary-${key}`] = value;
    return acc;
  }, {}),
  ...Object.entries(colors.accent).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[`--color-accent-${key}`] = value;
    return acc;
  }, {}),
  ...Object.entries(colors.sand).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[`--color-sand-${key}`] = value;
    return acc;
  }, {}),
  ...Object.entries(colors.neutral).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[`--color-neutral-${key}`] = value;
    return acc;
  }, {}),
  "--color-success": colors.feedback.success,
  "--color-warning": colors.feedback.warning,
  "--color-danger": colors.feedback.danger,
  "--gradient-hero": gradients.hero,
  "--font-display": typography.fonts.display,
  "--font-sans": typography.fonts.sans,
  "--font-weight-sans-regular": typography.weights.sans.regular.toString(),
  "--font-weight-sans-medium": typography.weights.sans.medium.toString(),
  "--font-weight-sans-semibold": typography.weights.sans.semibold.toString(),
  "--font-weight-display-bold": typography.weights.display.bold.toString(),
  "--text-size-h1": typography.scale.h1,
  "--text-size-h2": typography.scale.h2,
  "--text-size-body": typography.scale.body,
  "--text-size-label": typography.scale.label,
  "--text-size-overline": typography.scale.overline,
  ...Object.entries(spacing).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[`--spacing-${key}`] = value;
    return acc;
  }, {}),
  "--radius-sm": radii.sm,
  "--radius-md": radii.md,
  "--radius-xl": radii.xl,
  "--radius-pill": radii.pill,
  "--shadow-soft": shadows.soft,
  "--shadow-float": shadows.float
};

export const createDesignSystemPlugin = () =>
  plugin(({ addBase }) => {
    addBase({
      ":root": {
        colorScheme: "light",
        ...cssVariableEntries
      }
    });
  });

export type DesignTokens = typeof designTokens;

