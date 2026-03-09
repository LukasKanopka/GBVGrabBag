<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import Button from 'primevue/button';
import { useToast } from 'primevue/usetoast';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import PublicLayout from '../components/layout/PublicLayout.vue';
import { advanceWinnerToNextById } from '../lib/bracket';
import UiBackButton from '../components/ui/UiBackButton.vue';

type UUID = string;

type Team = { id: UUID; full_team_name: string };
type Match = {
  id: UUID;
  tournament_id: UUID;
  pool_id: UUID | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  live_owner_id: UUID | null;
  live_last_active_at: string | null;
  match_type: 'pool' | 'bracket';
  round_number: number | null;
};

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const toast = useToast();

const accessCode = computed(() => (route.params.accessCode as string) ?? session.accessCode ?? '');
const matchId = computed(() => route.params.matchId as string);
const from = computed(() => (route.query.from as string | undefined) ?? undefined);

const liveMatchId = ref<string | null>(null);
const poolId = ref<string | null>(null);
const poolSize = ref<number | null>(null);
const poolSizeCache = new Map<string, number>();
const team1Id = ref<string | null>(null);
const team2Id = ref<string | null>(null);
const score1 = ref<number>(0);
const score2 = ref<number>(0);
const isLive = ref<boolean>(false);
const matchLabel = ref<string>('No match loaded');
const canControl = ref<boolean>(false); // false when another user has live or claim failed
const matchType = ref<'pool' | 'bracket' | null>(null);
const roundNumber = ref<number | null>(null);
const liveOwnerId = ref<string | null>(null);
const liveLastActiveAt = ref<string | null>(null);
const myUserId = ref<string | null>(null);
const pausedForInactivity = ref(false);

// Prevent stale/out-of-order realtime events from overwriting newer local writes while we own the live session.
const myLatestWriteAtMs = ref<number>(0);
const myPendingWriteAtMs = ref<number>(0);

// Live is treated as a short lease that must be renewed by heartbeat.
// This makes the "only one controller" rule robust even if a user closes the tab.
const LIVE_LEASE_MS = 90 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const INACTIVITY_PAUSE_MS = 4 * 60 * 1000;

// team names cache
const teamNameById = ref<Record<string, string>>({});

async function resolvePoolSize(poolIdValue: string): Promise<number | null> {
  if (poolSizeCache.has(poolIdValue)) return poolSizeCache.get(poolIdValue)!;

  // Primary: pools.target_size
  {
    const { data, error } = await supabase
      .from('pools')
      .select('id,target_size')
      .eq('id', poolIdValue)
      .maybeSingle();
    if (!error && data) {
      const sz = Number((data as any).target_size);
      if (Number.isFinite(sz) && sz > 0) {
        poolSizeCache.set(poolIdValue, sz);
        return sz;
      }
    }
  }

  // Fallback: count assigned teams in that pool for this tournament
  if (session.tournament) {
    const { count } = await supabase
      .from('teams')
      .select('id', { count: 'exact', head: true })
      .eq('tournament_id', session.tournament.id)
      .eq('pool_id', poolIdValue);
    const sz = Number(count ?? 0);
    if (Number.isFinite(sz) && sz > 0) {
      poolSizeCache.set(poolIdValue, sz);
      return sz;
    }
  }

  return null;
}

watch(
  () => [poolId.value, session.tournament?.id] as const,
  async ([pid]) => {
    if (!pid) {
      poolSize.value = null;
      return;
    }
    poolSize.value = await resolvePoolSize(pid);
  },
  { immediate: true }
);

async function ensureTournament() {
  if (!accessCode.value) return;
  await session.ensureAnon();
  if (!session.tournament) {
    await session.loadTournamentByCode(accessCode.value);
  }
}

async function loadTeams() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('teams')
    .select('id, full_team_name')
  .eq('tournament_id', session.tournament.id);
  if (error) {
    toast.add({ severity: 'error', summary: 'Teams load failed', detail: error.message, life: 2500 });
    return;
  }
  const map: Record<string, string> = {};
  (data as Team[]).forEach((t) => (map[t.id] = t.full_team_name));
  teamNameById.value = map;
}

