import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleDot,
  FolderGit2,
  KeyRound,
  Loader2,
  Play,
  ScanSearch,
  XCircle,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { Credentials, Universe, UniverseModule } from '@/hooks/use-dashboard';
import {
  useBuildFromRepos,
  useRegressionRuns,
  useRunRegression,
  useScrapeModules,
  type RegressionRun,
  type RegressionSuite,
} from '@/hooks/use-regression';
import { CredentialsBody } from './client-credentials';

/**
 * Widget ÚNICO y COLAPSABLE del cliente. Junta en un solo Card: el avance de
 * regresión (% de módulos del universo con automatización de QA), las acciones
 * para DEFINIR el universo (escanear el sitio o construir desde repos), correr la
 * regresión, y las credenciales/entornos. Colapsado por defecto para no ocupar
 * espacio: el header muestra el % y, al expandir, aparece todo el detalle.
 */
const STATUS: Record<UniverseModule['status'], { icon: typeof CheckCircle2; cls: string; bar: string }> = {
  covered: { icon: CheckCircle2, cls: 'text-success', bar: 'bg-success' },
  partial: { icon: CircleDot, cls: 'text-warning', bar: 'bg-warning' },
  pending: { icon: CircleDashed, cls: 'text-muted-foreground', bar: 'bg-muted-foreground/30' },
};

const SUITES: { value: RegressionSuite; label: string }[] = [
  { value: 'e2e', label: 'E2E' },
  { value: 'perf', label: 'Rendimiento' },
  { value: 'security', label: 'Seguridad' },
  { value: 'mobile-android', label: 'Móvil Android' },
  { value: 'both', label: 'E2E + Rendimiento' },
];

