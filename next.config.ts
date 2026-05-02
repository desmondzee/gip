import type { NextConfig } from "next"

const config: NextConfig = {
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
  },
}

export default config
