import type { MetadataRoute } from "next";
import { NAV } from "@/lib/site";

/* `output: "export"` needs this said out loud: the file is written once, at build. */
export const dynamic = "force-static";

const BASE = "https://standfast.ai";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE}/`, priority: 1 },
    ...NAV.map((item) => ({ url: `${BASE}${item.href}`, priority: 0.8 })),
  ];
}