function nameFor(id: string | null) {
  return (id && teamNameById.value[id]) || 'TBD';
}

function isLiveLeaseActive(m: Match): boolean {
  if (!m.is_live) return false;
  if (!m.live_owner_id) return false;
  if (!m.live_last_active_at) return false;
  const t = Date.parse(m.live_last_active_at);
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) <= LIVE_LEASE_MS;
}

function setFromMatch(m: Match | null) {
  if (!m) {
    liveMatchId.value = null;
    poolId.value = null;
    team1Id.value = null;
    team2Id.value = null;
    roundNumber.value = null;
    score1.value = 0;
    score2.value = 0;
    isLive.value = false;
    liveOwnerId.value = null;
    liveLastActiveAt.value = null;
    matchType.value = null;
    matchLabel.value = 'No match loaded';
    return;
  }

  // Guard against out-of-order realtime events (e.g., heartbeat updates arriving after a newer local write).
  // Only applies while we are the live owner, to avoid blocking legitimate updates from other devices.
  const incomingLiveMs = m.live_last_active_at ? Date.parse(m.live_last_active_at) : NaN;
  const isMine = !!myUserId.value && m.live_owner_id === myUserId.value;
  const minAcceptedMs = Math.max(myLatestWriteAtMs.value, myPendingWriteAtMs.value);
  if (isMine && Number.isFinite(incomingLiveMs) && incomingLiveMs < minAcceptedMs) {
    return;
  }

  liveMatchId.value = m.id;
  poolId.value = m.pool_id;
  team1Id.value = m.team1_id;
  team2Id.value = m.team2_id;
  roundNumber.value = m.round_number ?? null;
  score1.value = Math.max(0, m.live_score_team1 ?? 0);
  score2.value = Math.max(0, m.live_score_team2 ?? 0);
  isLive.value = isLiveLeaseActive(m) || (!!myUserId.value && m.live_owner_id === myUserId.value);
  liveOwnerId.value = m.live_owner_id ?? null;
  liveLastActiveAt.value = m.live_last_active_at ?? null;
  matchType.value = m.match_type;
  const prefix = m.match_type === 'bracket' ? 'Bracket' : 'Pool';
  matchLabel.value = `${prefix}${m.round_number ? ` R${m.round_number}` : ''}: ${nameFor(m.team1_id)} vs ${nameFor(m.team2_id)}`;

  if (isMine && Number.isFinite(incomingLiveMs)) {
    myLatestWriteAtMs.value = Math.max(myLatestWriteAtMs.value, incomingLiveMs);
    if (myPendingWriteAtMs.value && incomingLiveMs >= myPendingWriteAtMs.value) {
      myPendingWriteAtMs.value = 0;
    }
  }
}

async function loadMatch() {
  if (!session.tournament || !matchId.value) return;
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,pool_id,team1_id,team2_id,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,match_type,round_number')
    .eq('tournament_id', session.tournament.id)
    .eq('id', matchId.value)
    .single();
  if (error || !data) {
    toast.add({ severity: 'error', summary: 'Load match failed', detail: error?.message ?? 'Not found', life: 3000 });
    return;
  }
  setFromMatch(data as Match);
}

async function ensureBracketStartedIfBracket(m: Match) {
  if (m.match_type === 'bracket' && session.tournament) {
    await supabase
      .from('tournaments')
      .update({ bracket_started: true })
      .eq('id', session.tournament.id)
      .eq('bracket_started', false);
  }
}

