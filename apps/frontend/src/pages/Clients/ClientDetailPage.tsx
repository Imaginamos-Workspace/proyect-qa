import { useParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { ArrowLeft, ExternalLink, ShieldCheck, Gauge, AlertTriangle, Clock, TestTube2 } from 'lucide-react';
import { useClient, type Regression } from '@/hooks/use-dashboard';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton, StatCardSkeleton } from '@/components/ui/skeleton';
import { RegressionProgress } from '@/components/clients/regression-progress';

const KIND_VARIANT: Record<Regression['kind'], 'destructive' | 'success' | 'warning'> = {
  new_fail: 'destructive',
  fixed: 'success',
  flaky: 'warning',
};

export function ClientDetailPage() {
  const { t } = useTranslation();
  const { slug = '' } = useParams();
  const { data: client, isLoading, isError, refetch } = useClient(slug);

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm text-muted-foreground">No se pudo cargar el cliente (timeout o error de red).</p>
        <button
          onClick={() => refetch()}
          className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Reintentar
        </button>
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }
  if (!client) return <p className="text-muted-foreground">{t('clients.notFound')}</p>;

  const latest = client.latest_run;
  // "Ejecutado" = la última corrida realmente corrió pruebas (el gate de CI solo
  // ejecuta specs graduados; un 0/0 significa nada ejecutado, no 0% pasando).
  const executed = !!latest && latest.total > 0;
  const chartData = (client.runs ?? [])
    .filter((r) => r.total > 0)
    .map((r) => ({
      name: r.commit_sha ? r.commit_sha.slice(0, 7) : new Date(r.created_at).toLocaleDateString(),
      passed: r.passed,
      failed: r.failed,
    }));
  const modules = latest?.coverage?.modules ?? [];
  const invModules = client.inventory?.modules ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/clients" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">{client.display_name}</h1>
            <p className="text-sm text-muted-foreground">{client.slug}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {client.reports_url && (
            <a href={client.reports_url} target="_blank" rel="noreferrer"
               className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-accent">
              <ExternalLink className="h-4 w-4" /> {t('clients.viewReport')}
            </a>
          )}
          {client.designs_url && (
            <a href={client.designs_url} target="_blank" rel="noreferrer"
               className="inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm hover:bg-accent">
              <ExternalLink className="h-4 w-4" /> {t('clients.viewDesigns')}
            </a>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {executed ? (
          <>
            <StatCard title={t('clients.passRate')} value={`${client.pass_rate}%`} icon={ShieldCheck} tone="success" />
            <StatCard title={t('clients.coverage')} value={`${client.coverage_pct}%`} icon={Gauge} tone="info"
              subtitle={`${latest.coverage?.specs_covered ?? 0}/${latest.coverage?.specs_total ?? 0} specs`} />
            <StatCard title={t('clients.openRegressions')} value={client.regressions.filter((r) => r.kind === 'new_fail').length} icon={AlertTriangle} tone="destructive" />
            <StatCard title={t('clients.lastRun')} value={`${latest.passed}/${latest.total}`} icon={Clock} tone="primary"
              subtitle={latest.actor_login ? `@${latest.actor_login}` : ''} />
          </>
        ) : (
          <>
            <StatCard title={t('clients.testsWritten')} value={client.inventory?.tests_total ?? 0} icon={TestTube2} tone="info" />
            <StatCard title={t('clients.specs')} value={client.inventory?.specs_total ?? 0} icon={Gauge} tone="primary" />
            <StatCard title={t('clients.modules')} value={client.inventory?.modules?.length ?? 0} icon={ShieldCheck} tone="success" />
            <StatCard title={t('clients.quality')} value={t('clients.notExecuted')} icon={Clock} tone="warning" />
          </>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle>{t('clients.progress')}</CardTitle></CardHeader>
        <CardContent>
          {chartData.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('clients.noRuns')}</p>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="gP" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gF" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ef4444" stopOpacity={0.6} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="name" fontSize={12} stroke="hsl(var(--muted-foreground))" />
                <YAxis fontSize={12} allowDecimals={false} stroke="hsl(var(--muted-foreground))" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: 'hsl(var(--foreground))',
                  }}
                />
                <Area type="monotone" dataKey="passed" stroke="#10b981" fill="url(#gP)" name={t('clients.passed')} />
                <Area type="monotone" dataKey="failed" stroke="#ef4444" fill="url(#gF)" name={t('clients.failed')} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <RegressionProgress universe={client.inventory?.universe} slug={client.slug} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{executed ? t('clients.coverageByModule') : t('clients.writtenByModule')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {executed ? (
              modules.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('clients.noData')}</p>
              ) : modules.map((m) => {
                const pct = m.total ? Math.round((m.passed / m.total) * 100) : 0;
                return (
                  <div key={m.name}>
                    <div className="flex justify-between text-sm">
                      <span>{m.name}</span>
                      <span className="text-muted-foreground">{m.passed}/{m.total}</span>
                    </div>
                    <div className="mt-1 h-2 w-full rounded bg-muted">
                      <div className="h-2 rounded bg-success" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })
            ) : invModules.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('clients.noData')}</p>
            ) : (
              invModules.map((m) => (
                <div key={m.name} className="flex items-center justify-between text-sm">
                  <span className="min-w-0 truncate">{m.name}</span>
                  <span className="shrink-0 text-muted-foreground">{m.tests} {t('clients.testsShort')}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t('clients.regressionsTitle')}</CardTitle></CardHeader>
          <CardContent>
            {client.regressions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('clients.noRegressions')}</p>
            ) : (
              <div className="space-y-2">
                {client.regressions.map((r) => (
                  <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{r.title}</span>
                    <Badge variant={KIND_VARIANT[r.kind]}>{t(`clients.kind.${r.kind}`)}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {latest && (
        <Card>
          <CardHeader><CardTitle>{t('clients.reproduce')}</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p>{t('clients.suite')}: <code>{latest.suite}</code> · {t('clients.commit')}: <code>{latest.commit_sha?.slice(0, 7) ?? '—'}</code> · {t('clients.branch')}: <code>{latest.branch ?? '—'}</code></p>
            {latest.gh_run_url && (
              <a href={latest.gh_run_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                <ExternalLink className="h-3.5 w-3.5" /> {t('clients.viewCiRun')}
              </a>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
