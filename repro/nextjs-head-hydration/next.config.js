/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep this a plain, dependency-free repro: no extra plugins, no TypeScript
  // build step, nothing that could make hydration timing less predictable.
  reactStrictMode: false,
  // Don't let Next scribble AGENTS.md/CLAUDE.md into this directory.
  agentRules: false
};

module.exports = nextConfig;
