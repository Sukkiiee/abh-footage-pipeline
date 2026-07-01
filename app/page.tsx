import Dashboard from '@/components/Dashboard';

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
