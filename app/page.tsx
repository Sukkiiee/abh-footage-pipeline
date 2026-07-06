import Dashboard from '@/components/Dashboard';

// Without this, Next.js has no reason to treat this page as anything but
// fully static (nothing here reads cookies/headers server-side -- all the
// dynamic logic happens client-side in Dashboard.tsx after mount), so it
// gets prerendered once and served with a long-lived cache header
// (observed: `s-maxage=31536000, stale-while-revalidate`, `x-nextjs-cache:
// HIT`). On a host fronted by a CDN (Render's is Cloudflare), that means
// the HTML -- and the hashed JS bundle filenames it references -- can keep
// getting served from cache well after a new deploy, so real client-side
// fixes silently don't reach users. Forcing dynamic rendering means every
// request gets freshly rendered HTML pointing at the current build.
export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <div className="container">
      <header className="app-header">
        <h1>ABH Footage Pipeline</h1>
        <span className="tag">Drive → Whisper → Claude → FCPXML / DOCX</span>
      </header>
      <Dashboard />
    </div>
  );
}
