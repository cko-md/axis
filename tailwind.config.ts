import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      spacing: {
        "0":  "0px",
        "1":  "6px",
        "2":  "10px",
        "3":  "14px",
        "4":  "20px",
        "5":  "26px",
        "6":  "34px",
        "8":  "48px",
        "10": "60px",
        "12": "72px",
        "16": "96px",
        "20": "120px",
        "24": "144px",
      },
      borderRadius: {
        DEFAULT: "var(--r)",
        none:    "0",
        sm:      "var(--r)",
        md:      "var(--r)",
        lg:      "var(--rl)",
        xl:      "var(--rl)",
        full:    "9999px",
        axis:    "var(--r)",
      },
      fontFamily: {
        sans:  ["var(--font-sans)",   "system-ui", "sans-serif"],
        serif: ["var(--font-serif)",  "Georgia",   "serif"],
        mono:  ["var(--font-mono)",   "monospace"],
      },
      colors: {
        bg:      "var(--bg)",
        surface: "var(--surface)",
        ink:     "var(--ink)",
        accent:         "var(--accent)",
        "accent-bright": "var(--accent-bright)",
        "accent-deep":   "var(--accent-deep)",
        gold:    "var(--gold)",
        marine:  "var(--marine)",
        clay:    "var(--clay)",
        up:      "var(--up)",
        down:    "var(--down)",
        spark:   "var(--spark)",
        dew:     "var(--dew)",
        "dew-warm": "var(--dew-warm)",
      },
    },
  },
  plugins: [],
};

export default config;
