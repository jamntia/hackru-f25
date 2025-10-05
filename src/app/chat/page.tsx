'use client';

import { useEffect, useState } from 'react';
import Head from 'next/head';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

// ───────────────────────────────────────────────────────────────
// Config (browser-safe envs)
const API = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:8001';
const DEFAULT_COURSE_ID = process.env.NEXT_PUBLIC_PDES_COURSE_ID || '';
const DEFAULT_USER_ID =
  process.env.NEXT_PUBLIC_DEMO_USER_ID || '22222222-2222-2222-2222-222222222222';

// Optional Supabase (auth without backend token verification)
let supabase: import('@supabase/supabase-js').SupabaseClient | null = null;
try {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (SUPABASE_URL && SUPABASE_ANON) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
} catch { /* ignore */ }

// ───────────────────────────────────────────────────────────────
// Theme
const theme = {
  primary: '#b984bd',
  primaryHover: '#a870ad',
  text: '#1f2937',
  bg: '#faf7fb',
  panel: '#ffffff',
  border: '#e5e7eb',
  subtle: '#6b7280',
  activeRow: '#f6eff7',
};

// ───────────────────────────────────────────────────────────────
// Types
type Source = {
  marker: string;
  title?: string | null;
  url?: string | null;
  page?: number | null;
  score?: number | null;
  is_image?: boolean;
};
type Course = { id: string; name: string; term?: string | null };

// ───────────────────────────────────────────────────────────────
// Utilities
const USE_MATH_NORMALIZER = true;

function normalizeMath(s: string) {
  if (!s) return s;
  if (!(/\\\[|\\\]|\\\(|\\\)/.test(s))) return s;
  return s.replace(/\\\[/g, '$$').replace(/\\\]/g, '$$')
          .replace(/\\\(/g, '$').replace(/\\\)/g, '$');
}
function sanitizeInlineCitations(s: string) {
  return (s || '').replace(/\\text\{[^}]*\}/g, (block) =>
    block.replace(/\[([0-9]+)\]\([^)]+\)/g, '[$1]')
  );
}
function labelFromCourse(c?: Course) {
  if (!c) return '';
  return c.term ? `${c.name} — ${c.term}` : c.name;
}

