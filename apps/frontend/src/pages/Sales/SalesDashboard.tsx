import { Briefcase, Trophy, TrendingUp, Clock, BrainCircuit, Activity, CheckCircle2, XCircle } from 'lucide-react';
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useSalesOpportunities, useReindexKnowledge, useAiHealth } from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton, StatCardSkeleton } from '@/components/ui/skeleton';
import { SALES_STATUS_META } from '@/lib/sales-status';

// Mismos colores por variante que usa el resto del dashboard (SVG no
// resuelve var() en atributos fill, por eso son hex fijos acá).
const VARIANT_COLOR: Record<string, string> = {
  secondary: '#94a3b8',
  info: '#7c3aed',
  warning: '#f59e0b',
  success: '#10b981',
  destructive: '#ef4444',
};

export function SalesDashboard() {
  const { data: opportunities, isLoading } = useSalesOpportunities();
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');
  const reindex = useReindexKnowledge();
  const aiHealth = useAiHealth();
  const list = opportunities ?? [];

  const total = list.length;
  const ganadas = list.filter((o) => o.status === 'ganada').length;
  const perdidas = list.filter((o) => o.status === 'perdida').length;
  const enCurso = total - ganadas - perdidas - list.filter((o) => o.status === 'congelada').length;
  const cerradas = ganadas + perdidas;
  const tasaCierre = cerradas > 0 ? Math.round((ganadas / cerradas) * 100) : 0;

  const breakdown = Object.entries(SALES_STATUS_META).map(([key, meta]) => ({
    status: key,
    label: meta.label,
    count: list.filter((o) => o.status === key).length,
    color: VARIANT_COLOR[meta.variant] ?? '#94a3b8',
  }));

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)}
        </div>
        <Skeleton className="h-[280px] w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Oportunidades totales" value={total} icon={Briefcase} tone="primary" />
        <StatCard title="Ganadas" value={ganadas} icon={Trophy} tone="success" />
        <StatCard
          title="Tasa de cierre"
          value={`${tasaCierre}%`}
          icon={TrendingUp}
          tone={tasaCierre >= 50 ? 'success' : 'warning'}
          subtitle={cerradas > 0 ? `${ganadas} de ${cerradas} cerradas` : 'Sin cierres todavía'}
        />
        <StatCard title="En curso" value={Math.max(enCurso, 0)} icon={Clock} tone="info" />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-semibold text-foreground">Oportunidades por etapa</CardTitle>
        </CardHeader>
        <CardContent>
          {total === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Sin datos todavía — crea o sincroniza alguna oportunidad.
            </p>
          ) : (
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={breakdown} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    tickLine={false}
                    interval={0}
                    angle={-20}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      fontSize: '12px',
                      color: 'hsl(var(--foreground))',
                    }}
                  />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={56}>
                    {breakdown.map((b) => <Cell key={b.status} fill={b.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Base de conocimiento del agente (RAG): metodología (rules/13 +
          plantilla) + negocios ganados como ejemplos. El agente ya indexa la
          memoria de cada proceso solo, con cada mensaje; esto refresca lo
          compartido del equipo. */}
      {isVendedor && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <BrainCircuit className="h-5 w-5 text-primary" />
              </div>
              <div className="text-sm">
                <p className="font-medium text-foreground">Base de conocimiento del agente</p>
                <p className="text-muted-foreground">
                  Reindexa la metodología y los negocios ganados para que el agente proponga con
                  ejemplos reales. La memoria de cada proceso se guarda sola.
                </p>
                {reindex.data && (
                  <p className="mt-1 text-xs text-success">
                    Listo: {reindex.data.methodology} fuente(s) de metodología y {reindex.data.wonDeals} negocio(s) ganado(s).
                  </p>
                )}
                {reindex.isError && (
                  <p className="mt-1 text-xs text-destructive">{(reindex.error as Error).message}</p>
                )}
              </div>
            </div>
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => reindex.mutate()}
              disabled={reindex.isPending}
            >
              <BrainCircuit className="mr-2 h-4 w-4" />
              {reindex.isPending ? 'Reindexando…' : 'Reindexar conocimiento'}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Diagnóstico de los proveedores de IA — para ver si Gemini está saturado
          y si Groq/DeepSeek responden como respaldo. */}
      {isVendedor && (
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Activity className="h-5 w-5 text-primary" />
                </div>
                <div className="text-sm">
                  <p className="font-medium text-foreground">Estado del asistente (IA)</p>
                  <p className="text-muted-foreground">
                    Prueba en vivo qué modelo responde. Si el chat falla, acá ves cuál está caído.
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => aiHealth.mutate()}
                disabled={aiHealth.isPending}
              >
                <Activity className="mr-2 h-4 w-4" />
                {aiHealth.isPending ? 'Probando…' : 'Probar modelos'}
              </Button>
            </div>
            {aiHealth.data && (
              <ul className="space-y-1.5">
                {aiHealth.data.map((p) => (
                  <li key={p.provider} className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      {!p.configured ? (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : p.ok ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                      )}
                      <span className="font-medium text-foreground">{p.provider}</span>
                      <span className="ml-auto text-muted-foreground">
                        {!p.configured ? 'sin key' : p.ok ? `ok · ${p.ms}ms` : 'falla'}
                      </span>
                    </div>
                    {!p.ok && p.error && (
                      <p className="mt-1 break-words pl-5 text-[11px] text-destructive/80">{p.error}</p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {aiHealth.isError && (
              <p className="text-xs text-destructive">{(aiHealth.error as Error).message}</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
