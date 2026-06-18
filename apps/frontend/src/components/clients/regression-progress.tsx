import { useState } from 'react';
import { CheckCircle2, CircleDashed, CircleDot, Loader2, Play, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { Universe, UniverseModule } from '@/hooks/use-dashboard';
import {
  useRegressionRuns,
  useRunRegression,
  type RegressionRun,
  type RegressionSuite,
} from '@/hooks/use-regression';

/**
 * Widget de AVANCE DE REGRESIÓN por producto. Muestra, de forma didáctica, qué % de
 * los módulos del producto (el "universo", de modules.md en el monorepo) tienen
 * regresión automatizada, el detalle por módulo, y lo que falta. Se alimenta solo:
 * el monorepo empuja el universo (qa:universe-sync) y cada corrida lo actualiza.
 *
 * Incluye el botón ▶ Correr regresión, que dispara qa-regression.yml en el monorepo
 * (workflow_dispatch). El pipeline corre en Actions y empuja el resultado de vuelta.
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

export function RegressionProgress({ universe, slug }: { universe?: Universe; slug: string }) {
  const hasUniverse = !!universe && !!universe.total_modules;

  const header = (
    <CardHeader className="pb-2">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Avance de la regresión</CardTitle>
        {hasUniverse && (
          <span className="text-2xl font-bold tabular-nums text-success">{universe!.pct}%</span>
        )}
      </div>
    </CardHeader>
  );

  if (!hasUniverse) {
    return (
      <Card>
        {header}
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Aún no se definió el universo de módulos de este producto. El QA lo siembra con{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run modules:seed -- &lt;cliente&gt;</code>{' '}
            y lo sincroniza con <code className="rounded bg-muted px-1 py-0.5 text-xs">qa:universe-sync</code>.
          </p>
          <RunControl slug={slug} />
        </CardContent>
      </Card>
    );
  }

  const { covered_modules, total_modules, automated_stories, total_stories, modules } = universe!;
  const pct = universe!.pct;
  const counts = { covered: 0, partial: 0, pending: 0 };
  for (const m of modules) counts[m.status]++;

  return (
    <Card>
      {header}
      <CardContent className="space-y-4">
        {/* Barra de avance global (por módulos) */}
        <div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
            <span>{covered_modules}/{total_modules} módulos con automatización</span>
            <span>{total_modules - covered_modules} restantes</span>
          </div>
        </div>

        {/* Resumen por estado */}
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <Stat n={counts.covered} label="Automatizados" cls="text-success" />
          <Stat n={counts.partial} label="Parciales" cls="text-warning" />
          <Stat n={counts.pending} label="Pendientes" cls="text-muted-foreground" />
        </div>
        <p className="text-xs text-muted-foreground">
          {automated_stories}/{total_stories} historias automatizadas
        </p>

        {/* Detalle por módulo */}
        <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {modules.map((m) => {
            const s = STATUS[m.status];
            const Icon = s.icon;
            const mpct = m.stories_total ? Math.round((m.automated / m.stories_total) * 100) : 0;
            return (
              <li key={m.name} className="flex items-center gap-2 text-sm">
                <Icon className={`h-4 w-4 shrink-0 ${s.cls}`} />
                <span className="flex-1 truncate" title={m.name}>{m.name}</span>
                <span className="tabular-nums text-xs text-muted-foreground">{m.automated}/{m.stories_total}</span>
                <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full ${s.bar}`} style={{ width: `${mpct}%` }} />
                </div>
              </li>
            );
          })}
        </ul>

        {universe!.updated_at && (
          <p className="text-[10px] text-muted-foreground">
            Actualizado {new Date(universe!.updated_at).toLocaleString()}
          </p>
        )}

        <RunControl slug={slug} />
      </CardContent>
    </Card>
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

      {run.isSuccess && (
        <p className="text-xs text-success">
          Regresión disparada.{' '}
          <a href={run.data.actions_url} target="_blank" rel="noreferrer" className="underline">
            Ver en GitHub Actions →
          </a>
        </p>
      )}
      {run.isError && (
        <p className="text-xs text-destructive">{(run.error as Error).message}</p>
      )}

      {latest && !run.isSuccess && <LatestRun run={latest} />}
    </div>
  );
}

function LatestRun({ run }: { run: RegressionRun }) {
  const running = run.status !== 'completed';
  const ok = run.conclusion === 'success';
  const Icon = running ? Loader2 : ok ? CheckCircle2 : XCircle;
  const cls = running ? 'text-muted-foreground' : ok ? 'text-success' : 'text-destructive';
  const label = running ? 'En curso' : ok ? 'Éxito' : run.conclusion ?? 'Falló';
  return (
    <a
      href={run.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:underline"
    >
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
