import { useProjects } from '@/hooks/use-projects';
import { useClients, type ClientSummary } from '@/hooks/use-dashboard';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatCard, type StatTone } from '@/components/ui/stat-card';
import { Skeleton, StatCardSkeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router';
import {
  type LucideIcon,
  FolderKanban,
  ShieldCheck,
  AlertTriangle,
  TestTube2,
  Plus,
  ArrowRight,
  Brain,
  RotateCcw,
  FileBarChart,
  ExternalLink,
  CheckCircle2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// Paleta fija de marca para las series del gráfico (SVG no resuelve var() en
// atributos `fill`). El resto del chrome usa tokens del tema.
const CHART = { good: '#10b981', mid: '#f59e0b', bad: '#ef4444', primary: '#7c3aed' };
const barColor = (rate: number) => (rate >= 90 ? CHART.good : rate >= 70 ? CHART.mid : CHART.bad);

export function DashboardPage() {
  const { t } = useTranslation();
  const { data: projects, isLoading: loadingProjects } = useProjects();
  const { data: clients, isLoading: loadingClients } = useClients();

  const list: ClientSummary[] = clients ?? [];
  const executed = list.filter((c) => c.latest_run && c.latest_run.total > 0);
  const avgPass = executed.length
    ? Math.round(executed.reduce((a, c) => a + c.pass_rate, 0) / executed.length)
    : 0;
  const avgCoverage = executed.length
    ? Math.round(executed.reduce((a, c) => a + c.coverage_pct, 0) / executed.length)
    : 0;
  const totalRegressions = list.reduce((a, c) => a + c.open_regressions, 0);

  const passByClient = executed
    .map((c) => ({ name: c.display_name, slug: c.slug, passRate: c.pass_rate }))
    .sort((a, b) => b.passRate - a.passRate);
  const withRegressions = list
    .filter((c) => c.open_regressions > 0)
    .sort((a, b) => b.open_regressions - a.open_regressions);

  return (
    <div className="space-y-6">
      {/* ───── Header ───── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t('dashboard.overviewTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('dashboard.overviewSubtitle')}</p>
        </div>
        <Link to="/clients">
          <Button variant="outline" className="shadow-sm">
            {t('dashboard.viewAllClients')}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </Link>
      </div>

      {/* ───── KPIs globales (datos reales de clientes) ───── */}
      {loadingClients ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title={t('clients.totalClients')}
            value={list.length}
            icon={FolderKanban}
            tone="primary"
            subtitle={t('dashboard.executedOf', { executed: executed.length, total: list.length })}
          />
          <StatCard title={t('clients.avgPassRate')} value={`${avgPass}%`} icon={ShieldCheck} tone="success" />
          <StatCard title={t('clients.avgCoverage')} value={`${avgCoverage}%`} icon={TestTube2} tone="info" />
          <StatCard
            title={t('clients.openRegressions')}
            value={totalRegressions}
            icon={AlertTriangle}
            tone={totalRegressions > 0 ? 'destructive' : 'success'}
          />
        </div>
      )}

      {/* ───── Pass rate por cliente + Regresiones ───── */}
      <div className="grid gap-6 lg:grid-cols-5">
        {/* Pass rate por cliente (real) */}
        <Card className="lg:col-span-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-foreground">
              {t('dashboard.passRateByClient')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingClients ? (
              <Skeleton className="h-[280px] w-full" />
            ) : passByClient.length === 0 ? (
              <EmptyHint icon={TestTube2} text={t('dashboard.noClientRuns')} />
            ) : (
              <div className="h-[280px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={passByClient} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
                      axisLine={{ stroke: 'hsl(var(--border))' }}
                      tickLine={false}
                      interval={0}
                      angle={-15}
                      textAnchor="end"
                      height={50}
                    />
                    <YAxis
                      domain={[0, 100]}
                      unit="%"
                      tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'hsl(var(--muted))', opacity: 0.4 }}
                      formatter={(v: number) => [`${v}%`, t('clients.passRate')]}
                      contentStyle={{
                        backgroundColor: 'hsl(var(--card))',
                        border: '1px solid hsl(var(--border))',
                        borderRadius: '8px',
                        fontSize: '12px',
                        color: 'hsl(var(--foreground))',
                      }}
                    />
                    <Bar dataKey="passRate" radius={[4, 4, 0, 0]} maxBarSize={56}>
                      {passByClient.map((c) => (
                        <Cell key={c.slug} fill={barColor(c.passRate)} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Regresiones abiertas por cliente (real, accionable) */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-foreground">
              {t('dashboard.regressionsByClient')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loadingClients ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : withRegressions.length === 0 ? (
              <EmptyHint icon={CheckCircle2} text={t('dashboard.noOpenRegressions')} tone="success" />
            ) : (
              <ul className="divide-y">
                {withRegressions.map((c) => (
                  <li key={c.slug}>
                    <Link
                      to={`/clients/${c.slug}`}
                      className="flex items-center justify-between gap-2 py-2.5 transition-colors hover:text-primary"
                    >
                      <span className="truncate text-sm font-medium text-foreground">{c.display_name}</span>
                      <Badge variant="destructive">{c.open_regressions}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ───── Quick Actions ───── */}
      <div>
        <h2 className="mb-3 text-base font-semibold text-foreground">{t('dashboard.quickActions')}</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Link to={projects?.[0] ? `/projects/${projects[0].id}/generate` : '/projects/new'}>
            <Card className="group cursor-pointer border-0 bg-gradient-to-br from-primary to-accent text-primary-foreground transition-all hover:scale-[1.02] hover:shadow-lg">
              <CardContent className="flex items-center gap-4 p-5">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white/20">
                  <Brain className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{t('dashboard.generateAITests')}</p>
                  <p className="text-xs text-primary-foreground/75">{t('dashboard.generateAITestsDesc')}</p>
                </div>
              </CardContent>
            </Card>
          </Link>

          <QuickAction
            to={projects?.[0] ? `/projects/${projects[0].id}/run` : '/projects/new'}
            icon={RotateCcw}
            tone="success"
            title={t('dashboard.runRegression')}
            desc={t('dashboard.runRegressionDesc')}
          />
          <QuickAction
            to={projects?.[0] ? `/projects/${projects[0].id}/reports` : '/projects/new'}
            icon={FileBarChart}
            tone="warning"
            title={t('dashboard.viewReports')}
            desc={t('dashboard.viewReportsDesc')}
          />
        </div>
      </div>

      {/* ───── Recent Projects ───── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle className="text-base font-semibold text-foreground">{t('dashboard.recentProjects')}</CardTitle>
          <Link to="/projects" className="text-xs font-medium text-primary hover:underline">
            {t('dashboard.viewAll')}
          </Link>
        </CardHeader>
        <CardContent>
          {loadingProjects ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : projects?.length === 0 ? (
            <div className="py-8 text-center">
              <FolderKanban className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
              <p className="text-muted-foreground">{t('dashboard.noProjectsYet')}</p>
              <Link to="/projects/new">
                <Button variant="outline" className="mt-4">
                  <Plus className="mr-2 h-4 w-4" />
                  {t('dashboard.createFirstProject')}
                </Button>
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-3 pr-4">{t('dashboard.tableHeaderName')}</th>
                    <th className="pb-3 pr-4">{t('dashboard.tableHeaderUrl')}</th>
                    <th className="pb-3 pr-4">{t('dashboard.tableHeaderEnvironment')}</th>
                    <th className="pb-3 pr-4">{t('dashboard.tableHeaderStatus')}</th>
                    <th className="pb-3 text-right">{t('dashboard.tableHeaderActions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {projects?.slice(0, 5).map((project) => (
                    <tr key={project.id} className="transition-colors hover:bg-muted/50">
                      <td className="py-3 pr-4 font-medium text-foreground">{project.name}</td>
                      <td className="py-3 pr-4">
                        <a
                          href={project.base_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-muted-foreground hover:text-primary"
                        >
                          <ExternalLink className="h-3 w-3" />
                          <span className="max-w-[180px] truncate">{project.base_url}</span>
                        </a>
                      </td>
                      <td className="py-3 pr-4">
                        <EnvironmentBadge environment={project.environment} />
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant="successSoft">{t('dashboard.statusActive')}</Badge>
                      </td>
                      <td className="py-3 text-right">
                        <Link to={`/projects/${project.id}`}>
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-primary hover:bg-muted">
                            {t('dashboard.view')} <ArrowRight className="ml-1 h-3 w-3" />
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────── */

function QuickAction({
  to,
  icon: Icon,
  tone,
  title,
  desc,
}: {
  to: string;
  icon: LucideIcon;
  tone: StatTone;
  title: string;
  desc: string;
}) {
  const toneCls: Record<StatTone, string> = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    destructive: 'bg-destructive/10 text-destructive',
    info: 'bg-info/10 text-info',
  };
  return (
    <Link to={to}>
      <Card className="group cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg">
        <CardContent className="flex items-center gap-4 p-5">
          <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${toneCls[tone]}`}>
            <Icon className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground">{desc}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function EmptyHint({
  icon: Icon,
  text,
  tone = 'muted',
}: {
  icon: LucideIcon;
  text: string;
  tone?: 'muted' | 'success';
}) {
  return (
    <div className="flex h-[200px] flex-col items-center justify-center text-center">
      <Icon className={`mb-3 h-10 w-10 ${tone === 'success' ? 'text-success' : 'text-muted-foreground/50'}`} />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function EnvironmentBadge({ environment }: { environment: string }) {
  const { t } = useTranslation();
  switch (environment) {
    case 'development':
      return <Badge variant="info">{t('common.development')}</Badge>;
    case 'staging':
      return <Badge variant="warning">{t('common.staging')}</Badge>;
    case 'production':
      return <Badge variant="success">{t('common.production')}</Badge>;
    default:
      return <Badge variant="secondary">{environment}</Badge>;
  }
}
