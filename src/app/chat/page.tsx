'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Read from NEXT_PUBLIC_ envs (browser-safe)
const API = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8001';
const DEFAULT_COURSE_ID = process.env.NEXT_PUBLIC_PDES_COURSE_ID || '';

type Source = {
  marker: string;
  title?: string | null;
  url?: string | null;
  page?: number | null;
  score?: number | null;
  is_image?: boolean;
};

export default function ChatPage() {
  const [q, setQ] = useState('');
  const [courseId, setCourseId] = useState(DEFAULT_COURSE_ID);
  const [answer, setAnswer] = useState<string>('');
  const [sources, setSources] = useState<Source[]>([]);
  const [meta,   setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function ask() {
    if (!q.trim()) return;
    if (!courseId) { setErr('No course_id set'); return; }

    setLoading(true);
    setErr(null);
    setAnswer('');
    setSources([]);
    setMeta(null);

    try {
      const res = await fetch(`${API}/chat/ask`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': '22222222-2222-2222-2222-222222222222', // demo only
        },
        body: JSON.stringify({
          course_id: courseId,       // ← use state, not process.env
          question: q,
          assistance_level: 'novice',
          mode: 'worked',
        }),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setAnswer(data.answer || '');
      setSources(data.sources_dedup || data.sources || []);
      setMeta(data.meta || null);
    } catch (e: any) {
      setErr(e.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '2rem' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>Tutor Chat</h1>

      {/* Status banner — use the defined constants/state */}
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
        API: {API || <em>not set</em>} · Course: {courseId || <em>not set</em>}
      </div>

      {/* Optional course id input when missing */}
      {!courseId && (
        <input
          value={courseId}
          onChange={(e) => setCourseId(e.target.value)}
          placeholder="Paste course_id (UUID)"
          style={{ width: '100%', marginBottom: 8, padding: '8px', border: '1px solid #ddd', borderRadius: 6 }}
        />
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask about the course…"
          onKeyDown={(e) => (e.key === 'Enter' ? ask() : null)}
          style={{
            flex: 1,
            padding: '10px 12px',
            border: '1px solid #ddd',
            borderRadius: 8,
          }}
        />
        <button
          onClick={ask}
          disabled={loading}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid #ddd',
            background: loading ? '#f3f4f6' : '#fff',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? 'Asking…' : 'Ask'}
        </button>
      </div>

      {err && (
        <div style={{ color: '#b91c1c', marginBottom: 12 }}>
          {err}
        </div>
      )}

      {meta?.confidence?.label && (
        <div style={{ marginBottom: 12, fontSize: 14, color: '#374151' }}>
          Confidence: <strong>{meta.confidence.label}</strong>
          {meta.retrieval && (
            <>
              {' '}· chunks {meta.retrieval.chunks_used}, docs {meta.retrieval.docs_used}
              {' '}· mean score {meta.retrieval.score_mean}
            </>
          )}
        </div>
      )}

      {answer && (
        <article style={{ lineHeight: 1.6, marginBottom: 24 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {answer}
          </ReactMarkdown>
        </article>
      )}

      {sources?.length > 0 && (
        <section>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Sources</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {sources.map((s, i) => (
              <li key={i} style={{ marginBottom: 6, fontSize: 14 }}>
                <span style={{ color: '#6b7280', marginRight: 6 }}>{s.marker}</span>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
                    {s.title || 'Untitled'}
                  </a>
                ) : (
                  <span>{s.title || 'Untitled'}</span>
                )}
                {typeof s.page === 'number' ? <> — p.{s.page}</> : null}
                {typeof s.score === 'number' ? (
                  <span style={{ color: '#6b7280' }}> · score {s.score}</span>
                ) : null}
                {s.is_image && (
                  <span style={{
                    marginLeft: 8,
                    fontSize: 12,
                    padding: '2px 6px',
                    borderRadius: 6,
                    background: '#eff6ff',
                    color: '#1d4ed8'
                  }}>
                    image
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
