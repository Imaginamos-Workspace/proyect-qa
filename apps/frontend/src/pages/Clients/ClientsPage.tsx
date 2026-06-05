import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { FolderKanban, ShieldCheck, AlertTriangle, TestTube2 } from 'lucide-react';
import { useClients } from '@/hooks/use-dashboard';
import { StatCard } from '@/components/ui/stat-card';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton, StatCardSkeleton } from '@/components/ui/skeleton';

function passRateVariant(rate: number): 'success' | 'warning' | 'destructive' {
  if (rate >= 90) return 'success';
  if (rate >= 70) return 'warning';
  return 'destructive';
}

export function ClientsPage() {
  const { t } = useTranslation();
  const { data: clients, isLoading } = useClients();

  const list = clients ?? [];
  const totalClients = list.length;
  const executed = list.filter((c) => c.latest_run && c.latest_run.total > 0);
  const avgPass = executed.length
    ? Math.round(executed.reduce((a, c) => a + c.pass_rate, 0) / executed.length)
    : 0;
  const totalRegressions = list.reduce((a, c) => a + c.open_regressions, 0);
  const totalTests = list.reduce((a, c) => a + (c.inventory?.tests_total ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('clients.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('clients.subtitle')}</p>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard title={t('clients.totalClients')} value={totalClients} icon={FolderKanban} tone="primary" />
          <StatCard title={t('clients.testsWritten')} value={totalTests} icon={TestTube2} tone="info" />
          <StatCard title={t('clients.avgPassRate')} value={`${avgPass}%`} icon={ShieldCheck} tone="success" />
          <StatCard title={t('clients.openRegressions')} value={totalRegressions} icon={AlertTriangle} tone={totalRegressions > 0 ? 'destructive' : 'success'} />
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">{t('clients.empty')}</CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => (
            <Link key={c.slug} to={`/clients/${c.slug}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <CardContent className="space-y-3 p-5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{c.display_name}</span>
                    {c.latest_run && c.latest_run.total > 0 ? (
                      <Badge variant={passRateVariant(c.pass_rate)}>{c.pass_rate}% OK</Badge>
                    ) : (
                      <Badge variant="info">{c.inventory?.tests_total ?? 0} {t('clients.testsShort')}</Badge>
                    )}
                  </div>
                  {c.latest_run ? (
                    <>
                      <div className="flex gap-4 text-sm text-muted-foreground">
                        <span>{t('clients.coverage')}: {c.coverage_pct}%</span>
                        <span className={c.open_regressions > 0 ? 'text-destructive' : ''}>
                          {c.open_regressions} {t('clients.regressions')}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t('clients.lastRun')}: {new Date(c.latest_run.created_at).toLocaleString()}
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex gap-4 text-sm text-muted-foreground">
                        <span>{c.inventory?.specs_total ?? 0} specs</span>
                        <span>{c.inventory?.modules?.length ?? 0} {t('clients.modulesShort')}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{t('clients.notExecuted')}</p>
                    </>
                  )}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
