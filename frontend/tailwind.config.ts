import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
import typography from "@tailwindcss/typography";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        surface: "hsl(var(--surface))",
        elevated: "hsl(var(--elevated))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        success: "hsl(var(--success))",
        warning: "hsl(var(--warning))",
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
      keyframes: {
        "pulse-ring": { "0%": { boxShadow: "0 0 0 0 var(--ring-color)" }, "70%": { boxShadow: "0 0 0 10px transparent" }, "100%": { boxShadow: "0 0 0 0 transparent" } },
        shimmer: { "0%": { backgroundPosition: "-200% 0" }, "100%": { backgroundPosition: "200% 0" } },
        "typing-dot": { "0%, 80%, 100%": { opacity: "0.25", transform: "translateY(0)" }, "40%": { opacity: "1", transform: "translateY(-2px)" } },
        "dash-flow": { to: { strokeDashoffset: "-24" } },
        "fade-up": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        blink: { "0%, 50%": { opacity: "1" }, "51%, 100%": { opacity: "0" } },
      },
      animation: {
        "pulse-ring": "pulse-ring 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        shimmer: "shimmer 2.2s linear infinite",
        "typing-dot": "typing-dot 1.2s ease-in-out infinite",
        "dash-flow": "dash-flow 0.6s linear infinite",
        "fade-up": "fade-up 0.18s ease-out both",
        blink: "blink 1s step-end infinite",
      },
    },
  },
  plugins: [animate, typography],
} satisfies Config;
