import { openDB, type IDBPDatabase } from 'idb';
import { getSupabase } from './supabase/client';
import type { ScorePayload } from './scoring';

/**
 * Offline-first score queue.
 *
 * A judge's tap is written to IndexedDB FIRST, then flushed to Supabase.
 * If the network is down (very common in an arena), the card is safe on the
 * device and syncs automatically when connectivity returns. Each queued item
 * is keyed by fight+round+judge so a re-tap overwrites cleanly (no dupes).
 */

const DB_NAME = 'nzmmaf-scores';
const STORE = 'pending';

type QueuedScore = ScorePayload & { key: string; queuedAt: number };

let dbPromise: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

const keyFor = (p: ScorePayload) => `${p.fight_id}:${p.round_number}:${p.judge_id}`;

/** Persist locally, then attempt an immediate flush. Returns true if it reached the server. */
export async function enqueueScore(payload: ScorePayload): Promise<boolean> {
  const item: QueuedScore = { ...payload, key: keyFor(payload), queuedAt: Date.now() };
  const d = await db();
  await d.put(STORE, item);
  return flushQueue();
}

/** Push everything pending to Supabase. Safe to call repeatedly. */
export async function flushQueue(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;

  const d = await db();
  const items = (await d.getAll(STORE)) as QueuedScore[];
  if (items.length === 0) return true;

  const supabase = getSupabase();
  let allOk = true;

  for (const item of items) {
    const { key, queuedAt, ...payload } = item;
    const { error } = await supabase
      .from('scores')
      .upsert(payload, { onConflict: 'judge_id,fight_id,round_number' });

    if (error) {
      // Leave it queued and try again later; RLS/lock errors are terminal.
      allOk = false;
      const terminal = error.code === '42501' || /locked/i.test(error.message);
      if (terminal) await d.delete(STORE, key);
    } else {
      await d.delete(STORE, key);
    }
  }
  return allOk;
}

export async function pendingCount(): Promise<number> {
  const d = await db();
  return d.count(STORE);
}

/** Wire up auto-flush on reconnect. Call once from the client shell. */
export function registerAutoFlush() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => void flushQueue());
}
