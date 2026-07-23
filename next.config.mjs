/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdf-parse is used only by the local ingest script, never bundled into the app.
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
