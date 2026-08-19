import type { NextConfig } from "next";

/**
 * The site is entirely static: no database, no API call, no analytics, no
 * third-party script. `output: "export"` is what keeps it that way — a page
 * that needed a server would fail the build rather than quietly start needing
 * one, and the whole site can be served from any bucket.
 */
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default config;
