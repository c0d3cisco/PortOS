/**
 * Relevance-based selection of what fills one Persistent Mind wake's context.
 *
 * Deterministic and read-only: it scores whole items (memories, recent events,
 * ready rollups) against the wake's own inputs with BM25 and decides which ones
 * the bounded context includes. It never edits, re-ranks persistently, archives
 * or deletes a memory or rollup (ETHOS §7), never rewrites item text, and makes
 * no model call. `assemblePersistentMindContext` owns rendering; with no usable
 * query it keeps its recency-first behavior byte for byte.
 *
 * Leaf module: `persistentMindTrajectory.js` is reached by ~300 suites, so this
 * imports only the dependency-free `bm25.js`.
 */

import { buildInvertedIndex, score, tokenize } from './bm25.js';

export const PERSISTENT_MIND_CONTEXT_ALLOCATION = Object.freeze({
  // The newest events always stay, so a wake never loses its immediate thread.
  recentEventFloor: 10,
  // Older rollup summaries never take more than this share of the budget left
  // after the stable prefix (the recency-first path uses the same share).
  olderSummaryShare: 0.45,
  weights: Object.freeze({ relevance: 0.6, recency: 0.3, importance: 0.1 }),
  // Events and rollups carry no importance of their own.
  neutralImportance: 0.5,
  maxQueryChars: 4_000,
  // Bounds on the transparency report so a ledger event stays small.
  maxReportedDroppedMemoryIds: 50,
  maxReportedDroppedEventRanges: 50,
});

const LIMITS = PERSISTENT_MIND_CONTEXT_ALLOCATION;

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/** The wake's own purpose: its reason, the user's message, and the playbook phase. */
export function buildPersistentMindAllocationQuery({ wake = null, playbookPhase = null } = {}) {
  const phase = typeof playbookPhase === 'string' ? playbookPhase : playbookPhase?.phase;
  return [clean(wake?.reason), clean(wake?.message?.text), clean(phase)]
    .filter(Boolean)
    .join('\n')
    .slice(0, LIMITS.maxQueryChars);
}

export function normalizePersistentMindAllocationQuery(query) {
  return clean(query).slice(0, LIMITS.maxQueryChars);
}

// Position within the group, oldest 0 → newest 1; a lone item counts as newest.
const rankRecency = (keys) => {
  const ordered = keys.map((key, index) => ({ key, index })).filter(({ key }) => Number.isFinite(key))
    .sort((a, b) => a.key - b.key || a.index - b.index);
  const recency = keys.map(() => 0);
  ordered.forEach(({ index }, rank) => {
    recency[index] = ordered.length === 1 ? 1 : rank / (ordered.length - 1);
  });
  return recency;
};

const clampUnit = (value, fallback) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback);

/**
 * Score every candidate against the query. Returns null when the query has no
 * searchable terms or matches nothing, so the caller keeps recency-first
 * behavior instead of ranking on recency alone.
 *
 * Each group is `{ texts, recencyKeys, importance? }`; the result holds one
 * score array per group, in input order.
 */
export function scorePersistentMindContextCandidates(query, groups) {
  if (tokenize(query).length === 0) return null;
  const entries = Object.entries(groups);
  const documents = entries.flatMap(([name, group]) => group.texts.map((text, index) => ({ id: `${name}:${index}`, text })));
  const index = buildInvertedIndex(documents);
  const raw = Object.fromEntries(entries.map(([name, group]) => [
    name, group.texts.map((_, i) => score(query, `${name}:${i}`, index)),
  ]));
  const maxRaw = Math.max(0, ...Object.values(raw).flat());
  if (!(maxRaw > 0)) return null;
  const { relevance, recency, importance } = LIMITS.weights;
  return Object.fromEntries(entries.map(([name, group]) => {
    const recencies = rankRecency(group.recencyKeys);
    return [name, raw[name].map((value, i) => relevance * (value / maxRaw)
      + recency * recencies[i]
      + importance * clampUnit(group.importance?.[i], LIMITS.neutralImportance))];
  }));
}

/**
 * Greedy whole-item fill: mandatory indices first in the given order, then the
 * rest by descending score (newer index wins a tie). An item that does not fit
 * is skipped, never shortened; `forced` items go in even past the budget.
 * `fillRest: false` stops after the mandatory items (to measure their room). Returns the chosen indices ascending, which is
 * the stable render order, and the joined length (newline separators).
 */
export function selectPersistentMindContextItems({ lengths, scores, budget, mandatory = [], forced = [], fillRest = true }) {
  const chosen = new Set();
  let used = 0;
  const take = (index, force = false) => {
    if (chosen.has(index)) return;
    const cost = (chosen.size ? 1 : 0) + lengths[index];
    if (!force && used + cost > budget) return;
    chosen.add(index);
    used += cost;
  };
  for (const index of forced) take(index, true);
  for (const index of mandatory) take(index);
  if (fillRest) {
    lengths.map((_, index) => index)
      .filter((index) => !chosen.has(index))
      .sort((a, b) => scores[b] - scores[a] || b - a)
      .forEach((index) => take(index));
  }
  return { indices: [...chosen].sort((a, b) => a - b), chars: used };
}

/** Collapse dropped positions into contiguous runs of the candidate list. */
export function persistentMindDroppedEventRanges(events, keptIndices) {
  const kept = new Set(keptIndices);
  const ranges = [];
  let open = null;
  events.forEach((event, index) => {
    if (kept.has(index)) {
      open = null;
      return;
    }
    if (open) open.toSequence = event.sequence;
    else {
      open = { fromSequence: event.sequence, toSequence: event.sequence };
      ranges.push(open);
    }
  });
  return ranges.slice(0, LIMITS.maxReportedDroppedEventRanges);
}

/**
 * The bounded transparency report. Counts, ids and sequence ranges only — never
 * the query text, memory content or event text, because it lands on the
 * `mind.model.request` ledger event and in the context preview.
 */
export function buildPersistentMindAllocationReport({
  mode, queryChars, memories, protectedMemoryCount, summaries, events, droppedEventRanges, recentEventFloor,
}) {
  return {
    mode,
    queryChars,
    protectedMemoryCount,
    sections: {
      memories: {
        candidates: memories.candidates,
        kept: memories.kept,
        truncated: memories.truncated,
        dropped: memories.droppedIds.length,
      },
      olderSummaries: { candidates: summaries.candidates, kept: summaries.kept, dropped: summaries.candidates - summaries.kept },
      recentEvents: { candidates: events.candidates, kept: events.kept, dropped: events.candidates - events.kept, floor: recentEventFloor },
    },
    droppedMemoryIds: memories.droppedIds.slice(0, LIMITS.maxReportedDroppedMemoryIds),
    droppedEventRanges,
  };
}