async function claimLiveIfPossible() {
  if (!session.tournament || !matchId.value) return;
  if (!myUserId.value) return;
  if (!team1Id.value || !team2Id.value) {
    toast.add({ severity: 'warn', summary: 'Cannot start live', detail: 'Both teams must be set for live scoring.', life: 2500 });
    canControl.value = false;
    return;
  }

  pausedForInactivity.value = false;
  const nowIso = new Date().toISOString();
  const staleIso = new Date(Date.now() - LIVE_LEASE_MS).toISOString();

  const { data, error } = await supabase
    .from('matches')
    .update({
      is_live: true,
      live_owner_id: myUserId.value,
      live_last_active_at: nowIso,
      live_score_team1: score1.value ?? 0,
      live_score_team2: score2.value ?? 0,
    })
    .eq('tournament_id', session.tournament.id)
    .eq('id', matchId.value)
    .or(`is_live.eq.false,live_owner_id.is.null,live_owner_id.eq.${myUserId.value},live_last_active_at.is.null,live_last_active_at.lt.${staleIso}`)
    .select('id,tournament_id,pool_id,team1_id,team2_id,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,match_type,round_number');

  if (error) {
    toast.add({ severity: 'error', summary: 'Unable to start live', detail: error.message, life: 2500 });
    canControl.value = false;
    await loadMatch();
    return;
  }

  const updated = (data as Match[] | null) ?? [];
  if (updated.length === 0) {
    canControl.value = false;
    await loadMatch();
    toast.add({ severity: 'warn', summary: 'Already live', detail: 'Another device is live scoring this match.', life: 2500 });
    return;
  }

  canControl.value = true;
  setFromMatch(updated[0] as Match);
  await ensureBracketStartedIfBracket(updated[0] as Match);
}

async function applyScoreUpdate(newS1: number, newS2: number): Promise<boolean> {
  if (!liveMatchId.value || !canControl.value) return false;
  if (!myUserId.value) return false;
  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(nowMs)) myPendingWriteAtMs.value = Math.max(myPendingWriteAtMs.value, nowMs);
  const { error } = await supabase
    .from('matches')
    .update({
      live_score_team1: newS1,
      live_score_team2: newS2,
      is_live: true,
      live_owner_id: myUserId.value,
      live_last_active_at: nowIso,
    })
    .eq('id', liveMatchId.value)
    .eq('live_owner_id', myUserId.value);
  if (error) {
    myPendingWriteAtMs.value = 0;
    toast.add({ severity: 'error', summary: 'Update failed', detail: error.message, life: 2500 });
    return false;
  }

  if (Number.isFinite(nowMs)) {
    myLatestWriteAtMs.value = Math.max(myLatestWriteAtMs.value, nowMs);
    if (myPendingWriteAtMs.value && nowMs >= myPendingWriteAtMs.value) myPendingWriteAtMs.value = 0;
  }

  return true;
}

const lastInteractionAt = ref<number>(Date.now());
function markInteraction() {
  lastInteractionAt.value = Date.now();
}

async function inc(team: 1 | 2) {
  if (!canControl.value) return;
  markInteraction();
  const prevS1 = score1.value;
  const prevS2 = score2.value;
  const ns1 = team === 1 ? score1.value + 1 : score1.value;
  const ns2 = team === 2 ? score2.value + 1 : score2.value;
  score1.value = ns1;
  score2.value = ns2;
  const ok = await applyScoreUpdate(ns1, ns2);
  if (!ok) {
    score1.value = prevS1;
    score2.value = prevS2;
    await loadMatch();
  }
}

async function dec(team: 1 | 2) {
  if (!canControl.value) return;
  markInteraction();
  const prevS1 = score1.value;
  const prevS2 = score2.value;
  const ns1 = team === 1 ? Math.max(0, score1.value - 1) : score1.value;
  const ns2 = team === 2 ? Math.max(0, score2.value - 1) : score2.value;
  score1.value = ns1;
  score2.value = ns2;
  const ok = await applyScoreUpdate(ns1, ns2);
  if (!ok) {
    score1.value = prevS1;
    score2.value = prevS2;
    await loadMatch();
  }
}

