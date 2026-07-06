'use client';

import { use, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase/client';
import ScoringCard from './ScoringCard';

export default function JudgeFightPage({ params }: { params: Promise<{ fightId: string }> }) {
  const { fightId } = use(params);
  const supabase = getSupabase();
  const [fight, setFight] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      // RLS guarantees this returns a row only if the signed-in judge is assigned.
      const { data, error } = await supabase.from('fights').select('*').eq('id', fightId).single();
      if (!active) return;
      if (error || !data) {
        setError('This bout is not assigned to you, or you are not yet approved.');
        return;
      }
      setFight(data);
    }
    load();

    // Follow the official's round control so the card advances live.
    const channel = supabase
      .channel(`fight-${fightId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'fights', filter: `id=eq.${fightId}` },
        (payload) => active && setFight(payload.new),
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [fightId, supabase]);

  if (error) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 px-6 text-center text-slate-300">
        <p className="text-lg font-semibold">{error}</p>
      </div>
    );
  }
  if (!fight) {
    return (
      <div className="grid min-h-dvh place-items-center bg-slate-950 text-slate-400">
        Loading bout…
      </div>
    );
  }
  return <ScoringCard fight={fight} />;
}
