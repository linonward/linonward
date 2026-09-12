import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  transpilePackages: ["@linonward/editor"],
};

export default nextConfig;
