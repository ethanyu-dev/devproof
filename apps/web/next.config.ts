import type { NextConfig } from "next";
import { config as loadDotenv } from "dotenv";

for (const envPath of ["../../.env", ".env"]) {
  loadDotenv({ path: envPath, override: false, quiet: true });
}

const config: NextConfig = {
  env: {
    NEXT_PUBLIC_RUNTIME_API_URL:
      process.env.NEXT_PUBLIC_RUNTIME_API_URL ??
      process.env.BROWSER_RUNTIME_API_URL ??
      "http://localhost:4433",
  },
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@devproof/contracts", "@devproof/runtime-protocol"],
  async headers() {
    return [
      {
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
        source: "/(.*)",
      },
    ];
  },
};

export default config;
