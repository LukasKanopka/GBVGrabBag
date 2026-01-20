<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { useToast } from 'primevue/usetoast';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import Tag from 'primevue/tag';
import Dropdown from 'primevue/dropdown';
import ToggleButton from 'primevue/togglebutton';
import UiSectionHeading from '@/components/ui/UiSectionHeading.vue';
import supabase from '../lib/supabase';
import { useSessionStore } from '../stores/session';
import { generateBracket, rebuildBracket, checkBracketPrerequisites, type BracketPrereqReport } from '../lib/bracket';
import { fillRandomPoolScores } from '../lib/testData';

type UUID = string;

type Team = { id: UUID; full_team_name: string };

type Match = {
  id: UUID;
  tournament_id: UUID;
  pool_id: UUID | null;
  round_number: number | null;
  team1_id: UUID | null;
  team2_id: UUID | null;
  team1_score: number | null;
  team2_score: number | null;
  is_live: boolean;
  live_score_team1: number | null;
  live_score_team2: number | null;
  live_owner_id: UUID | null;
  live_last_active_at: string | null;
  winner_id: UUID | null;
  match_type: 'pool' | 'bracket';
  bracket_round: number | null;
  bracket_match_index: number | null;
};

const router = useRouter();
const toast = useToast();
const session = useSessionStore();

const accessCode = ref<string>(session.accessCode ?? '');
const loading = ref(false);
const running = ref(false);
const manualMode = ref(false);

const prereqRunning = ref(false);
const prereqReport = ref<BracketPrereqReport | null>(null);
const lastErrors = ref<string[]>([]);
const lastOp = ref<'generate' | 'rebuild' | 'prereq' | null>(null);

const matches = ref<Match[]>([]);
const teams = ref<Team[]>([]);
const teamOptions = computed(() =>
  [{ id: null, full_team_name: '— (TBD)' } as any].concat(teams.value)
    .map((t) => ({ label: t.full_team_name, value: t.id }))
);
const teamNameById = computed(() => {
  const map: Record<string, string> = {};
  for (const t of teams.value) map[t.id] = t.full_team_name;
  return map;
});

const maxRound = computed(() => Math.max(0, ...matches.value.map(m => m.bracket_round || 0)));

function winnerIdFor(m: Match): string | null {
  const winId = m.winner_id ?? null;
  const t1 = m.team1_id ?? null;
  const t2 = m.team2_id ?? null;
  if (winId && (winId === t1 || winId === t2)) return winId;
  if (t1 && t2 && m.team1_score != null && m.team2_score != null) {
    const s1 = m.team1_score ?? 0;
    const s2 = m.team2_score ?? 0;
    if (s1 === s2) return null;
    return s1 > s2 ? t1 : t2;
  }
  return null;
}

const championName = computed(() => {
  const mr = maxRound.value;
  if (!mr) return null;
  const finalMatch = matches.value.find((m) => (m.bracket_round ?? 0) === mr && (m.bracket_match_index ?? 0) === 0) ?? null;
  if (!finalMatch) return null;
  const winId = winnerIdFor(finalMatch);
  if (!winId) return null;
  return teamNameById.value[winId] ?? 'TBD';
});

function roundTitle(r: number) {
  const mr = maxRound.value;
  if (mr <= 1) return 'Final';
  if (mr === 2) return r === 1 ? 'Semifinals' : 'Final';
  if (mr === 3) return r === 1 ? 'Quarterfinals' : r === 2 ? 'Semifinals' : 'Final';
  return `Round ${r}`;
}

function groupedByRound(): Array<[number, Match[]]> {
  const map = new Map<number, Match[]>();
  for (const m of matches.value) {
    const r = m.bracket_round || 1;
    const arr = map.get(r) ?? [];
    arr.push(m);
    map.set(r, arr);
  }
  // sort rounds asc, and matches within each round by bracket_match_index (fallback to id)
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([r, arr]) => {
      const sorted = arr.slice().sort((a, b) => {
        const ai = a.bracket_match_index ?? Number.MAX_SAFE_INTEGER;
        const bi = b.bracket_match_index ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.id.localeCompare(b.id);
      });
      return [r, sorted] as [number, Match[]];
    });
}