async function flipScores() {
  if (!canControl.value) return;
  if (!liveMatchId.value) return;
  if (!myUserId.value) return;
  if (!team1Id.value || !team2Id.value) return;
  markInteraction();

  const prev = { s1: score1.value, s2: score2.value, t1: team1Id.value, t2: team2Id.value };
  const ns1 = prev.s2;
  const ns2 = prev.s1;
  const nt1 = prev.t2;
  const nt2 = prev.t1;

  // Optimistic UI update (realtime will confirm).
  score1.value = ns1;
  score2.value = ns2;
  team1Id.value = nt1;
  team2Id.value = nt2;

  const nowIso = new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(nowMs)) myPendingWriteAtMs.value = Math.max(myPendingWriteAtMs.value, nowMs);
  const { data, error } = await supabase
    .from('matches')
    .update({
      team1_id: nt1,
      team2_id: nt2,
      live_score_team1: ns1,
      live_score_team2: ns2,
      is_live: true,
      live_owner_id: myUserId.value,
      live_last_active_at: nowIso,
    })
    .eq('id', liveMatchId.value)
    .eq('live_owner_id', myUserId.value)
    .select('id,tournament_id,pool_id,team1_id,team2_id,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,match_type,round_number');

  if (error) {
    myPendingWriteAtMs.value = 0;
    score1.value = prev.s1;
    score2.value = prev.s2;
    team1Id.value = prev.t1;
    team2Id.value = prev.t2;
    toast.add({ severity: 'error', summary: 'Flip failed', detail: error.message, life: 2500 });
    return;
  }

  const updated = (data as Match[] | null) ?? [];
  if (updated.length === 0) {
    // Likely lost live ownership between click and update.
    myPendingWriteAtMs.value = 0;
    canControl.value = false;
    await loadMatch();
    toast.add({ severity: 'warn', summary: 'Unable to flip', detail: 'Another device is live scoring this match.', life: 2500 });
    return;
  }

  if (Number.isFinite(nowMs)) {
    myLatestWriteAtMs.value = Math.max(myLatestWriteAtMs.value, nowMs);
    if (myPendingWriteAtMs.value && nowMs >= myPendingWriteAtMs.value) myPendingWriteAtMs.value = 0;
  }

  setFromMatch(updated[0] as Match);
}

// Game rules and winner detection
type RuleSet = { target: number; cap?: number | null; winBy2: boolean };

function getActiveRuleSet(): RuleSet {
  const gr = session.tournament?.game_rules;
  const mt = matchType.value ?? 'pool';
  const phase = mt === 'bracket' ? gr?.bracket : gr?.pool;

  // Cap default now effectively disables most caps (but still provides a safety ceiling)
  const capDefault = 99;

  let target = phase?.setTarget ?? 21;
  if (mt === 'pool') {
    const bySize = (gr?.pool as any)?.setTargetByPoolSize;
    const sz = poolSize.value;
    if (sz != null) {
      const v = Number(bySize?.[String(sz)]);
      if (Number.isFinite(v) && v > 0) target = v;
    }
  }

  const cap = phase?.cap ?? capDefault;
  const winBy2 = phase?.winBy2 ?? true;
  return { target, cap, winBy2 };
}

const hasWinner = computed(() => {
  const r = getActiveRuleSet();
  const s1 = score1.value ?? 0;
  const s2 = score2.value ?? 0;
  const high = Math.max(s1, s2);
  const lead = Math.abs(s1 - s2);
  if (r.winBy2) {
    if (r.cap != null && high >= r.cap) return true; // cap reached
    return high >= r.target && lead >= 2;
  }
  return high >= r.target;
});

const winnerId = computed<UUID | null>(() => {
  const s1 = score1.value ?? 0;
  const s2 = score2.value ?? 0;
  if (!team1Id.value || !team2Id.value) return null;
  if (s1 === s2) return null;
  return s1 > s2 ? team1Id.value : team2Id.value;
});

const finalPromptKey = ref<string | null>(null);
watch(
  () => [canControl.value, hasWinner.value, score1.value, score2.value, team1Id.value, team2Id.value] as const,
  async ([ctrl, hw, s1, s2]) => {
    if (!ctrl || !hw) {
      finalPromptKey.value = null;
      return;
    }

    const key = `${s1}-${s2}`;
    if (finalPromptKey.value === key) return;
    finalPromptKey.value = key;

    const winTeamId = winnerId.value;
    const winTeam = nameFor(winTeamId);
    const ok = confirm(`Submit final score?\n\n${nameFor(team1Id.value)} ${s1} – ${s2} ${nameFor(team2Id.value)}\nWinner: ${winTeam}`);
    if (ok) {
      await submitFinal();
    }
  }
);

