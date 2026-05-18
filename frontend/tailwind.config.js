/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        heading: ["Oswald", "Impact", "sans-serif"],
        body: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
      },
      colors: {
        brand: {
          gold:    "#f5a521",   // brightest — highlights, CTAs, primary accent
          terra:   "#d85b3f",   // mid — gradients, hover, secondary elements
          crimson: "#901f4b",   // deepest — dark accents, borders, team red base
        },
        team: {
          red:  "#901f4b",
          blue: "#1A56A8",
        },
        card: {
          bg:        "#f0e4c8",
          text:      "#1a0a08",
          red:       "#901f4b",
          blue:      "#1A56A8",
          bystander: "#b89a6a",
          assassin:  "#181010",
        },
        // Black-based surfaces with the faintest warm undertone
        surface: {
          950: "#0c0608",
          900: "#110709",
          800: "#1a0c0e",
          700: "#241014",
          600: "#321520",
          500: "#4a1e2e",
        },
      },
      backgroundImage: {
        // Signature three-stop gradient — crimson → terracotta → gold
        "brand-gradient": "linear-gradient(135deg, #901f4b 0%, #d85b3f 55%, #f5a521 100%)",
        "brand-gradient-r": "linear-gradient(135deg, #f5a521 0%, #d85b3f 45%, #901f4b 100%)",
        // Radial warm glow — mirrors the box art's concentric rings
        "warm-glow": "radial-gradient(ellipse at 50% -5%, rgba(245,165,33,0.11) 0%, rgba(216,91,63,0.07) 30%, rgba(144,31,75,0.04) 55%, transparent 70%)",
        // Team headers
        "red-gradient":  "linear-gradient(135deg, #3d0a1e 0%, #901f4b 100%)",
        "blue-gradient": "linear-gradient(135deg, #0D2F6B 0%, #1A56A8 100%)",
      },
      keyframes: {
        "pulse-ring": {
          "0%":   { transform: "scale(1)",   opacity: "0.8" },
          "100%": { transform: "scale(1.7)", opacity: "0" },
        },
        "scan-line": {
          "0%":   { opacity: "0.4" },
          "50%":  { opacity: "1" },
          "100%": { opacity: "0.4" },
        },
        "shimmer": {
          "0%":   { backgroundPosition: "-200% center" },
          "100%": { backgroundPosition: "200% center" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 1.4s cubic-bezier(0.2, 0.6, 0.4, 1) infinite",
        "scan-line":  "scan-line 2s ease-in-out infinite",
        "shimmer":    "shimmer 2.5s linear infinite",
      },
    },
  },
  plugins: [],
};
