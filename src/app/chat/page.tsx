'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import rehypeKatex from 'rehype-katex';

// ENV (browser-safe)
const API = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8001';
const DEFAULT_COURSE_ID = process.env.NEXT_PUBLIC_PDES_COURSE_ID || '';
const DEFAULT_USER_ID =
  process.env.NEXT_PUBLIC_DEMO_USER_ID || '22222222-2222-2222-2222-222222222222';

type Source = {
  marker: string;
  title?: string | null;
  url?: string | null;
  page?: number | null;
  score?: number | null;
  is_image?: boolean;
};

type Course = {
  id: string;
  name: string;
  term?: string | null;
};

const USE_MATH_NORMALIZER = true;

function normalizeMath(s: string) {
  if (!s) return s;
  // Only normalize if old LaTeX delimiters are present
  if (!(/\\\[|\\\]|\\\(|\\\)/.test(s))) return s;
  return s
    .replace(/\\\[/g, '$$').replace(/\\\]/g, '$$')
    .replace(/\\\(/g, '$').replace(/\\\)/g, '$');
}

function sanitizeInlineCitations(s: string) {
  // Replace [n](url) with [n] when it appears inside \text{...}
  return (s || '').replace(/\\text\{[^}]*\}/g, (block) =>
    block.replace(/\[([0-9]+)\]\([^)]+\)/g, '[$1]')
  );
}

function labelFromCourse(c?: Course) {
  if (!c) return '';
  return c.term ? `${c.name} — ${c.term}` : c.name;
}