async function pauseLiveSession(reason: string, opts?: { silent?: boolean }) {
  if (!myUserId.value) return;
  const id = liveMatchId.value ?? matchId.value;
  if (!id) return;

  const { data, error } = await supabase
    .from('matches')
    .update({
      is_live: false,
      live_owner_id: null,
      live_last_active_at: null,
      // keep live_score_team1/live_score_team2 so another scorer can resume
    })
    .eq('id', id)
    .eq('live_owner_id', myUserId.value)
    .select('id');

  if (error) {
    if (!opts?.silent) toast.add({ severity: 'warn', summary: 'Unable to pause live session', detail: error.message, life: 2500 });
    return;
  }
  const updated = (data as Array<{ id: string }> | null) ?? [];
  if (updated.length === 0) {
    // Either already released, or we no longer own it.
    return;
  }

  pausedForInactivity.value = true;
  canControl.value = false;
  isLive.value = false;
  liveOwnerId.value = null;
  liveLastActiveAt.value = null;
  if (!opts?.silent) toast.add({ severity: 'info', summary: 'Live session paused', detail: reason, life: 2500 });
}

async function submitFinal() {
  if (!canControl.value || !liveMatchId.value) return;
  const winId = winnerId.value;
  // Require a detected winner
  if (!hasWinner.value || !winId) {
    toast.add({ severity: 'warn', summary: 'Winner not clear', detail: 'Scores do not meet win conditions.', life: 2200 });
    return;
  }

  // Instrument: detect silent 204/no-op scenarios
  console.debug('[LiveScoreboardMatch] submitFinal update', {
    id: liveMatchId.value,
    s1: score1.value,
    s2: score2.value,
    winId,
  });

  const { data, error } = await supabase
    .from('matches')
    .update({
      team1_score: score1.value ?? 0,
      team2_score: score2.value ?? 0,
      winner_id: winId,
      is_live: false,
      live_score_team1: null,
      live_score_team2: null,
      live_owner_id: null,
      live_last_active_at: null,
    })
    .eq('id', liveMatchId.value)
    .select('id, team1_score, team2_score, winner_id')
    .single();

  console.debug('[LiveScoreboardMatch] submitFinal result', { hasData: !!data, error });

  if (error) {
    toast.add({ severity: 'error', summary: 'Submit failed', detail: error.message, life: 3000 });
    return;
  }
  if (!data) {
    toast.add({
      severity: 'error',
      summary: 'No rows updated',
      detail: 'Update likely blocked by Row Level Security. Policies must allow public update or user must be authenticated.',
      life: 4000,
    });
    return;
  }

  // If bracket match, mark bracket_started = true on first scoring activity
  if (matchType.value === 'bracket' && session.tournament) {
    await supabase
      .from('tournaments')
      .update({ bracket_started: true })
      .eq('id', session.tournament.id)
      .eq('bracket_started', false);

    // Auto-advance winner into next round slot (do not overwrite manual changes)
    const adv = await advanceWinnerToNextById(session.tournament.id, liveMatchId.value);
    if (adv.error) {
      toast.add({ severity: 'warn', summary: 'Bracket advance skipped', detail: adv.error, life: 3000 });
    }
  }

  toast.add({ severity: 'success', summary: 'Final submitted', life: 1600 });
  // Navigate back to match actions
  router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId: liveMatchId.value }, query: from.value ? { from: from.value } : undefined });
}

// Realtime subscription for this match only
let channel: ReturnType<typeof supabase.channel> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let inactivityTimer: ReturnType<typeof setInterval> | null = null;

