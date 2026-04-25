import { useParams, Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useProject } from '@/hooks/use-projects';
import { useTestSuites } from '@/hooks/use-test-cases';
import { useTestRuns } from '@/hooks/use-test-runs';
import { useJiraConfig } from '@/hooks/use-jira';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatCard } from '@/components/ui/stat-card';
import type { JiraConfig } from '@qa/shared-types';
import {
  TestTube2,
  Play,
  Brain,
  ExternalLink,
  FileBarChart,
  Bug,
  Layers,
  BarChart3,
  Clock,
  Activity,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ArrowRight,
  Zap,
  Settings2,
} from 'lucide-react';
import { useState } from 'react';
import { EditProjectModal } from './EditProjectModal';

export function ProjectDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const { data: project, isLoading } = useProject(id!);
  const { data: suites } = useTestSuites(id!);
  const { data: runs } = useTestRuns(id!);
  const { data: jiraConfig, isLoading: loadingJira } = useJiraConfig(id!);
  const [editOpen, setEditOpen] = useState(false);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('projects.loading')}</p>;
  if (!project) return <p className="text-destructive">{t('projects.projectNotFound')}</p>;

  const recentRuns = runs?.slice(0, 5) ?? [];
  const totalRuns = runs?.length ?? 0;
  const passedRuns = runs?.filter((r) => r.status === 'completed').length ?? 0;
  const passRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0;
  const lastRun = runs?.[0];

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-semibold text-[#1e1b4b]">{project.name}</h1>
              <div className="mt-2 flex items-center gap-3 flex-wrap">
                {project.base_url ? (
                  <a
                    href={project.base_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-sm text-muted-foreground hover:text-[#7c3aed] truncate max-w-xs"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    {project.base_url}
                  </a>
                ) : (
                  <span className="flex items-center gap-1 text-sm text-amber-600">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {t('editProject.noBaseUrl')}
                  </span>
                )}
                <EnvironmentBadge environment={project.environment} />
              </div>
              {project.description && (
                <p className="mt-2 text-sm text-muted-foreground">{project.description}</p>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditOpen(true)}
              className="shrink-0 ml-4 gap-1.5 text-xs"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {t('editProject.editBtn')}
            </Button>
          </div>

          {/* Action buttons row */}
          <div className="mt-5 flex flex-wrap gap-2">
            <Link to={`/projects/${id}/generate`}>
              <Button
                size="sm"
                className="h-8 gap-1.5 bg-[rgba(124,58,237,0.1)] text-[#7c3aed] hover:bg-[rgba(124,58,237,0.2)] border-0 shadow-none"
              >
                <Brain className="h-3.5 w-3.5" />
                {t('projects.generateTestsWithAI')}
              </Button>
            </Link>
            <Link to={`/projects/${id}/test-cases`}>
              <Button
                size="sm"
                className="h-8 gap-1.5 bg-[rgba(139,92,246,0.1)] text-[#8b5cf6] hover:bg-[rgba(139,92,246,0.2)] border-0 shadow-none"
              >
                <TestTube2 className="h-3.5 w-3.5" />
                {t('projects.testCases')}
              </Button>
            </Link>
            <Link to={`/projects/${id}/run`}>
              <Button
                size="sm"
                className="h-8 gap-1.5 bg-[rgba(16,185,129,0.1)] text-[#10b981] hover:bg-[rgba(16,185,129,0.2)] border-0 shadow-none"
              >
                <Play className="h-3.5 w-3.5" />
                {t('projects.runTests')}
              </Button>
            </Link>
            <Link to={`/projects/${id}/reports`}>
              <Button
                size="sm"
                className="h-8 gap-1.5 bg-[rgba(245,158,11,0.1)] text-[#f59e0b] hover:bg-[rgba(245,158,11,0.2)] border-0 shadow-none"
              >
                <FileBarChart className="h-3.5 w-3.5" />
                {t('projects.reports')}
              </Button>
            </Link>
            <Link to={`/projects/${id}/jira`}>
              <JiraButton jiraConfig={jiraConfig ?? null} loading={loadingJira} t={t} />
            </Link>
          </div>

          {/* Jira Integration Status Banner */}
          {!loadingJira && (
            <JiraStatusBanner jiraConfig={jiraConfig ?? null} projectId={id!} t={t} />
          )}
        </CardContent>
      </Card>

      {/* Stats Row */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title={t('projects.totalSuites')}
          value={suites?.length ?? 0}
          icon={Layers}
          iconBg="rgba(124,58,237,0.15)"
          iconColor="#7c3aed"
          subtitle={t('projects.testSuitesSubtitle')}
        />
        <StatCard
          title={t('projects.totalRuns')}
          value={totalRuns}
          icon={Activity}
          iconBg="rgba(139,92,246,0.15)"
          iconColor="#8b5cf6"
          subtitle={t('projects.allTime')}
        />
        <StatCard
          title={t('projects.passRate')}
          value={totalRuns > 0 ? `${passRate}%` : '--'}
          icon={BarChart3}
          iconBg="rgba(16,185,129,0.15)"
          iconColor="#10b981"
          subtitle={t('projects.completedRuns')}
        />
        <StatCard
          title={t('projects.lastRun')}
          value={lastRun ? formatTimeAgo(lastRun.created_at, t) : '--'}
          icon={Clock}
          iconBg="rgba(245,158,11,0.15)"
          iconColor="#f59e0b"
          subtitle={lastRun ? lastRun.status : t('projects.noRunsYet')}
        />
      </div>

      {/* Test Suites */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle className="text-base font-semibold text-[#1e1b4b]">
            {t('projects.testSuites', { count: suites?.length ?? 0 })}
          </CardTitle>
          <Link to={`/projects/${id}/test-cases`} className="text-xs font-medium text-[#7c3aed] hover:underline">
            {t('projects.viewAll')}
          </Link>
        </CardHeader>
        <CardContent>
          {!suites?.length ? (
            <div className="py-6 text-center">
              <Layers className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                {t('projects.noTestSuitesYet')}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-3 pr-4">{t('projects.tableHeaderName')}</th>
                    <th className="pb-3 pr-4">{t('projects.tableHeaderType')}</th>
                    <th className="pb-3 pr-4">{t('projects.tableHeaderSource')}</th>
                    <th className="pb-3 text-right">{t('projects.tableHeaderCreated')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {suites.map((suite) => (
                    <tr key={suite.id} className="transition-colors hover:bg-[#f5f3ff]/60">
                      <td className="py-3 pr-4 font-medium text-[#1e1b4b]">{suite.name}</td>
                      <td className="py-3 pr-4">
                        <Badge variant="outline" className="text-xs capitalize">
                          {suite.test_type}
                        </Badge>
                      </td>
                      <td className="py-3 pr-4">
                        {suite.is_ai_generated ? (
                          <Badge variant="successSoft">{t('projects.aiGenerated')}</Badge>
                        ) : (
                          <Badge variant="secondary">{t('projects.manual')}</Badge>
                        )}
                      </td>
                      <td className="py-3 text-right text-xs text-muted-foreground">
                        {new Date(suite.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit project modal */}
      {editOpen && (
        <EditProjectModal project={project} onClose={() => setEditOpen(false)} />
      )}

      {/* Recent Test Runs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle className="text-base font-semibold text-[#1e1b4b]">{t('projects.recentTestRuns')}</CardTitle>
        </CardHeader>
        <CardContent>
          {!recentRuns.length ? (
            <div className="py-6 text-center">
              <Play className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">{t('projects.noTestRunsYet')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="pb-3 pr-4">{t('projects.tableHeaderStatus')}</th>
                    <th className="pb-3 pr-4">{t('projects.tableHeaderBrowser')}</th>
                    <th className="pb-3 pr-4">{t('projects.tableHeaderPassFailSkip')}</th>
                    <th className="pb-3 pr-4">{t('projects.tableHeaderDuration')}</th>
                    <th className="pb-3 text-right">{t('projects.tableHeaderDate')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {recentRuns.map((run) => (
                    <tr key={run.id} className="transition-colors hover:bg-[#f5f3ff]/60">
                      <td className="py-3 pr-4">
                        <Link to={`/test-runs/${run.id}`}>
                          <StatusBadge status={run.status} />
                        </Link>
                      </td>
                      <td className="py-3 pr-4 capitalize text-[#1e1b4b]">{run.browser}</td>
                      <td className="py-3 pr-4">
                        <span className="text-[#10b981] font-medium">{run.passed}</span>
                        {' / '}
                        <span className="text-[#ef4444] font-medium">{run.failed}</span>
                        {' / '}
                        <span className="text-muted-foreground">{run.skipped}</span>
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : '--'}
                      </td>
                      <td className="py-3 text-right text-xs text-muted-foreground">
                        {new Date(run.created_at).toLocaleDateString()}
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

// ─── Jira helpers ──────────────────────────────────────────────────────────

type JiraStatus = 'connected-active' | 'connected-inactive' | 'not-configured';

function getJiraStatus(cfg: JiraConfig | null): JiraStatus {
  if (!cfg) return 'not-configured';
  if (cfg.auto_create_on_failure) return 'connected-active';
  return 'connected-inactive';
}

/** Action-row button — shows a coloured dot based on Jira status */
function JiraButton({
  jiraConfig,
  loading,
  t,
}: {
  jiraConfig: JiraConfig | null;
  loading: boolean;
  t: (k: string) => string;
}) {
  const status = getJiraStatus(jiraConfig);
  const dotColor =
    status === 'connected-active'
      ? 'bg-[#10b981]'
      : status === 'connected-inactive'
      ? 'bg-[#f59e0b]'
      : 'bg-[#ef4444]';

  return (
    <Button
      size="sm"
      className="h-8 gap-1.5 bg-secondary text-secondary-foreground hover:bg-secondary/80 border-0 shadow-none"
    >
      <span className="relative flex items-center">
        <Bug className="h-3.5 w-3.5" />
        {!loading && (
          <span
            className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ${dotColor} ring-1 ring-white`}
          />
        )}
      </span>
      {t('projects.jiraConfig')}
    </Button>
  );
}

/** Compact banner below action buttons showing Jira integration state */
function JiraStatusBanner({
  jiraConfig,
  projectId,
  t,
}: {
  jiraConfig: JiraConfig | null;
  projectId: string;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const status = getJiraStatus(jiraConfig);

  if (status === 'not-configured') {
    return (
      <div className="mt-4 flex items-start gap-3 rounded-lg border border-[#fecaca] bg-[#fef2f2] px-4 py-3">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#ef4444]" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[#991b1b]">
            {t('projects.jiraNotConfigured')}
          </p>
          <p className="mt-0.5 text-xs text-[#b91c1c]">
            {t('projects.jiraNotConfiguredHint')}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {['jiraUrl', 'jiraEmail', 'jiraToken', 'jiraProjectKey'].map((field) => (
              <span
                key={field}
                className="inline-flex items-center gap-1 rounded-full border border-[#fca5a5] bg-white px-2 py-0.5 text-xs text-[#991b1b]"
              >
                <XCircle className="h-3 w-3" />
                {t(`projects.jiraField_${field}`)}
              </span>
            ))}
          </div>
        </div>
        <Link to={`/projects/${projectId}/jira`} className="shrink-0">
          <Button size="sm" className="h-7 gap-1 bg-[#ef4444] hover:bg-[#dc2626] text-white text-xs">
            {t('projects.jiraConfigure')}
            <ArrowRight className="h-3 w-3" />
          </Button>
        </Link>
      </div>
    );
  }

  if (status === 'connected-inactive') {
    return (
      <div className="mt-4 flex items-start gap-3 rounded-lg border border-[#fde68a] bg-[#fffbeb] px-4 py-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#d97706]" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[#92400e]">
            {t('projects.jiraConnectedInactive')}
          </p>
          <p className="mt-0.5 text-xs text-[#b45309]">
            {t('projects.jiraConnectedInactiveHint', {
              project: jiraConfig!.jira_project_key,
            })}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full border border-[#fcd34d] bg-white px-2 py-0.5 text-xs text-[#92400e]">
              <CheckCircle2 className="h-3 w-3 text-[#10b981]" />
              {t('projects.jiraField_jiraUrl')}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-[#fcd34d] bg-white px-2 py-0.5 text-xs text-[#92400e]">
              <CheckCircle2 className="h-3 w-3 text-[#10b981]" />
              {t('projects.jiraField_jiraProjectKey')}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full border border-[#fcd34d] bg-white px-2 py-0.5 text-xs text-[#92400e]">
              <AlertTriangle className="h-3 w-3 text-[#d97706]" />
              {t('projects.jiraAutoCreateDisabled')}
            </span>
          </div>
        </div>
        <Link to={`/projects/${projectId}/jira`} className="shrink-0">
          <Button size="sm" className="h-7 gap-1 bg-[#d97706] hover:bg-[#b45309] text-white text-xs">
            <Zap className="h-3 w-3" />
            {t('projects.jiraActivate')}
          </Button>
        </Link>
      </div>
    );
  }

  // connected-active
  return (
    <div className="mt-4 flex items-center gap-3 rounded-lg border border-[#bbf7d0] bg-[#f0fdf4] px-4 py-3">
      <CheckCircle2 className="h-4 w-4 shrink-0 text-[#10b981]" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[#065f46]">
          {t('projects.jiraConnectedActive')}
        </p>
        <p className="mt-0.5 text-xs text-[#047857]">
          {t('projects.jiraConnectedActiveHint', {
            project: jiraConfig!.jira_project_key,
            issueType: jiraConfig!.issue_type,
          })}
        </p>
      </div>
      <Link to={`/projects/${projectId}/jira`} className="shrink-0">
        <Button size="sm" variant="outline" className="h-7 text-xs border-[#86efac] text-[#065f46] hover:bg-[#dcfce7]">
          {t('projects.jiraManage')}
        </Button>
      </Link>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const variants: Record<string, 'default' | 'success' | 'destructive' | 'warning' | 'secondary' | 'info'> = {
    pending: 'secondary',
    queued: 'secondary',
    running: 'warning',
    completed: 'success',
    failed: 'destructive',
    cancelled: 'info',
  };
  return <Badge variant={variants[status] || 'secondary'}>{t(`status.${status}`, status)}</Badge>;
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

function formatTimeAgo(dateStr: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t('projects.justNow');
  if (diffMins < 60) return t('projects.minutesAgo', { count: diffMins });
  if (diffHours < 24) return t('projects.hoursAgo', { count: diffHours });
  if (diffDays < 7) return t('projects.daysAgo', { count: diffDays });
  return date.toLocaleDateString();
}