export default function ChatPage() {
  // Chat state
  const [q, setQ] = useState('');
  const [courseId, setCourseId] = useState(DEFAULT_COURSE_ID);
  const [answer, setAnswer] = useState<string>('');
  const [sources, setSources] = useState<Source[]>([]);
  const [meta, setMeta] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [courseLabel, setCourseLabel] = useState<string>('');

  // Sidebar: user/courses + create form
  const [userId, setUserId] = useState(DEFAULT_USER_ID);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTerm, setNewTerm] = useState('');

  // --- Load the user's courses ---
  async function loadCourses() {
    if (!userId) return;
    try {
      setLoadingCourses(true);
      const res = await fetch(`${API}/courses`, {
        headers: { 'X-User-Id': userId },
      });
      if (!res.ok) throw new Error(await res.text());
      const rows: Course[] = await res.json();
      setCourses(rows);

      // If no selection OR selected course is not in this user's list,
      // auto-select the newest (first) course if present.
      if (!rows.find((c) => c.id === courseId)) {
        if (rows.length > 0) {
          setCourseId(rows[0].id);
        }
      }
    } catch (e: any) {
      console.warn('Failed to load courses:', e.message || e);
      setCourses([]);
    } finally {
      setLoadingCourses(false);
    }
  }

  // Create a course; name required, term optional ("")
  async function createCourse() {
    if (!userId) {
      alert('Please set your User ID (UUID) in the sidebar.');
      return;
    }
    if (!newName.trim()) return;
    try {
      setCreating(true);
      const res = await fetch(`${API}/courses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': userId,
        },
        body: JSON.stringify({ name: newName.trim(), term: newTerm || '' }),
      });
      if (!res.ok) throw new Error(await res.text());
      const row: Course = await res.json();

      // Update list (prepend if new), select it
      setCourses((prev) => {
        const exists = prev.find((c) => c.id === row.id);
        return exists ? prev : [row, ...prev];
      });
      setCourseId(row.id);
      setNewName('');
      setNewTerm('');
    } catch (e: any) {
      alert(`Create failed: ${e.message || e}`);
    } finally {
      setCreating(false);
    }
  }

  // Ask the RAG service
  async function ask() {
    if (!q.trim()) return;
    if (!userId) { setErr('No user id set'); return; }
    if (!courseId) { setErr('No course selected. Create or pick a course on the left.'); return; }

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
          'X-User-Id': userId,
        },
        body: JSON.stringify({
          course_id: courseId,
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
      const raw = data.answer || '';
      const withMath = USE_MATH_NORMALIZER ? normalizeMath(raw) : raw;
      const cleaned = sanitizeInlineCitations(withMath);
      setAnswer(cleaned);
      setSources(data.sources_dedup || data.sources || []);
      setMeta(data.meta || null);
    } catch (e: any) {
      setErr(e.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  // Load course list when page loads and whenever userId changes
  useEffect(() => {
    loadCourses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // Keep the pretty label in sync; tolerate 403 "Not your course"
  useEffect(() => {
    let cancelled = false;

    async function hydrateLabel() {
      if (!courseId) { setCourseLabel(''); return; }

      // If the selected course is in the local list, use that.
      const local = courses.find(c => c.id === courseId);
      if (local) {
        if (!cancelled) setCourseLabel(labelFromCourse(local));
        return;
      }

      // Otherwise, try fetching details (may 403 if not owned by user)
      try {
        const res = await fetch(`${API}/courses/${courseId}`, {
          headers: { 'X-User-Id': userId },
        });

        if (res.status === 403) {
          if (!cancelled) setCourseLabel('(not your course)');
          return;
        }
        if (!res.ok) throw new Error(await res.text());

        const c: Course = await res.json();
        if (!cancelled) setCourseLabel(labelFromCourse(c));
      } catch {
        if (!cancelled) setCourseLabel('(unknown course)');
      }
    }

    hydrateLabel();
    return () => { cancelled = true; };
  }, [API, userId, courseId, courses]);

  return (
    <main
      style={{
        display: 'flex',
        minHeight: '100vh',
        color: '#111827',
        background: '#fff',
      }}
    >
      {/* Sidebar */}
      <aside
        style={{
          width: 300,
          borderRight: '1px solid #e5e7eb',
          padding: '1rem',
          position: 'sticky',
          top: 0,
          alignSelf: 'flex-start',
          height: '100vh',
          overflowY: 'auto',
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
          Courses
        </h2>

        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6 }}>
            API: {API}
          </div>

          {/* User ID input */}
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="X-User-Id (UUID)"
            style={{
              width: '100%',
              padding: '6px 8px',
              border: '1px solid #ddd',
              borderRadius: 6,
              marginBottom: 10,
              fontSize: 12,
            }}
          />

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={loadCourses}
              disabled={loadingCourses || !userId}
              style={{
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid #ddd',
                background: loadingCourses ? '#f3f4f6' : '#fff',
                cursor: loadingCourses || !userId ? 'not-allowed' : 'pointer',
                fontSize: 12,
              }}
              title={!userId ? 'Set a user id first' : 'Refresh courses'}
            >
              {loadingCourses ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* Course list (boxes) */}
        <div style={{ marginBottom: 18 }}>
          {courses.length === 0 ? (
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              No courses yet.
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {courses.map((c) => (
                <li
                  key={c.id}
                  style={{
                    padding: '8px 10px',
                    border: '1px solid #eee',
                    borderRadius: 8,
                    marginBottom: 8,
                    background: c.id === courseId ? '#f0f9ff' : 'transparent',
                    cursor: 'pointer',
                  }}
                  onClick={() => setCourseId(c.id)}
                  title={c.id}
                >
                  <div style={{ fontSize: 14, fontWeight: 600 }}>
                    {c.name}
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    {c.term || '—'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Create course */}
        <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
            New course
          </h3>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (required)"
            style={{
              width: '100%',
              padding: '8px',
              border: '1px solid #ddd',
              borderRadius: 6,
              marginBottom: 8,
            }}
          />
          <input
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            placeholder='Term (optional, e.g. "Fall 2025")'
            style={{
              width: '100%',
              padding: '8px',
              border: '1px solid #ddd',
              borderRadius: 6,
              marginBottom: 8,
            }}
          />
          <button
            onClick={createCourse}
            disabled={!newName.trim() || creating || !userId}
            style={{
              width: '100%',
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid #ddd',
              background: creating ? '#f3f4f6' : '#fff',
              cursor:
                !newName.trim() || creating || !userId
                  ? 'not-allowed'
                  : 'pointer',
            }}
            title={!userId ? 'Set a user id first' : undefined}
          >
            {creating ? 'Creating…' : 'Create course'}
          </button>
        </div>
      </aside>

      {/* Chat area */}
      <section style={{ flex: 1, padding: '2rem', maxWidth: 900 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 12 }}>
          Tutor Chat
        </h1>

        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          Current course:{' '}
          {courseId ? (
            <strong>{courseLabel || <code>{courseId}</code>}</strong>
          ) : (
            <em>none selected</em>
          )}
        </div>

        {!courseId && (
          <input
            value={courseId}
            onChange={(e) => setCourseId(e.target.value)}
            placeholder="Paste course_id (UUID)"
            style={{
              width: '100%',
              marginBottom: 8,
              padding: '8px',
              border: '1px solid #ddd',
              borderRadius: 6,
            }}
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
            disabled={loading || !userId || !courseId}
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid #ddd',
              background: loading ? '#f3f4f6' : '#fff',
              cursor:
                loading || !userId || !courseId ? 'not-allowed' : 'pointer',
            }}
            title={
              !userId
                ? 'Set a user id first'
                : !courseId
                ? 'Select or create a course'
                : undefined
            }
          >
            {loading ? 'Asking…' : 'Ask'}
          </button>
        </div>

        {err && (
          <div style={{ color: '#b91c1c', marginBottom: 12 }}>{err}</div>
        )}

        {meta?.confidence?.label && (
          <div style={{ marginBottom: 12, fontSize: 14, color: '#374151' }}>
            Confidence: <strong>{meta.confidence.label}</strong>
            {meta.retrieval && (
              <>
                {' '}
                · chunks {meta.retrieval.chunks_used}, docs{' '}
                {meta.retrieval.docs_used} · mean score{' '}
                {meta.retrieval.score_mean}
              </>
            )}
          </div>
        )}

        {answer && (
          <article style={{ lineHeight: 1.6, marginBottom: 24 }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
            >
              {answer}
            </ReactMarkdown>
          </article>
        )}

        {sources?.length > 0 && (
          <section>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
              Sources
            </h2>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {sources.map((s, i) => (
                <li key={i} style={{ marginBottom: 6, fontSize: 14 }}>
                  <span style={{ color: '#6b7280', marginRight: 6 }}>
                    {s.marker}
                  </span>
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ textDecoration: 'underline' }}
                    >
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
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        padding: '2px 6px',
                        borderRadius: 6,
                        background: '#eff6ff',
                        color: '#1d4ed8',
                      }}
                    >
                      image
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </section>
    </main>
  );
}