async function subscribeRealtime() {
  if (!session.tournament || !matchId.value) return;
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  channel = supabase
    .channel('match_live_' + matchId.value)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'matches',
        filter: `id=eq.${matchId.value}`,
      },
      (payload) => {
        if (import.meta.env.DEV) console.debug('[Realtime] LiveScoreboardMatch event', payload);
        if (payload.new) {
          const m = payload.new as Match;
          setFromMatch(m);
          // If live ownership changed away from us, immediately disable controls.
          if (canControl.value && myUserId.value && m.live_owner_id && m.live_owner_id !== myUserId.value) {
            canControl.value = false;
          }
        }
      }
    );

  await channel.subscribe((status) => {
    if (import.meta.env.DEV) console.debug('[Realtime] LiveScoreboardMatch status', status);
    if (status === 'SUBSCRIBED') {
      void loadMatch();
    }
  });
}

async function backToMatchActions() {
  // Release immediately on exit so LIVE doesn't linger (e.g. 0–0) until timeout.
  await pauseLiveSession('Exited live scoring', { silent: true });
  router.push({ name: 'match-actions', params: { accessCode: accessCode.value, matchId: matchId.value }, query: from.value ? { from: from.value } : undefined });
}

onBeforeRouteLeave(async () => {
  await pauseLiveSession('Exited live scoring', { silent: true });
});

async function loadMyUserId() {
  const { data } = await supabase.auth.getUser();
  myUserId.value = data.user?.id ?? null;
}

async function heartbeat() {
  if (!canControl.value || !liveMatchId.value || !myUserId.value) return;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('matches')
    .update({ live_last_active_at: nowIso, is_live: true })
    .eq('id', liveMatchId.value)
    .eq('live_owner_id', myUserId.value)
    .select('id, is_live, live_owner_id, live_last_active_at, live_score_team1, live_score_team2');

  if (error) return;
  const updated = (data as any[] | null) ?? [];
  if (updated.length === 0) {
    canControl.value = false;
  }
}

onMounted(async () => {
  if (accessCode.value) session.setAccessCode(accessCode.value);
  await ensureTournament();
  await loadMyUserId();
  await loadTeams();
  await loadMatch();
  await claimLiveIfPossible();
  await subscribeRealtime();

  lastInteractionAt.value = Date.now();
  heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_MS);
  inactivityTimer = setInterval(() => {
    if (!canControl.value) return;
    if (Date.now() - lastInteractionAt.value >= INACTIVITY_PAUSE_MS) {
      void pauseLiveSession('Inactive for 4 minutes');
    }
  }, 10_000);
});

onBeforeUnmount(async () => {
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (inactivityTimer) {
    clearInterval(inactivityTimer);
    inactivityTimer = null;
  }
  await pauseLiveSession('Exited live scoring', { silent: true });
});
</script>

