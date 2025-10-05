'use client';

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase-browser';
import { useRouter } from 'next/navigation';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // If already signed in, bounce to /chat
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace('/chat');
    });
  }, [router]);

  async function magicLink() {
    setErr(null); setMsg(null); setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + '/chat' } });
      if (error) throw error;
      setMsg('Check your email for a sign-in link.');
    } catch (e: any) {
      setErr(e.message || 'Failed to send magic link');
    } finally {
      setLoading(false);
    }
  }

  async function oauth(provider: 'google'|'github') {
    setErr(null); setMsg(null); setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin + '/chat' },
      });
      if (error) throw error;
      // will redirect
    } catch (e: any) {
      setErr(e.message || 'OAuth failed');
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: '10vh auto', fontFamily: 'ui-sans-serif, system-ui' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 16 }}>Sign in</h1>

      <div style={{ display:'grid', gap: 12 }}>
        <input
          value={email}
          onChange={(e)=>setEmail(e.target.value)}
          placeholder="you@example.com"
          type="email"
          style={{ padding:'10px 12px', border:'1px solid #ddd', borderRadius:8 }}
        />
        <button onClick={magicLink} disabled={!email || loading}
          style={{ padding:'10px 12px', border:'1px solid #ddd', borderRadius:8, background:'#fff' }}>
          {loading ? 'Sending…' : 'Send magic link'}
        </button>

        <div style={{ display:'flex', gap:8 }}>
          <button onClick={()=>oauth('google')} style={{ flex:1, padding:'10px 12px', border:'1px solid #ddd', borderRadius:8, background:'#fff' }}>
            Continue with Google
          </button>
          <button onClick={()=>oauth('github')} style={{ flex:1, padding:'10px 12px', border:'1px solid #ddd', borderRadius:8, background:'#fff' }}>
            GitHub
          </button>
        </div>

        {msg && <div style={{ color:'#065f46' }}>{msg}</div>}
        {err && <div style={{ color:'#b91c1c' }}>{err}</div>}
      </div>
    </main>
  );
}
