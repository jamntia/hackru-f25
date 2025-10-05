'use client';
import { useEffect, useState } from 'react';
import { supabase } from './supabase-browser';
import type { Session } from '@supabase/supabase-js';

export function useSupabaseSession() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);
  return session;
}