<template>
  <PublicLayout>
    <section class="p-5 sm:p-7">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <UiBackButton
              class="shrink-0"
              :on-click="backToMatchActions"
              aria-label="Back to Match"
            />
            <h2 class="text-2xl font-semibold text-white truncate">Enter Live Score</h2>
          </div>
          <div
            v-if="isLive"
            class="shrink-0 inline-flex items-center gap-2 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-white"
            aria-label="Live indicator"
          >
            <span class="size-2 rounded-full bg-white/90"></span>
            LIVE
          </div>
        </div>

        <div class="mt-1">
          <div class="text-sm text-white/80">
            {{ matchType === 'bracket' ? 'Bracket' : matchType === 'pool' ? 'Pool' : 'Match' }} • Round {{ roundNumber ?? '—' }}
          </div>
          <div class="mt-2">
            <div class="text-xl font-semibold text-white leading-tight">{{ nameFor(team1Id) }}</div>
            <div class="text-sm font-medium text-white/70 leading-tight">vs</div>
            <div class="text-xl font-semibold text-white leading-tight">{{ nameFor(team2Id) }}</div>
          </div>
        </div>
        <p v-if="pausedForInactivity" class="mt-1 text-sm text-white/80">
          Live scoring paused due to inactivity.
        </p>
        <p v-else-if="!canControl && isLive" class="mt-1 text-sm text-red-200">
          Another device is live scoring this match. Controls are disabled.
        </p>
        <div v-if="!canControl" class="mt-3">
          <Button
            label="Use Live Scoreboard"
            icon="pi pi-bolt"
            class="!rounded-2xl border-none text-white gbv-grad-blue"
            @click="claimLiveIfPossible"
          />
        </div>

        <div class="mt-6 grid grid-cols-1 gap-6">
          <div class="rounded-xl bg-white/10 ring-1 ring-white/20 p-4 sm:p-6">
            <div class="grid grid-cols-2 gap-3 sm:gap-4">
              <div class="flex flex-col gap-2">
                <button
                  class="w-full h-[42vh] rounded-2xl text-white border-none gbv-grad-blue flex flex-col items-center justify-center text-center px-3"
                  :class="!canControl ? 'opacity-60 cursor-not-allowed' : 'active:scale-[0.99]'"
                  :disabled="!canControl"
                  @click="inc(1)"
                >
                  <div class="text-sm font-semibold text-white/90 truncate w-full">{{ nameFor(team1Id) }}</div>
                  <div class="mt-2 text-7xl sm:text-8xl font-black tabular-nums">{{ score1 }}</div>
                  <div class="mt-2 text-base font-semibold text-white/90">+1</div>
                </button>
                <button
                  class="w-full rounded-2xl bg-white/10 ring-1 ring-white/20 py-3 text-base font-semibold text-white"
                  :class="!canControl ? 'opacity-60 cursor-not-allowed' : 'hover:bg-white/15 active:scale-[0.99]'"
                  :disabled="!canControl"
                  @click="dec(1)"
                >
                  −1
                </button>
              </div>

              <div class="flex flex-col gap-2">
                <button
                  class="w-full h-[42vh] rounded-2xl text-white border-none gbv-grad-orange flex flex-col items-center justify-center text-center px-3"
                  :class="!canControl ? 'opacity-60 cursor-not-allowed' : 'active:scale-[0.99]'"
                  :disabled="!canControl"
                  @click="inc(2)"
                >
                  <div class="text-sm font-semibold text-white/90 truncate w-full">{{ nameFor(team2Id) }}</div>
                  <div class="mt-2 text-7xl sm:text-8xl font-black tabular-nums">{{ score2 }}</div>
                  <div class="mt-2 text-base font-semibold text-white/90">+1</div>
                </button>
                <button
                  class="w-full rounded-2xl bg-white/10 ring-1 ring-white/20 py-3 text-base font-semibold text-white"
                  :class="!canControl ? 'opacity-60 cursor-not-allowed' : 'hover:bg-white/15 active:scale-[0.99]'"
                  :disabled="!canControl"
                  @click="dec(2)"
                >
                  −1
                </button>
              </div>
            </div>

            <div class="mt-4 flex flex-wrap justify-center gap-3">
              <Button
                label="Flip Sides"
                size="large"
                icon="pi pi-refresh"
                class="!rounded-2xl !px-6 !py-3 !text-base"
                severity="contrast"
                :disabled="!canControl"
                @click="flipScores"
              />
              <Button
                v-if="canControl"
                label="Submit Final Score"
                size="large"
                icon="pi pi-check-circle"
                class="!rounded-2xl !px-6 !py-3 !text-base !font-semibold border-none text-white gbv-grad-blue"
                :disabled="!hasWinner"
                @click="submitFinal"
              />
              <Button
                v-if="canControl"
                label="Pause Live"
                size="large"
                icon="pi pi-pause"
                severity="secondary"
                class="!rounded-2xl !px-6 !py-3 !text-base"
                @click="pauseLiveSession('Paused')"
              />
            </div>
          </div>

          <div class="rounded-xl border border-dashed border-white/30 p-6 text-center text-white/80">
            This view updates in real-time for this match.
          </div>
        </div>

        <div class="mt-6 flex justify-center">
          <router-link
            :to="{ name: 'match-score', params: { accessCode: accessCode, matchId: matchId }, query: from ? { from } : undefined }"
            class="inline-flex items-center rounded-2xl bg-white/10 ring-1 ring-white/20 px-4 py-2 text-sm hover:bg-white/15 text-white"
          >
            Enter Final Score
          </router-link>
        </div>
      </section>
  </PublicLayout>
</template>