// ───────────────────────────────────────────────────────────────
// Notes uploader
function NotesUploader({
  API, userId, courseId,
}: { API: string; userId: string; courseId: string; }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'pdf' | 'image'>('pdf');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setMsg(null); setErr(null);
    setFile(e.target.files?.[0] || null);
  }

  async function onUpload() {
    setMsg(null); setErr(null);
    if (!userId) return setErr('Set a user id first.');
    if (!courseId) return setErr('Pick or create a course first.');
    if (!file) return setErr('Choose a file to upload.');
    if (kind === 'pdf') {
      const name = file.name.toLowerCase();
      const isPdf = file.type === 'application/pdf' || name.endsWith('.pdf');
      if (!isPdf) return setErr('Please choose a .pdf file.');
      if (file.size > 100 * 1024 * 1024) return setErr('PDF too large (>100MB).');
    }

    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('course_id', courseId);
      fd.append('file', file);

      const endpoint = kind === 'pdf' ? '/upload/pdf' : '/upload/image';
      const res = await fetch(`${API}${endpoint}`, {
        method: 'POST',
        headers: { 'X-User-Id': userId },
        body: fd,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      setMsg(kind === 'pdf' ? 'PDF ingested ✅' : 'Image ingested ✅');
      setFile(null);
    } catch (e: any) {
      setErr(e.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  const chip = (active: boolean) => ({
    padding: '6px 10px',
    borderRadius: 16,
    border: `1px solid ${theme.border}`,
    background: active ? theme.activeRow : '#fff',
    fontSize: 12,
    cursor: 'pointer',
  } as const);

  return (
    <div style={{ borderTop: `1px solid ${theme.border}`, paddingTop: 12, marginTop: 12 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          width: '100%', textAlign: 'left', padding: '10px 12px',
          borderRadius: 10, border: `1px solid ${theme.border}`,
          background: theme.panel, fontWeight: 600,
        }}
      >
        {open ? '▾ ' : '▸ '}Upload notes
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button onClick={() => { setKind('pdf'); setFile(null); setErr(null); setMsg(null); }} style={chip(kind === 'pdf')}>PDF</button>
            <button onClick={() => { setKind('image'); setFile(null); setErr(null); setMsg(null); }} style={chip(kind === 'image')}>Image</button>
          </div>

          <input
            type="file"
            accept={kind === 'pdf' ? 'application/pdf' : 'image/*'}
            onChange={onPick}
            style={{
              width: '100%', padding: '8px', border: `1px solid ${theme.border}`,
              borderRadius: 10, marginBottom: 8, background: '#fff',
            }}
          />

          <button
            onClick={onUpload}
            disabled={uploading || !file || !userId || !courseId}
            title={!userId ? 'Set a user id first' : !courseId ? 'Select or create a course' : undefined}
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: `1px solid ${theme.primary}`, background: theme.primary, color: '#fff',
              cursor: uploading || !file || !userId || !courseId ? 'not-allowed' : 'pointer',
              fontWeight: 600,
            }}
          >
            {uploading ? 'Uploading…' : `Upload ${kind}`}
          </button>

          {msg && <div style={{ color: '#065f46', marginTop: 8, fontSize: 12 }}>{msg}</div>}
          {err && <div style={{ color: '#b91c1c', marginTop: 8, fontSize: 12 }}>{err}</div>}

          <div style={{ color: theme.subtle, marginTop: 8, fontSize: 11 }}>
            {kind === 'pdf'
              ? 'PDF only • max ~100MB • server validates %PDF header'
              : 'PNG/JPG/etc • normalized server-side'}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────
// Page
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
  const [lockedByAuth, setLockedByAuth] = useState(false);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTerm, setNewTerm] = useState('');

  // Supabase session → userId (optional)
  useEffect(() => {
    if (!supabase) return;
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      const uid = data.session?.user?.id;
      if (mounted && uid) { setUserId(uid); setLockedByAuth(true); }
    });
    const { data } = supabase.auth.onAuthStateChange((_e, session) => {
      const uid = session?.user?.id;
      if (uid) { setUserId(uid); setLockedByAuth(true); }
      else { setLockedByAuth(false); }
    });

    return () => { mounted = false; data?.subscription?.unsubscribe(); };
  }, []);

  // Load courses
  async function loadCourses() {
    if (!userId) return;
    try {
      setLoadingCourses(true);
      const res = await fetch(`${API}/courses`, { headers: { 'X-User-Id': userId } });
      if (!res.ok) throw new Error(await res.text());
      const rows: Course[] = await res.json();
      setCourses(rows);
      if (!rows.find(c => c.id === courseId) && rows.length > 0) {
        setCourseId(rows[0].id);
      }
    } catch (e: any) {
      console.warn('Failed to load courses:', e.message || e);
      setCourses([]);
    } finally {
      setLoadingCourses(false);
    }
  }

  // Create a course
  async function createCourse() {
    if (!userId) { alert('Please set your User ID (UUID) in the sidebar.'); return; }
    if (!newName.trim()) return;
    try {
      setCreating(true);
      const res = await fetch(`${API}/courses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify({ name: newName.trim(), term: newTerm || '' }),
      });
      if (!res.ok) throw new Error(await res.text());
      const row: Course = await res.json();
      setCourses(prev => (prev.find(c => c.id === row.id) ? prev : [row, ...prev]));
      setCourseId(row.id);
      setNewName(''); setNewTerm('');
    } catch (e: any) {
      alert(`Create failed: ${e.message || e}`);
    } finally {
      setCreating(false);
    }
  }

  // Ask
  async function ask() {
    if (!q.trim()) return;
    if (!userId) { setErr('No user id set'); return; }
    if (!courseId) { setErr('No course selected. Create or pick a course on the left.'); return; }

    setLoading(true); setErr(null);
    setAnswer(''); setSources([]); setMeta(null);

    try {
      const res = await fetch(`${API}/chat/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': userId },
        body: JSON.stringify({
          course_id: courseId,
          question: q,
          assistance_level: 'novice',
          mode: 'worked',
        }),
      });
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`);
      const data = await res.json();
      const raw = data.answer || '';
      const withMath = USE_MATH_NORMALIZER ? normalizeMath(raw) : raw;
      const cleaned = sanitizeInlineCitations(withMath);
      setAnswer(cleaned);
      setSources(data.sources_dedup || data.sources || []);
      setMeta(data.meta || null);
      setQ('');
    } catch (e: any) {
      setErr(e.message || 'Request failed');
    } finally {
      setLoading(false);
    }
  }

  // Effects
  useEffect(() => { loadCourses(); /* eslint-disable-next-line */ }, [userId]);

  useEffect(() => {
    let cancelled = false;
    async function hydrateLabel() {
      if (!courseId) { setCourseLabel(''); return; }
      const local = courses.find(c => c.id === courseId);
      if (local) { if (!cancelled) setCourseLabel(labelFromCourse(local)); return; }
      try {
        const res = await fetch(`${API}/courses/${courseId}`, { headers: { 'X-User-Id': userId } });
        if (res.status === 403) { if (!cancelled) setCourseLabel('(not your course)'); return; }
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

  // ───────────────────────────────────────────────────────────────
  // UI (no “scroll below website”: clamp to viewport)
  return (
    <>
      <Head>
        <title>CourseForge — AI Tutor Chatbot</title>
        <meta name="theme-color" content={theme.primary} />
      </Head>

      <main
        style={{
          display: 'flex',
          height: '100dvh',          // clamp to viewport
          overflow: 'hidden',        // prevent body scrolling past
          color: theme.text,
          background: theme.bg,
        }}
      >
        {/* Sidebar */}
        <aside
          style={{
            width: 300,
            borderRight: `1px solid ${theme.border}`,
            padding: '1rem',
            background: theme.panel,
            overflowY: 'auto',       // sidebar scrolls independently
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 10, color: theme.primary }}>
            CourseForge.ai
          </h2>

          {/* User ID (hidden when Supabase session exists) */}
          {!lockedByAuth && (
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="X-User-Id (UUID)"
              style={{
                width: '100%',
                padding: '8px 10px',
                border: `1px solid ${theme.border}`,
                borderRadius: 10,
                marginBottom: 10,
                fontSize: 12,
                background: '#fff',
              }}
            />
          )}

          {lockedByAuth && (
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: 10, fontSize: 12, color: theme.subtle,
            }}>
              <div>Signed in as <code>{userId.slice(0, 8)}…</code></div>
              <button
                onClick={async () => { await supabase?.auth.signOut(); }}
                style={{
                  fontSize: 12, padding: '4px 8px', border: `1px solid ${theme.border}`,
                  borderRadius: 8, background: '#fff', cursor: 'pointer'
                }}
              >
                Sign out
              </button>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <button
              onClick={loadCourses}
              disabled={loadingCourses || !userId}
              style={{
                padding: '8px 12px',
                borderRadius: 10,
                border: `1px solid ${theme.primary}`,
                background: loadingCourses ? theme.activeRow : theme.primary,
                color: '#fff',
                cursor: loadingCourses || !userId ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
              title={!userId ? 'Set a user id first' : 'Refresh courses'}
            >
              {loadingCourses ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {/* Course list */}
          <div style={{ marginBottom: 18 }}>
            {courses.length === 0 ? (
              <div style={{ fontSize: 12, color: theme.subtle }}>No courses yet.</div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {courses.map((c) => (
                  <li
                    key={c.id}
                    style={{
                      padding: '10px 12px',
                      border: `1px solid ${theme.border}`,
                      borderRadius: 12,
                      marginBottom: 8,
                      background: c.id === courseId ? theme.activeRow : '#fff',
                      cursor: 'pointer',
                      boxShadow: c.id === courseId ? '0 1px 0 rgba(0,0,0,0.03)' : 'none',
                    }}
                    onClick={() => setCourseId(c.id)}
                    title={c.id}
                  >
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{c.name}</div>
                    <div style={{ fontSize: 12, color: theme.subtle }}>{c.term || '—'}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Uploader + Create course */}
          <NotesUploader API={API} userId={userId} courseId={courseId} />

          <h3 style={{ fontSize: 14, fontWeight: 700, margin: '12px 0 8px' }}>
            New course
          </h3>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name (required)"
            style={{
              width: '100%', padding: '8px 10px', border: `1px solid ${theme.border}`,
              borderRadius: 10, marginBottom: 8, background: '#fff',
            }}
          />
          <input
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            placeholder='Term (optional, e.g. "Fall 2025")'
            style={{
              width: '100%', padding: '8px 10px', border: `1px solid ${theme.border}`,
              borderRadius: 10, marginBottom: 8, background: '#fff',
            }}
          />
          <button
            onClick={createCourse}
            disabled={!newName.trim() || creating || !userId}
            style={{
              width: '100%', padding: '10px 12px', borderRadius: 10,
              border: `1px solid ${theme.primary}`, background: theme.primary, color: '#fff',
              cursor: !newName.trim() || creating || !userId ? 'not-allowed' : 'pointer',
              fontWeight: 700,
            }}
            title={!userId ? 'Set a user id first' : undefined}
          >
            {creating ? 'Creating…' : 'Create course'}
          </button>
        </aside>

        {/* Chat column */}
        <section
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            background: theme.bg,
          }}
        >
          {/* Header */}
          <div style={{
            padding: '18px 24px',
            borderBottom: `1px solid ${theme.border}`,
            background: theme.panel,
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: theme.primary }}>
              CourseForge.ai — Tutor Chat
            </h1>
            <div style={{ fontSize: 12, color: theme.subtle, marginTop: 6 }}>
              Current course:{' '}
              {courseId ? <strong>{courseLabel || <code>{courseId}</code>}</strong> : <em>none selected</em>}
            </div>
          </div>

          {/* Feed (scrolls), then Composer sticks at bottom */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
            {err && (
              <div style={{ color: '#b91c1c', marginBottom: 12 }}>{err}</div>
            )}

            {meta?.confidence?.label && (
              <div style={{ marginBottom: 12, fontSize: 14, color: theme.text }}>
                Confidence: <strong>{meta.confidence.label}</strong>
                {meta.retrieval && (
                  <> · chunks {meta.retrieval.chunks_used}, docs {meta.retrieval.docs_used} · mean score {meta.retrieval.score_mean}</>
                )}
              </div>
            )}

            {answer && (
              <article style={{
                lineHeight: 1.7, marginBottom: 18,
                background: theme.panel, border: `1px solid ${theme.border}`,
                borderRadius: 12, padding: '16px 18px',
                boxShadow: '0 1px 0 rgba(0,0,0,0.03)',
              }}>
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {answer}
                </ReactMarkdown>
              </article>
            )}

            {sources?.length > 0 && (
              <section style={{
                background: theme.panel, border: `1px solid ${theme.border}`,
                borderRadius: 12, padding: '12px 14px',
              }}>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8, color: theme.text }}>
                  Sources
                </h2>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {sources.map((s, i) => (
                    <li key={i} style={{ marginBottom: 6, fontSize: 14 }}>
                      <span style={{ color: theme.subtle, marginRight: 6 }}>{s.marker}</span>
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', color: theme.primary }}>
                          {s.title || 'Untitled'}
                        </a>
                      ) : (
                        <span>{s.title || 'Untitled'}</span>
                      )}
                      {typeof s.page === 'number' ? <> — p.{s.page}</> : null}
                      {typeof s.score === 'number' ? (
                        <span style={{ color: theme.subtle }}> · score {s.score}</span>
                      ) : null}
                      {s.is_image && (
                        <span style={{
                          marginLeft: 8, fontSize: 12, padding: '2px 6px',
                          borderRadius: 6, background: theme.activeRow, color: theme.primary,
                          border: `1px solid ${theme.border}`
                        }}>
                          image
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/* Composer (fixed to bottom of the chat column) */}
          <div style={{
            padding: '12px 24px',
            borderTop: `1px solid ${theme.border}`,
            background: '#fff',
          }}>
            {!courseId && (
              <input
                value={courseId}
                onChange={(e) => setCourseId(e.target.value)}
                placeholder="Paste course_id (UUID)"
                style={{
                  width: '100%', marginBottom: 8, padding: '10px 12px',
                  border: `1px solid ${theme.border}`, borderRadius: 10, background: '#fff',
                }}
              />
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Ask about the course…"
                onKeyDown={(e) => (e.key === 'Enter' ? ask() : null)}
                style={{
                  flex: 1, padding: '12px 14px',
                  border: `1px solid ${theme.border}`, borderRadius: 12, background: '#fff',
                }}
              />
              <button
                onClick={ask}
                disabled={loading || !userId || !courseId}
                title={!userId ? 'Set a user id first' : !courseId ? 'Select or create a course' : undefined}
                style={{
                  padding: '12px 16px',
                  borderRadius: 12,
                  border: `1px solid ${theme.primary}`,
                  background: loading ? theme.activeRow : theme.primary,
                  color: '#fff',
                  cursor: loading || !userId || !courseId ? 'not-allowed' : 'pointer',
                  fontWeight: 700,
                }}
              >
                {loading ? 'Asking…' : 'Ask'}
              </button>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
