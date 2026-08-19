/**
 * Tailwind v4 is the only PostCSS plugin here on purpose: the design tokens in
 * `src/app/globals.css` are the single source for colour, type and spacing, and
 * a second transform in this chain would be a second place to look for them.
 */
const config = {
  plugins: { "@tailwindcss/postcss": {} },
};

export default config;