async function ensureTournamentByCode() {
  if (!accessCode.value?.trim()) {
    toast.add({ severity: 'warn', summary: 'Access code required', life: 1500 });
    return;
  }
  loading.value = true;
  try {
    await session.ensureAnon();
    session.setAccessCode(accessCode.value.trim());
    const t = await session.loadTournamentByCode(accessCode.value.trim());
    if (!t) {
      toast.add({ severity: 'error', summary: 'Tournament not found', life: 2000 });
      return;
    }
    toast.add({ severity: 'success', summary: 'Loaded tournament', detail: t.name, life: 1500 });
    await loadTeams();
    await loadMatches();
  } finally {
    loading.value = false;
  }
}

async function loadTeams() {
  if (!session.tournament) return;
  const { data, error } = await supabase
    .from('teams')
    .select('id, full_team_name')
    .eq('tournament_id', session.tournament.id)
    .order('full_team_name', { ascending: true });
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load teams', detail: error.message, life: 2500 });
    teams.value = [];
    return;
  }
  teams.value = (data as Team[]) ?? [];
}

async function loadMatches() {
  if (!session.tournament) {
    matches.value = [];
    return;
  }
  const { data, error } = await supabase
    .from('matches')
    .select('id,tournament_id,pool_id,round_number,team1_id,team2_id,team1_score,team2_score,is_live,live_score_team1,live_score_team2,live_owner_id,live_last_active_at,winner_id,match_type,bracket_round,bracket_match_index')
    .eq('tournament_id', session.tournament.id)
    .eq('match_type', 'bracket')
    .order('bracket_round', { ascending: true })
    .order('bracket_match_index', { ascending: true });
  if (error) {
    toast.add({ severity: 'error', summary: 'Failed to load bracket', detail: error.message, life: 2500 });
    matches.value = [];
    return;
  }
  matches.value = (data as Match[]) ?? [];
}

async function doGenerate() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  running.value = true;
  try {
    const res = await generateBracket(session.tournament.id);
    lastOp.value = 'generate';
    const errs = res.errors || [];
    lastErrors.value = errs;
    const suffix = res.bracketSize ? ` • size ${res.bracketSize}, ${res.rounds} round(s)` : '';
    if (errs.length === 0) {
      toast.add({ severity: 'success', summary: `Generated ${res.inserted} match(es)${suffix}`, life: 2500 });
    } else {
      toast.add({ severity: 'warn', summary: `Generated ${res.inserted} with ${errs.length} error(s): ${errs[0]}`, life: 4000 });
      console.warn('generateBracket errors:', errs);
    }
    await loadMatches();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Generate failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    running.value = false;
  }
}

async function doRebuild() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  const confirmed = confirm('Rebuild bracket? This will delete all existing bracket matches and scores. This cannot be undone. Continue?');
  if (!confirmed) return;
  running.value = true;
  try {
    const res = await rebuildBracket(session.tournament.id);
    lastOp.value = 'rebuild';
    const errs = res.errors || [];
    lastErrors.value = errs;
    const suffix = res.bracketSize ? ` • size ${res.bracketSize}, ${res.rounds} round(s)` : '';
    if (errs.length === 0) {
      toast.add({ severity: 'success', summary: `Rebuilt with ${res.inserted} match(es)${suffix}`, life: 2500 });
    } else {
      toast.add({ severity: 'warn', summary: `Rebuilt with ${res.inserted} and ${errs.length} error(s): ${errs[0]}`, life: 4000 });
      console.warn('rebuildBracket errors:', errs);
    }
    await loadMatches();
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Rebuild failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    running.value = false;
  }
}

