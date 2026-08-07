import type { NextConfig } from "next";
import { assertProductionRuntimeConfig } from "./src/lib/production-runtime-config";

assertProductionRuntimeConfig(process.env);

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
