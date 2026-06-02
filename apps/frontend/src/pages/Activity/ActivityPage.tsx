import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TestTube2, Palette, Bug, GitCommit, Play } from 'lucide-react';
import { useActivity, usePeople, type Activity } from '@/hooks/use-dashboard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const KIND_ICON: Record<Activity['kind'], typeof Play> = {
  test: TestTube2,
  design: Palette,
  bug: Bug,
  commit: GitCommit,
  run: Play,
};

export function ActivityPage() {
  const { t } = useTranslation();
  const [actor, setActor] = useState<string | undefined>();
  const { data: people } = usePeople();
  const { data: activity, isLoading } = useActivity({ actor, limit: 100 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('activity.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('activity.subtitle')}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        {/* Personas */}
        <Card className="h-fit">
          <CardHeader><CardTitle>{t('activity.team')}</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            <button
              onClick={() => setActor(undefined)}
              className={`w-full rounded-md px-3 py-2 text-left text-sm ${!actor ? 'bg-accent font-medium' : 'hover:bg-accent'}`}
            >
              {t('activity.everyone')}
            </button>
            {(people ?? []).map((p) => (
              <button
                key={p.actor_login}
                onClick={() => setActor(p.actor_login)}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${actor === p.actor_login ? 'bg-accent font-medium' : 'hover:bg-accent'}`}
              >
                <img src={`https://github.com/${p.actor_login}.png?size=40`} alt="" className="h-6 w-6 rounded-full bg-muted" />
                <span className="min-w-0 flex-1 truncate">{p.actor_login}</span>
                <span className="text-xs text-muted-foreground">{p.total}</span>
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Feed */}
        <Card>
          <CardHeader><CardTitle>{actor ? `@${actor}` : t('activity.recent')}</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? (
              <p className="text-muted-foreground">{t('common.loading')}</p>
            ) : (activity ?? []).length === 0 ? (
              <p className="text-muted-foreground">{t('activity.empty')}</p>
            ) : (
              <div className="space-y-3">
                {(activity ?? []).map((a) => {
                  const Icon = KIND_ICON[a.kind] ?? Play;
                  return (
                    <div key={a.id} className="flex items-start gap-3">
                      <img src={`https://github.com/${a.actor_login}.png?size=48`} alt="" className="mt-0.5 h-8 w-8 rounded-full bg-muted" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm">
                          <span className="font-medium">{a.actor_login}</span>{' '}
                          {a.url ? (
                            <a href={a.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">{a.title}</a>
                          ) : a.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(a.ts).toLocaleString()}{a.client_slug ? ` · ${a.client_slug}` : ''}
                        </p>
                      </div>
                      <Badge variant="secondary" className="shrink-0">
                        <Icon className="mr-1 h-3 w-3" />{t(`activity.kind.${a.kind}`)}
                      </Badge>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
