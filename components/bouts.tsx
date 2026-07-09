'use client';

import { useState } from 'react';

export interface NewBout {
  fighter_a_name: string;
  fighter_b_name: string;
  weight_class: string;
  scheduled_rounds: number;
  round_minutes: number;
}

// Add-bout form, shared by the events list and the event run sheet.
export function CreateFight({
  onCreate,
  busy,
}: {
  onCreate: (data: NewBout) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [weight, setWeight] = useState('');
  const [rounds, setRounds] = useState(3);
  const [minutes, setMinutes] = useState(5);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="h-10 w-full rounded-lg bg-slate-800 text-sm font-bold text-slate-300"
      >
        + Add bout
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-xl bg-slate-950/60 p-3">
      <input
        value={a}
        onChange={(e) => setA(e.target.value)}
        placeholder="Fighter A name"
        className="h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
      />
      <input
        value={b}
        onChange={(e) => setB(e.target.value)}
        placeholder="Fighter B name"
        className="h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
      />
      <input
        value={weight}
        onChange={(e) => setWeight(e.target.value)}
        placeholder="Weight class"
        className="h-10 w-full rounded-lg bg-slate-800 px-3 text-sm text-slate-100 placeholder:text-slate-600"
      />
      <div className="flex gap-2">
        <Pick label="Rounds" value={rounds} options={[3, 5]} onChange={setRounds} suffix="" />
        <Pick label="Length" value={minutes} options={[3, 5]} onChange={setMinutes} suffix="m" />
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => {
            onCreate({
              fighter_a_name: a.trim(),
              fighter_b_name: b.trim(),
              weight_class: weight.trim() || 'Catchweight',
              scheduled_rounds: rounds,
              round_minutes: minutes,
            });
            setA('');
            setB('');
            setWeight('');
            setOpen(false);
          }}
          disabled={busy || !a.trim() || !b.trim()}
          className="h-10 flex-1 rounded-lg bg-slate-50 text-sm font-bold text-slate-950 disabled:opacity-40"
        >
          Create bout
        </button>
        <button
          onClick={() => setOpen(false)}
          className="h-10 rounded-lg bg-slate-800 px-4 text-sm font-bold text-slate-300"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Pick({
  label,
  value,
  options,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  options: number[];
  onChange: (v: number) => void;
  suffix: string;
}) {
  return (
    <div className="flex-1">
      <p className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-500">{label}</p>
      <div className="flex gap-1">
        {options.map((o) => (
          <button
            key={o}
            onClick={() => onChange(o)}
            className={`h-9 flex-1 rounded-lg text-sm font-bold transition ${
              value === o ? 'bg-slate-50 text-slate-950' : 'bg-slate-800 text-slate-300'
            }`}
          >
            {o}
            {suffix}
          </button>
        ))}
      </div>
    </div>
  );
}
