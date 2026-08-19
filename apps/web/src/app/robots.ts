import type { MetadataRoute } from "next";

/* `output: "export"` needs this said out loud: the file is written once, at build. */
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://standfast.ai/sitemap.xml",
  };
}
