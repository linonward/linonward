import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  transpilePackages: [
    "@linonward/content",
    "@linonward/database",
    "@linonward/editor",
    "@linonward/publishing",
  ],
};

export default nextConfig;
