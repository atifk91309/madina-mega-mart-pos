import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true, // 👈 Tauri file:// me kabhi-kabhi route miss hota hai, is se fix ho jata hai
  images: {
    unoptimized: true,
  },
};

export default nextConfig;