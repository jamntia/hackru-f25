'use client';

import { useEffect, useState } from 'react';
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

// Optional Supabase (auth without backend token verification).
// If envs not set, the rest still works with manual userId input.
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
} catch { /* ignore; manual user id will be used */ }

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

type Course = {
    id: string;
    name: string;
    term?: string | null;
};

// ───────────────────────────────────────────────────────────────
// Utilities
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

// ───────────────────────────────────────────────────────────────
// Component
function NotesUploader({
    API,
    userId,
    courseId,
}: {
    API: string;
    userId: string;
    courseId: string;
}) {
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<'pdf' | 'image'>('pdf');
    const [file, setFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    function onPick(e: React.ChangeEvent<HTMLInputElement>) {
        setMsg(null);
        setErr(null);
        setFile(e.target.files?.[0] || null);
    }

    async function onUpload() {
        setMsg(null);
        setErr(null);

        if (!userId) return setErr('Set a user id first.');
        if (!courseId) return setErr('Pick or create a course first.');
        if (!file) return setErr('Choose a file to upload.');

        // Light client-side guardrails
        if (kind === 'pdf') {
            const name = file.name.toLowerCase();
            const isPdf =
                file.type === 'application/pdf' || name.endsWith('.pdf');
            if (!isPdf) return setErr('Please choose a .pdf file.');
            // optional: match your server limit (100 MB)
            if (file.size > 100 * 1024 * 1024)
                return setErr('PDF too large (>100MB).');
        }

        setUploading(true);
        try {
            const fd = new FormData();
            fd.append('course_id', courseId);
            fd.append('file', file);

            const endpoint = kind === 'pdf' ? '/upload/pdf' : '/upload/image';
            const res = await fetch(`${API}${endpoint}`, {
                method: 'POST',
                headers: { 'X-User-Id': userId }, // your service reads this
                body: fd, // DO NOT set Content-Type; browser sets boundary
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

    return (
        <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 12, marginTop: 12 }}>
            <button
                onClick={() => setOpen((v) => !v)}
                style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: '1px solid #ddd',
                    background: '#fff',
                    fontWeight: 600,
                }}
            >
                {open ? '▾ ' : '▸ '}Upload notes
            </button>

            {open && (
                <div style={{ marginTop: 10 }}>
                    {/* Toggle: PDF | Image */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <button
                            onClick={() => { setKind('pdf'); setFile(null); setErr(null); setMsg(null); }}
                            style={{
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid #ddd',
                                background: kind === 'pdf' ? '#eef2ff' : '#fff',
                                fontSize: 12,
                            }}
                        >
                            PDF
                        </button>
                        <button
                            onClick={() => { setKind('image'); setFile(null); setErr(null); setMsg(null); }}
                            style={{
                                padding: '6px 10px',
                                borderRadius: 6,
                                border: '1px solid #ddd',
                                background: kind === 'image' ? '#eef2ff' : '#fff',
                                fontSize: 12,
                            }}
                        >
                            Image
                        </button>
                    </div>

                    {/* File input */}
                    <input
                        type="file"
                        accept={kind === 'pdf' ? 'application/pdf' : 'image/*'}
                        onChange={onPick}
                        style={{
                            width: '100%',
                            padding: '8px',
                            border: '1px solid #ddd',
                            borderRadius: 6,
                            marginBottom: 8,
                        }}
                    />

                    {/* Actions */}
                    <button
                        onClick={onUpload}
                        disabled={uploading || !file || !userId || !courseId}
                        title={
                            !userId
                                ? 'Set a user id first'
                                : !courseId
                                    ? 'Select or create a course'
                                    : undefined
                        }
                        style={{
                            width: '100%',
                            padding: '8px 10px',
                            borderRadius: 8,
                            border: '1px solid #ddd',
                            background: uploading ? '#f3f4f6' : '#fff',
                            cursor:
                                uploading || !file || !userId || !courseId
                                    ? 'not-allowed'
                                    : 'pointer',
                        }}
                    >
                        {uploading ? 'Uploading…' : `Upload ${kind}`}
                    </button>

                    {/* Status */}
                    {msg && (
                        <div style={{ color: '#065f46', marginTop: 8, fontSize: 12 }}>
                            {msg}
                        </div>
                    )}
                    {err && (
                        <div style={{ color: '#b91c1c', marginTop: 8, fontSize: 12 }}>
                            {err}
                        </div>
                    )}

                    {/* Tiny hints */}
                    <div style={{ color: '#6b7280', marginTop: 8, fontSize: 11 }}>
                        {kind === 'pdf'
                            ? 'PDF only • max ~100MB • server validates %PDF header'
                            : 'PNG/JPG/etc • will be normalized server-side'}
                    </div>
                </div>
            )}
        </div>
    );
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
    const [lockedByAuth, setLockedByAuth] = useState(false); // hide input when Supabase session found
    const [courses, setCourses] = useState<Course[]>([]);
    const [loadingCourses, setLoadingCourses] = useState(false);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [newTerm, setNewTerm] = useState('');

    // If Supabase is configured, hydrate userId from session (optional; no redirect)
    useEffect(() => {
        if (!supabase) return;
        let mounted = true;

        supabase.auth.getSession().then(({ data }) => {
            const uid = data.session?.user?.id;
            if (mounted && uid) {
                setUserId(uid);
                setLockedByAuth(true);
            }
        });

        const { data } = supabase.auth.onAuthStateChange((_e, session) => {
            const uid = session?.user?.id;
            if (uid) {
                setUserId(uid);
                setLockedByAuth(true);
            } else {
                setLockedByAuth(false);
            }
        });

        return () => {
            mounted = false;
            data?.subscription?.unsubscribe();
        };
    }, []);

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
                if (rows.length > 0) setCourseId(rows[0].id);
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

    // ───────────────────────────────────────────────────────────────
    // UI
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

                    {/* User ID input (hidden if we have a Supabase user) */}
                    {!lockedByAuth && (
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
                    )}

                    {/* If Supabase session, show a small banner + sign out */}
                    {lockedByAuth && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                            <div style={{ fontSize: 12, color: '#6b7280' }}>
                                Signed in as <code>{userId.slice(0, 8)}…</code>
                            </div>
                            <button
                                onClick={async () => { await supabase?.auth.signOut(); }}
                                style={{ fontSize: 12, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 6, background: '#fff' }}
                            >
                                Sign out
                            </button>
                        </div>
                    )}

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
                    <NotesUploader API={API} userId={userId} courseId={courseId} />
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