async function doCheckPrereq() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  prereqRunning.value = true;
  try {
    const report = await checkBracketPrerequisites(session.tournament.id);
    prereqReport.value = report;
    lastOp.value = 'prereq';
    const ecount = report.errors.length;
    if (report.ok) {
      const sizeInfo = report.stats.bracketSize > 0 ? ` • size ${report.stats.bracketSize}, ${report.stats.rounds} round(s)` : '';
      toast.add({
        severity: 'success',
        summary: `Ready: ${report.stats.poolCount} pool(s), ${report.stats.teamCount} team(s)`,
        detail: `Advancers expected ${report.stats.expectedAdvancers}, actual ${report.stats.actualAdvancers || '—'}${sizeInfo}`,
        life: 3500
      });
    } else {
      toast.add({
        severity: 'warn',
        summary: `Prerequisites found ${ecount} blocker(s)`,
        detail: report.errors[0],
        life: 4500
      });
    }
    console.log('Bracket prerequisites report:', report);
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Prereq check failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    prereqRunning.value = false;
  }
}

async function doFillPoolScores() {
  if (!session.tournament) {
    toast.add({ severity: 'warn', summary: 'Load a tournament first', life: 1500 });
    return;
  }
  const confirmed = confirm('Are you sure? This will randomly fill scores for all unscored pool matches in this tournament. This cannot be undone.');
  if (!confirmed) return;

  running.value = true;
  try {
    const res = await fillRandomPoolScores(session.tournament.id);
    const errs = res.errors || [];
    if (errs.length === 0) {
      toast.add({ severity: 'success', summary: `Filled ${res.updated} pool match(es)`, life: 2000 });
    } else {
      toast.add({ severity: 'warn', summary: `Filled ${res.updated}, with ${errs.length} error(s)`, life: 3500 });
      console.warn('fillRandomPoolScores errors:', errs);
    }
  } catch (err: any) {
    toast.add({ severity: 'error', summary: 'Fill failed', detail: err?.message ?? 'Unknown error', life: 3000 });
  } finally {
    running.value = false;
  }
}

async function updateTeam(m: Match, side: 'team1_id' | 'team2_id', value: string | null) {
  if (!session.tournament) return;
  const { error } = await supabase
    .from('matches')
    .update({ [side]: value })
    .eq('id', m.id)
    .eq('match_type', 'bracket');
  if (error) {
    toast.add({ severity: 'error', summary: 'Update failed', detail: error.message, life: 2500 });
    return;
  }
  // refresh
  await loadMatches();
}

function back() {
  router.push({ name: 'admin-dashboard' });
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await session.refreshAdminUser(); // guard handled by router meta
  if (session.accessCode && !session.tournament) {
    try {
      await session.ensureAnon();
      await session.loadTournamentByCode(session.accessCode);
    } catch { /* ignore */ }
  }
  if (session.tournament) {
    await loadTeams();
    await loadMatches();
    refreshTimer = setInterval(() => void loadMatches(), 15_000);
  }
});

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});
</script>

