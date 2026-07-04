import { Briefcase, Trophy, TrendingUp, Clock } from 'lucide-react';
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useSalesOpportunities } from '@/hooks/use-sales';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
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
              Sin datos todavía — creá o sincronizá alguna oportunidad.
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
    </div>
  );
}