export function RegressionProgress({
  universe,
  credentials,
  slug,
}: {
  universe?: Universe;
  credentials?: Credentials;
  slug: string;
}) {
  const [open, setOpen] = useState(false);
  const [showDefine, setShowDefine] = useState(false);
  const [showCreds, setShowCreds] = useState(false);
  const hasUniverse = !!universe && !!universe.total_modules;
  const pct = hasUniverse ? universe!.pct : 0;

  return (
    <Card>
      {/* Header clickeable (colapsa/expande) */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 font-semibold">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Avance de la regresión
        </span>
        <span className="flex items-center gap-3">
          {hasUniverse ? (
            <span className="text-2xl font-bold tabular-nums text-success">{pct}%</span>
          ) : (
            <span className="text-xs text-muted-foreground">sin universo</span>
          )}
        </span>
      </button>

      {/* Resumen compacto cuando está colapsado */}
      {!open && hasUniverse && (
        <div className="px-4 pb-4">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {universe!.covered_modules}/{universe!.total_modules} módulos con automatización
          </p>
        </div>
      )}

      {/* Detalle al expandir */}
      {open && (
        <div className="space-y-4 px-4 pb-4">
          {hasUniverse ? <UniverseDetail universe={universe!} /> : <EmptyUniverse />}

          {/* Definir / actualizar universo (escanear sitio o construir desde repos) */}
          <Collapsible
            icon={ScanSearch}
            label={hasUniverse ? 'Redefinir universo de módulos' : 'Definir universo de módulos'}
            open={showDefine || !hasUniverse}
            onToggle={() => setShowDefine((v) => !v)}
          >
            <ScrapeControl slug={slug} />
            <ReposControl slug={slug} />
          </Collapsible>

          {/* Correr regresión */}
          <RunControl slug={slug} />

          {/* Credenciales y entornos (subsección colapsable) */}
          <Collapsible icon={KeyRound} label="Credenciales y entornos" open={showCreds} onToggle={() => setShowCreds((v) => !v)}>
            <CredentialsBody credentials={credentials} />
          </Collapsible>
        </div>
      )}
    </Card>
  );
}

function UniverseDetail({ universe }: { universe: Universe }) {
  const { covered_modules, total_modules, automated_stories, total_stories, modules } = universe;
  const pct = universe.pct;
  const counts = { covered: 0, partial: 0, pending: 0 };
  for (const m of modules) counts[m.status]++;

  return (
    <>
      <div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
          <span>{covered_modules}/{total_modules} módulos con automatización</span>
          <span>{total_modules - covered_modules} restantes</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <Stat n={counts.covered} label="Automatizados" cls="text-success" />
        <Stat n={counts.partial} label="Parciales" cls="text-warning" />
        <Stat n={counts.pending} label="Pendientes" cls="text-muted-foreground" />
      </div>
      {total_stories > 0 && (
        <p className="text-xs text-muted-foreground">{automated_stories}/{total_stories} historias automatizadas</p>
      )}

      <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
        {modules.map((m) => {
          const s = STATUS[m.status];
          const Icon = s.icon;
          const mpct = m.stories_total ? Math.round((m.automated / m.stories_total) * 100) : m.status === 'covered' ? 100 : m.status === 'partial' ? 50 : 0;
          return (
            <li key={m.name} className="flex items-center gap-2 text-sm">
              <Icon className={`h-4 w-4 shrink-0 ${s.cls}`} />
              <span className="flex-1 truncate" title={m.name}>{m.name}</span>
              {m.stories_total > 0 && (
                <span className="tabular-nums text-xs text-muted-foreground">{m.automated}/{m.stories_total}</span>
              )}
              <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full ${s.bar}`} style={{ width: `${mpct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>

      {universe.updated_at && (
        <p className="text-[10px] text-muted-foreground">Actualizado {new Date(universe.updated_at).toLocaleString()}</p>
      )}
    </>
  );
}

function EmptyUniverse() {
  return (
    <p className="text-sm text-muted-foreground">
      Aún no se definió el universo de módulos. Detectalo automáticamente abajo: escaneá el sitio
      o construilo desde los repos. El % subirá a medida que el QA automatice módulos.
    </p>
  );
}

/** Subsección colapsable reutilizable (acciones / credenciales). */
function Collapsible({
  icon: Icon,
  label,
  open,
  onToggle,
  children,
}: {
  icon: typeof ScanSearch;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border pt-3">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-1.5 text-sm font-medium">
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Icon className="h-4 w-4 text-muted-foreground" />
        {label}
      </button>
      {open && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  );
}

/** Escanear el sitio (Playwright + Gemini) para auto-detectar módulos. */
function ScrapeControl({ slug }: { slug: string }) {
  const [url, setUrl] = useState('');
  const scrape = useScrapeModules(slug);
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <p className="text-xs font-medium">Opción A · Escanear el sitio</p>
      <Input
        type="url"
        placeholder="URL a escanear (opcional, usa BASE_URL)"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        disabled={scrape.isPending}
        className="h-9 text-sm"
      />
      <Button
        onClick={() => scrape.mutate(url.trim() ? { url: url.trim() } : undefined)}
        disabled={scrape.isPending}
        variant="outline"
        className="w-full gap-2"
      >
        {scrape.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanSearch className="h-4 w-4" />}
        Escanear sitio
      </Button>
      <p className="text-[11px] text-muted-foreground">Loguea con los usuarios de prueba y detecta los módulos con IA.</p>
      <DispatchResult m={scrape} />
    </div>
  );
}

/** Construir el universo desde los repos backend/frontend (IA infiere los módulos). */
function ReposControl({ slug }: { slug: string }) {
  const [backend, setBackend] = useState('');
  const [frontend, setFrontend] = useState('');
  const build = useBuildFromRepos(slug);
  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
      <p className="text-xs font-medium">Opción B · Construir desde repos</p>
      <Input
        placeholder="Repo backend (owner/repo o URL)"
        value={backend}
        onChange={(e) => setBackend(e.target.value)}
        disabled={build.isPending}
        className="h-9 text-sm"
      />
      <Input
        placeholder="Repo frontend (opcional)"
        value={frontend}
        onChange={(e) => setFrontend(e.target.value)}
        disabled={build.isPending}
        className="h-9 text-sm"
      />
      <Button
        onClick={() => build.mutate({ backend_repo: backend.trim() || undefined, frontend_repo: frontend.trim() || undefined })}
        disabled={build.isPending || (!backend.trim() && !frontend.trim())}
        variant="outline"
        className="w-full gap-2"
      >
        {build.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderGit2 className="h-4 w-4" />}
        Construir desde repos
      </Button>
      <p className="text-[11px] text-muted-foreground">La IA lee la estructura de los repos e infiere los módulos.</p>
      <DispatchResult m={build} />
    </div>
  );
}

/** Selector de suite + botón ▶ que dispara la regresión, y estado de la última corrida. */
function RunControl({ slug }: { slug: string }) {
  const [suite, setSuite] = useState<RegressionSuite>('e2e');
  const run = useRunRegression(slug);
  const { data: runs } = useRegressionRuns();
  const latest = runs?.[0];

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <select
          value={suite}
          onChange={(e) => setSuite(e.target.value as RegressionSuite)}
          disabled={run.isPending}
          className="h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          aria-label="Tipo de prueba"
        >
          {SUITES.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <Button onClick={() => run.mutate(suite)} disabled={run.isPending} className="gap-2">
          {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Correr regresión
        </Button>
      </div>
      <DispatchResult m={run} />
      {latest && !run.isSuccess && <LatestRun run={latest} />}
    </div>
  );
}

/** Resultado común de un dispatch: éxito (link Actions) o error. */
function DispatchResult({ m }: { m: { isSuccess: boolean; isError: boolean; data?: { actions_url: string }; error?: unknown } }) {
  if (m.isSuccess && m.data) {
    return (
      <p className="text-xs text-success">
        Disparado.{' '}
        <a href={m.data.actions_url} target="_blank" rel="noreferrer" className="underline">
          Ver en GitHub Actions →
        </a>
      </p>
    );
  }
  if (m.isError) return <p className="text-xs text-destructive">{(m.error as Error).message}</p>;
  return null;
}

function LatestRun({ run }: { run: RegressionRun }) {
  const running = run.status !== 'completed';
  const ok = run.conclusion === 'success';
  const Icon = running ? Loader2 : ok ? CheckCircle2 : XCircle;
  const cls = running ? 'text-muted-foreground' : ok ? 'text-success' : 'text-destructive';
  const label = running ? 'En curso' : ok ? 'Éxito' : run.conclusion ?? 'Falló';
  return (
    <a href={run.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-muted-foreground hover:underline">
      <Icon className={`h-3.5 w-3.5 ${cls} ${running ? 'animate-spin' : ''}`} />
      <span>Última corrida: {label}</span>
      <span className="text-[10px]">· {new Date(run.created_at).toLocaleString()}</span>
    </a>
  );
}

function Stat({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div className="rounded-lg border border-border py-2">
      <div className={`text-lg font-bold tabular-nums ${cls}`}>{n}</div>
      <div className="text-muted-foreground">{label}</div>
    </div>
  );
}
