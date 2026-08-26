import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The browser talks to the API through this origin; set per environment.
  env: { NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000' },
};

export default config;
