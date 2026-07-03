import { useMemo } from 'react';
import {
  ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { CheckCircle2, Circle, Layers, Gauge } from 'lucide-react';
import type { ScrumBoard, ScrumCard } from '@qa/shared-types';

const isDone = (s: string | null) =>
  !!s && /\b(done|hecho|listo|complet|cerrad|finaliz|resuel)/i.test(s);
const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#84cc16'];
// Story points de la tarjeta: el campo Puntos (number) si existe; si no, fallback
// a la talla legacy S/M/L/XL → puntos aprox.
const legacy = (e: string | null): number => {
  if (!e) return 0;
  const n = Number(e);
  if (Number.isFinite(n)) return n;
  return { S: 1, M: 2, L: 3, XL: 5 }[e.trim().toUpperCase()] ?? 0;
};
const points = (c: ScrumCard): number => (typeof c.points === 'number' ? c.points : legacy(c.estimate));

/** Vista PROGRESO: gráficas del avance del sprint seleccionado, desde el estado del
 *  tablero (Status / Estimación / responsable). Sin datos de git: el aporte por
 *  persona es "quién tiene/cerró qué" en el sprint. */
export function BoardSprint({ board, sprint }: { board: ScrumBoard; sprint: string }) {
  const cards = useMemo(
    () => board.columns.flatMap((c) => c.cards).filter((c) => c.sprint === sprint),
    [board.columns, sprint],
  );

  const { total, done, ptsTotal, ptsDone, byStatus, byPerson } = useMemo(() => {
    const byStatusMap = new Map<string, number>();
    const byPersonMap = new Map<string, { done: number; pending: number }>();
    let d = 0, pt = 0, pd = 0;
    for (const c of cards) {
      const finished = isDone(c.status);
      if (finished) d += 1;
      const p = points(c);
      pt += p;
      if (finished) pd += p;
      byStatusMap.set(c.status ?? 'Sin estado', (byStatusMap.get(c.status ?? 'Sin estado') ?? 0) + 1);
      const people: string[] = c.assignees.length ? c.assignees.map((a) => a.login) : ['Sin asignar'];
      for (const login of people) {
        const e = byPersonMap.get(login) ?? { done: 0, pending: 0 };
        if (finished) e.done += 1; else e.pending += 1;
        byPersonMap.set(login, e);
      }
    }
    return {
      total: cards.length,
      done: d,
      ptsTotal: pt,
      ptsDone: pd,
      byStatus: [...byStatusMap.entries()].map(([name, value]) => ({ name, value })),
      byPerson: [...byPersonMap.entries()]
        .map(([name, v]) => ({ name, ...v, total: v.done + v.pending }))
        .sort((a, b) => b.total - a.total),
    };
  }, [cards]);

  if (!sprint || sprint === '__none__') {
    return <Empty text="Elegí un sprint en el selector para ver su progreso." />;
  }
  if (total === 0) {
    return <Empty text={`El sprint "${sprint}" no tiene tarjetas.`} />;
  }

  const pctDone = Math.round((done / total) * 100);

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi icon={Layers} label="Tarjetas" value={total} />
        <Kpi icon={CheckCircle2} label="Hechas" value={done} tone="success" />
        <Kpi icon={Circle} label="Pendientes" value={total - done} />
        <Kpi icon={Gauge} label="Avance" value={`${pctDone}%`} tone="primary" />
      </div>

      {/* Barra de avance global */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-1.5 flex items-center justify-between text-sm">
          <span className="font-medium text-foreground">Avance del sprint · {sprint}</span>
          <span className="text-muted-foreground">
            {done}/{total} tarjetas{ptsTotal > 0 ? ` · ${ptsDone}/${ptsTotal} pts` : ''}
          </span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-success transition-all" style={{ width: `${pctDone}%` }} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Distribución por estado */}
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="mb-2 text-sm font-medium text-foreground">Por estado</h3>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={byStatus} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} innerRadius={50} paddingAngle={2}>
                {byStatus.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Aporte por responsable */}
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="mb-2 text-sm font-medium text-foreground">Aporte por responsable</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={byPerson} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
              <XAxis type="number" allowDecimals={false} className="text-xs" />
              <YAxis type="category" dataKey="name" width={90} className="text-xs" />
              <Tooltip />
              <Legend />
              <Bar dataKey="done" stackId="a" name="Hechas" fill="#22c55e" radius={[0, 0, 0, 0]} />
              <Bar dataKey="pending" stackId="a" name="Pendientes" fill="#94a3b8" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        Datos del tablero (Status / Estimación / responsable). El aporte por persona refleja las
        tarjetas asignadas y cerradas en el sprint, no actividad de git.
      </p>
    </div>
  );
}

function Kpi({ icon: Icon, label, value, tone }: { icon: typeof Layers; label: string; value: number | string; tone?: 'success' | 'primary' }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <p className={`mt-1 text-2xl font-bold ${tone === 'success' ? 'text-success' : tone === 'primary' ? 'text-primary' : 'text-foreground'}`}>
        {value}
      </p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 px-4 py-10 text-center text-sm text-muted-foreground">{text}</div>
  );
}
