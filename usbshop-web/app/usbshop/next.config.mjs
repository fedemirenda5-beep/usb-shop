/** @type {import("next").NextConfig} */
const nextConfig = {
  // Usar SSR para permitir rutas dinámicas y middleware
  // output: "export" removido para soporte de /admin routes dinámicas
  eslint: {
    ignoreDuringBuilds: true,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
