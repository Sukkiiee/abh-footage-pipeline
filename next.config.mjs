/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Keep these packages un-bundled so their native binaries / postinstall
    // paths resolve correctly at runtime in the serverless function.
    serverComponentsExternalPackages: [
      'fluent-ffmpeg',
      'ffmpeg-static',
      '@ffprobe-installer/ffprobe',
      'googleapis',
      'openai',
      '@anthropic-ai/sdk',
      'docx'
    ],
    // Make sure the ffmpeg/ffprobe binaries get traced into the
    // Vercel serverless function output (they're loaded via fs paths, not
    // require(), so Next's default tracing can miss them otherwise).
    outputFileTracingIncludes: {
      'app/api/pipeline/run/route': [
        './node_modules/ffmpeg-static/**',
        './node_modules/@ffprobe-installer/**'
      ]
    }
  }
};

export default nextConfig;