<template>
  <section class="mx-auto max-w-6xl px-4 py-6">
    <UiSectionHeading
      title="Admin Bracket"
      subtitle="Generate, rebuild, and optionally manually adjust bracket matches."
      :divider="true"
    >
      <Button
        label="Back"
        icon="pi pi-arrow-left"
        severity="secondary"
        outlined
        class="!rounded-xl !border-white/40 !text-white hover:!bg-white/10"
        @click="back"
      />
    </UiSectionHeading>

    <!-- Tournament loader / context -->
    <div class="rounded-lg border border-white/15 bg-white/5 p-4">
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end" v-if="!session.tournament">
        <div class="sm:col-span-2">
          <label class="block text-sm mb-2">Tournament Access Code</label>
          <InputText
            v-model="accessCode"
            placeholder="e.g. GATORS2025"
            class="w-full !rounded-xl !px-4 !py-3 !bg-white !text-slate-900"
          />
        </div>
        <div class="flex">
          <Button
            :loading="loading"
            label="Load Tournament"
            icon="pi pi-search"
            class="!rounded-xl !px-4 !py-3 border-none text-white gbv-grad-blue"
            @click="ensureTournamentByCode"
          />
        </div>
      </div>
      <div v-else class="text-sm">
        Loaded: <span class="font-semibold">{{ session.tournament.name }}</span>
        <span class="ml-2 text-white/80">({{ session.accessCode }})</span>
      </div>
    </div>

    <div v-if="session.tournament" class="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Actions -->
      <div class="lg:col-span-1">
        <div class="rounded-lg border border-white/15 bg-white/5 p-4">
          <div class="flex items-center justify-between">
            <div class="text-sm font-medium">Bracket Controls</div>
          </div>
          <div class="mt-3 grid gap-3">
            <Button
              :loading="prereqRunning"
              label="Check Bracket Prerequisites"
              icon="pi pi-check-circle"
              class="!rounded-xl border-none text-white gbv-grad-blue"
              @click="doCheckPrereq"
            />
            <Button
              :loading="running"
              label="Generate Bracket"
              icon="pi pi-sitemap"
              class="!rounded-xl border-none text-white gbv-grad-green"
              @click="doGenerate"
            />
            <Button
              :loading="running"
              label="Fill Pool Scores Randomly"
              icon="pi pi-random"
              class="!rounded-xl border-none text-white gbv-grad-blue"
              @click="doFillPoolScores"
            />
            <Button
              :loading="running"
              label="Rebuild Bracket"
              icon="pi pi-refresh"
              severity="warn"
              class="!rounded-xl"
              @click="doRebuild"
            />
            <div class="mt-2 flex items-center justify-between">
              <span class="text-sm">Manual Mode</span>
              <ToggleButton v-model="manualMode" onLabel="On" offLabel="Off" />
            </div>
          </div>
          <div class="mt-4 text-xs text-white/80">
            Status:
            <Tag
              :value="session.tournament.bracket_started ? 'Started' : 'Not Started'"
              :severity="session.tournament.bracket_started ? 'warn' : 'info'"
            />
            <div class="mt-1">
              Generated at: {{ session.tournament.bracket_generated_at || '—' }}
            </div>
          </div>

          <!-- Diagnostics Panel -->
          <div class="mt-4 text-xs text-white/80 rounded-lg border border-white/15 bg-white/5 p-3">
            <div class="flex items-center justify-between">
              <div class="text-sm font-medium">Diagnostics</div>
              <Tag
                v-if="prereqReport"
                :value="prereqReport.ok ? 'Ready' : 'Blocked'"
                :severity="prereqReport.ok ? 'success' : 'warn'"
              />
            </div>

            <div v-if="prereqReport" class="mt-2 space-y-2">
              <div>
                Pools: {{ prereqReport.stats.poolCount }},
                Teams: {{ prereqReport.stats.teamCount }}
                • Expected advancers: {{ prereqReport.stats.expectedAdvancers }},
                Actual: {{ prereqReport.stats.actualAdvancers || '—' }}
                <span v-if="prereqReport.stats.bracketSize > 0">
                  • Size {{ prereqReport.stats.bracketSize }}, Rounds {{ prereqReport.stats.rounds }}
                </span>
              </div>

              <div v-if="prereqReport.errors.length">
                <div class="mb-1 font-medium text-white">Errors</div>
                <ul class="list-disc list-inside">
                  <li v-for="(e, i) in prereqReport.errors" :key="'pe'+i">{{ e }}</li>
                </ul>
              </div>

              <div v-if="prereqReport.unscored.length">
                <div class="mb-1 font-medium text-white">Unscored pool matches</div>
                <ul class="list-disc list-inside max-h-40 overflow-auto pr-2">
                  <li v-for="u in prereqReport.unscored" :key="'u'+u.matchId">
                    {{ (u.poolName || 'Unknown Pool') }} • {{ u.matchId.slice(0, 8) }}
                  </li>
                </ul>
              </div>

              <div v-if="prereqReport.infos.length">
                <div class="mb-1 font-medium text-white">Info</div>
                <ul class="list-disc list-inside">
                  <li v-for="(e, i) in prereqReport.infos" :key="'pi'+i">{{ e }}</li>
                </ul>
              </div>
            </div>

            <div v-else class="mt-2 text-white/70">
              Run "Check Bracket Prerequisites" to analyze readiness.
            </div>

            <div v-if="lastErrors.length && (lastOp === 'generate' || lastOp === 'rebuild')" class="mt-3">
              <div class="mb-1 font-medium text-white">Last {{ lastOp }} errors</div>
              <ul class="list-disc list-inside">
                <li v-for="(e, i) in lastErrors" :key="'le'+i">{{ e }}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      <!-- Bracket Matches -->
      <div class="lg:col-span-2">
        <div v-if="matches.length === 0" class="rounded-lg border border-white/15 bg-white/5 p-6 text-sm">
          No bracket matches yet.
        </div>

        <div v-else class="grid gap-6">
          <div
            v-if="championName"
            class="rounded-2xl bg-white/10 ring-2 ring-amber-300/60 p-5 text-center text-white"
          >
            <div class="text-2xl font-extrabold leading-tight">
              {{ championName }} WON!! 🎉🎉
            </div>
            <div class="mt-1 text-white/80 font-medium">
              Thank you for playing!
            </div>
          </div>
          <div v-for="[r, arr] in groupedByRound()" :key="r" class="rounded-lg border border-white/15 bg-white/5 overflow-hidden">
            <div class="border-b border-white/15 px-4 py-3">
              <div class="text-sm font-semibold">{{ roundTitle(r) }}</div>
            </div>
            <div class="p-4 grid gap-3">
              <div
                v-for="m in arr"
                :key="m.id"
                class="rounded-xl border border-white/15 bg-white/10 p-4"
              >
                <div class="flex items-center justify-between">
                  <div class="text-xs text-white/80">
                    Match {{ m.id.slice(0, 8) }} • {{ m.match_type === 'bracket' ? 'Bracket' : 'Pool' }}{{ m.round_number ? ` R${m.round_number}` : '' }}
                  </div>
                  <Tag v-if="m.is_live" value="LIVE" severity="danger" />
                </div>

                <div v-if="manualMode" class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label class="block text-xs mb-1">Team 1</label>
                    <Dropdown
                      :modelValue="m.team1_id"
                      :options="teamOptions"
                      optionLabel="label"
                      optionValue="value"
                      class="w-full"
                      :pt="{ root: { class: 'w-full' } }"
                      @update:modelValue="(val: string | null) => updateTeam(m, 'team1_id', val as string | null)"
                    />
                  </div>
                  <div>
                    <label class="block text-xs mb-1">Team 2</label>
                    <Dropdown
                      :modelValue="m.team2_id"
                      :options="teamOptions"
                      optionLabel="label"
                      optionValue="value"
                      class="w-full"
                      :pt="{ root: { class: 'w-full' } }"
                      @update:modelValue="(val: string | null) => updateTeam(m, 'team2_id', val as string | null)"
                    />
                  </div>
                </div>

                <div v-else class="mt-3 text-sm">
                  <div class="font-semibold">
                    {{ (teams.find(t => t.id === m.team1_id)?.full_team_name) || 'TBD' }}
                    <span class="text-white/70"> vs </span>
                    {{ (teams.find(t => t.id === m.team2_id)?.full_team_name) || 'TBD' }}
                  </div>
                </div>
              </div>
            </div>

            <div class="px-4 pb-4">
              <Button
                label="Refresh"
                icon="pi pi-refresh"
                size="small"
                severity="secondary"
                outlined
                class="!rounded-xl"
                @click="loadMatches"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-6 text-sm text-white/80">
      Notes:
      <ul class="list-disc list-inside">
        <li>Policy A: Top 2 advance per pool; bracket size up to 8 with byes to top seeds.</li>
        <li>Rebuild is blocked once the bracket has started (any bracket match goes live or is scored).</li>
      </ul>
    </div>
  </section>
</template>
