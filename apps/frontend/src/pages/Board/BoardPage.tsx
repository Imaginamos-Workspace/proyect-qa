import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ExternalLink, LayoutGrid, KeyRound, AlertCircle, FolderGit2 } from 'lucide-react';
import { useScrumBoards, useScrumBoard } from '@/hooks/use-scrum';
import type { ScrumCard } from '@qa/shared-types';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import {
  IssueTypeIcon,
  PriorityFlag,
  IssueKey,
  EstimateChip,
} from '@/components/scrum/issue-bits';

export function BoardPage() {
  const { t } = useTranslation();
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const { data: boards } = useScrumBoards();
  const { data: board, isLoading } = useScrumBoard(slug);
  const [sprint, setSprint] = useState<string>('');

  return (
    <div className="space-y-5">
      {/* Header + selector de cliente (cambiador de proyecto, estilo Jira) */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold text-foreground">{t('board.title')}</h1>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(boards ?? []).map((b) => (
            <button
              key={b.client_slug}
              onClick={() => navigate(`/board/${b.client_slug}`)}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                b.client_slug === slug
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {b.client_name}
            </button>
          ))}
        </div>
      </div>

      {!slug ? (
        <EmptyState icon={FolderGit2} title={t('board.pickClient')} />
      ) : isLoading ? (
        <BoardSkeleton />
      ) : !board ? (
        <EmptyState icon={AlertCircle} title={t('board.error')} />
      ) : !board.configured ? (
        <NotConfigured reason={board.reason} />
      ) : (
        <>
          {/* Barra: sprints + link al Project */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {board.sprints.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <SprintChip active={sprint === ''} onClick={() => setSprint('')} label={t('board.allSprints')} />
                {board.sprints.map((s) => (
                  <SprintChip key={s} active={sprint === s} onClick={() => setSprint(s)} label={s} />
                ))}
              </div>
            ) : (
              <span />
            )}
            {board.project_url && (
              <a
                href={board.project_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" /> {t('board.openInGithub')}
              </a>
            )}
          </div>

          {/* Kanban */}
          <div className="flex gap-4 overflow-x-auto pb-3">
            {board.columns.map((col) => {
              const cards = sprint ? col.cards.filter((c) => c.sprint === sprint) : col.cards;
              return (
                <div key={col.key} className="flex w-72 shrink-0 flex-col">
                  <div className="mb-2 flex items-center justify-between px-1">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {col.title}
                    </span>
                    <span className="rounded bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
                      {cards.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2">
                    {cards.length === 0 ? (
                      <p className="px-1 py-6 text-center text-xs text-muted-foreground/70">—</p>
                    ) : (
                      cards.map((card) => <IssueCard key={card.id} card={card} />)
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Tarjeta de issue (estilo Jira) ─────────────────────────────────────── */
function IssueCard({ card }: { card: ScrumCard }) {
  const inner = (
    <Card className="cursor-pointer transition-shadow hover:shadow-md">
      <CardContent className="space-y-2 p-3">
        <p className="line-clamp-3 text-sm text-foreground">{card.title}</p>
        {card.area && (
          <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {card.area}
          </span>
        )}
        <div className="flex items-center gap-2">
          <IssueTypeIcon type={card.type} />
          <IssueKey number={card.number} />
          <div className="ml-auto flex items-center gap-1.5">
            <PriorityFlag priority={card.priority} />
            <EstimateChip estimate={card.estimate} />
            <Assignees assignees={card.assignees} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
  return card.url ? (
    <a href={card.url} target="_blank" rel="noreferrer">
      {inner}
    </a>
  ) : (
    inner
  );
}

function Assignees({ assignees }: { assignees: ScrumCard['assignees'] }) {
  if (!assignees.length) return null;
  return (
    <div className="flex -space-x-1.5">
      {assignees.slice(0, 3).map((a) =>
        a.avatarUrl ? (
          <img
            key={a.login}
            src={a.avatarUrl}
            alt={a.login}
            title={a.login}
            className="h-5 w-5 rounded-full border border-card"
          />
        ) : (
          <span
            key={a.login}
            title={a.login}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-card bg-primary/15 text-[9px] font-semibold uppercase text-primary"
          >
            {a.login.slice(0, 2)}
          </span>
        ),
      )}
    </div>
  );
}

function SprintChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {label}
    </button>
  );
}

/* ── Estados ────────────────────────────────────────────────────────────── */
function NotConfigured({ reason }: { reason: string | null }) {
  const { t } = useTranslation();
  const key = reason && ['missing_github_token', 'board_not_found', 'github_error', 'client_not_found'].includes(reason)
    ? reason
    : 'github_error';
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <KeyRound className="h-10 w-10 text-muted-foreground/50" />
        <p className="font-medium text-foreground">{t('board.notConfigured.title')}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t(`board.notConfigured.${key}`)}</p>
      </CardContent>
    </Card>
  );
}

function EmptyState({ icon: Icon, title }: { icon: typeof FolderGit2; title: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
        <Icon className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{title}</p>
      </CardContent>
    </Card>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex gap-4 overflow-hidden">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="w-72 shrink-0 space-y-2">
          <Skeleton className="h-4 w-24" />
          {Array.from({ length: 3 }).map((__, j) => (
            <Skeleton key={j} className="h-20 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
