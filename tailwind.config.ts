import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        serif: ["var(--font-serif)", "Georgia", "serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        ink: "var(--ink)",
        /* primary — iris (swatch 2) */
        accent: "var(--accent)",
        "accent-bright": "var(--accent-bright)",
        "accent-deep": "var(--accent-deep)",
        /* secondary — violet (3) + coral (5) */
        "accent-2": "var(--accent-2)",
        "accent-violet": "var(--accent-violet)",
        "accent-coral": "var(--accent-coral)",
        "accent-magenta": "var(--accent-magenta)",
        /* spark — live/sync only (swatch 1) */
        spark: "var(--spark)",
        /* dew — semantic highlights (swatch 4) */
        dew: "var(--dew)",
        "dew-warm": "var(--dew-warm)",
        up: "var(--up)",
        down: "var(--down)",
      },
      borderRadius: {
        axis: "var(--r)",
      },
    },
  },
  plugins: [],
};

export default config;
