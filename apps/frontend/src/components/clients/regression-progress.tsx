import { CheckCircle2, CircleDashed, CircleDot } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Universe, UniverseModule } from '@/hooks/use-dashboard';

/**
 * Widget de AVANCE DE REGRESIÓN por producto. Muestra, de forma didáctica, qué % de
 * los módulos del producto (el "universo", de modules.md en el monorepo) tienen
 * regresión automatizada, el detalle por módulo, y lo que falta. Se alimenta solo:
 * el monorepo empuja el universo (qa:universe-sync) y cada corrida lo actualiza.
 */
const STATUS: Record<UniverseModule['status'], { icon: typeof CheckCircle2; cls: string; bar: string }> = {
  covered: { icon: CheckCircle2, cls: 'text-success', bar: 'bg-success' },
  partial: { icon: CircleDot, cls: 'text-warning', bar: 'bg-warning' },
  pending: { icon: CircleDashed, cls: 'text-muted-foreground', bar: 'bg-muted-foreground/30' },
};

export function RegressionProgress({ universe }: { universe?: Universe }) {
  if (!universe || !universe.total_modules) {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle>Avance de la regresión</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Aún no se definió el universo de módulos de este producto. El QA lo siembra con{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run modules:seed -- &lt;cliente&gt;</code>{' '}
            y lo sincroniza con <code className="rounded bg-muted px-1 py-0.5 text-xs">qa:universe-sync</code>.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { pct, covered_modules, total_modules, automated_stories, total_stories, modules } = universe;
  const counts = { covered: 0, partial: 0, pending: 0 };
  for (const m of modules) counts[m.status]++;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle>Avance de la regresión</CardTitle>
          <span className="text-2xl font-bold tabular-nums text-success">{pct}%</span>
        </div>
      </CardHeader>
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

        {universe.updated_at && (
          <p className="text-[10px] text-muted-foreground">
            Actualizado {new Date(universe.updated_at).toLocaleString()}
          </p>
        )}
      </CardContent>
    </Card>
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
