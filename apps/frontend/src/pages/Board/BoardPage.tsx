import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ExternalLink,
  LayoutGrid,
  KeyRound,
  AlertCircle,
  FolderGit2,
  Users,
  Tag,
  Columns3,
  FilterX,
} from 'lucide-react';
import { useScrumBoards, useScrumBoard } from '@/hooks/use-scrum';
import type { ScrumCard, ScrumIssueType } from '@qa/shared-types';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { IssueTypeIcon, PriorityFlag, IssueKey, EstimateChip } from '@/components/scrum/issue-bits';
import { Avatar, SearchBox, FilterMenu, SprintBar, type FilterOption } from './board-toolbar';

const TYPE_LABEL: Record<ScrumIssueType, string> = {
  epic: 'Épica',
  story: 'Historia',
  task: 'Tarea',
  bug: 'Bug',
  spike: 'Spike',
  unknown: 'Sin tipo',
};

export function BoardPage() {
  const { t } = useTranslation();
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const { data: boards } = useScrumBoards();
  const { data: board, isLoading } = useScrumBoard(slug);

  // ── Estado de filtros ──────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [sprint, setSprint] = useState('');
  const [assignees, setAssignees] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<string>>(new Set());

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void) => (v: string) => {
    const next = new Set(set);
    next.has(v) ? next.delete(v) : next.add(v);
    setter(next);
  };

  // ── Opciones de filtro derivadas del board ─────────────────────────────
  const allCards = useMemo(() => (board?.columns ?? []).flatMap((c) => c.cards), [board]);

  const assigneeOptions: FilterOption[] = useMemo(() => {
    const map = new Map<string, FilterOption>();
    const add = (login: string, avatarUrl: string | null) => {
      if (!map.has(login))
        map.set(login, { value: login, label: login, adornment: <Avatar login={login} url={avatarUrl} size={20} /> });
    };
    // Miembros de la org (asignables) + cualquiera ya asignado a una tarjeta.
    for (const m of board?.members ?? []) add(m.login, m.avatarUrl);
    for (const c of allCards) for (const a of c.assignees) add(a.login, a.avatarUrl);
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [board, allCards]);

  const typeOptions: FilterOption[] = useMemo(() => {
    const present = new Set(allCards.map((c) => c.type));
    return (Object.keys(TYPE_LABEL) as ScrumIssueType[])
      .filter((ty) => present.has(ty))
      .map((ty) => ({ value: ty, label: TYPE_LABEL[ty], adornment: <IssueTypeIcon type={ty} /> }));
  }, [allCards]);

  const statusOptions: FilterOption[] = useMemo(
    () => (board?.columns ?? []).map((c) => ({ value: c.key, label: c.title })),
    [board],
  );

  // ── Aplicar filtros ────────────────────────────────────────────────────
  const matches = (c: ScrumCard) => {
    if (sprint && c.sprint !== sprint) return false;
    if (assignees.size && !c.assignees.some((a) => assignees.has(a.login))) return false;
    if (types.size && !types.has(c.type)) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!c.title.toLowerCase().includes(q) && !`#${c.number ?? ''}`.includes(q)) return false;
    }
    return true;
  };

  const visibleColumns = (board?.columns ?? [])
    .filter((col) => statuses.size === 0 || statuses.has(col.key))
    .map((col) => ({ ...col, cards: col.cards.filter(matches) }));

  const totalShown = visibleColumns.reduce((n, c) => n + c.cards.length, 0);
  const activeFilters = search.length + sprint.length + assignees.size + types.size + statuses.size;

  const clearAll = () => {
    setSearch('');
    setSprint('');
    setAssignees(new Set());
    setTypes(new Set());
    setStatuses(new Set());
  };

  return (
    <div className="space-y-4">
      {/* ── Encabezado + selector de cliente ─────────────────────────────── */}
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
                'rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
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
          {/* ── Barra de filtros (estilo Jira) ───────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 p-2.5">
            <SearchBox value={search} onChange={setSearch} />
            <FilterMenu
              label="Persona"
              icon={<Users className="h-4 w-4" />}
              options={assigneeOptions}
              selected={assignees}
              onToggle={toggle(assignees, setAssignees)}
              onClear={() => setAssignees(new Set())}
            />
            <FilterMenu
              label="Tipo"
              icon={<Tag className="h-4 w-4" />}
              options={typeOptions}
              selected={types}
              onToggle={toggle(types, setTypes)}
              onClear={() => setTypes(new Set())}
            />
            <FilterMenu
              label="Estado"
              icon={<Columns3 className="h-4 w-4" />}
              options={statusOptions}
              selected={statuses}
              onToggle={toggle(statuses, setStatuses)}
              onClear={() => setStatuses(new Set())}
            />
            {activeFilters > 0 && (
              <button
                onClick={clearAll}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <FilterX className="h-4 w-4" /> Limpiar
              </button>
            )}
            <div className="ml-auto flex items-center gap-3 pr-1 text-xs text-muted-foreground">
              <span>{totalShown} tarjeta{totalShown === 1 ? '' : 's'}</span>
              {board.project_url && (
                <a
                  href={board.project_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> {t('board.openInGithub')}
                </a>
              )}
            </div>
          </div>

          {/* ── Sprints (con fechas + abierto/cerrado) ───────────────────── */}
          {board.sprints.length > 0 && (
            <SprintBar sprints={board.sprints} meta={board.sprintsMeta ?? []} active={sprint} onPick={setSprint} />
          )}

          {/* ── Kanban ───────────────────────────────────────────────────── */}
          <div className="flex gap-4 overflow-x-auto pb-3">
            {visibleColumns.map((col) => (
              <div key={col.key} className="flex w-72 shrink-0 flex-col">
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {col.title}
                  </span>
                  <span className="rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">
                    {col.cards.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2 rounded-xl bg-muted/40 p-2">
                  {col.cards.length === 0 ? (
                    <p className="px-1 py-8 text-center text-xs text-muted-foreground/60">—</p>
                  ) : (
                    col.cards.map((card) => <IssueCard key={card.id} card={card} />)
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Tarjeta de issue (estilo Jira) ─────────────────────────────────────── */
function IssueCard({ card }: { card: ScrumCard }) {
  const inner = (
    <Card className="cursor-pointer border-border/70 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
      <CardContent className="space-y-2 p-3">
        <p className="line-clamp-3 text-sm text-foreground">{card.title}</p>
        {(card.area || card.labels.length > 0) && (
          <div className="flex flex-wrap gap-1">
            {card.area && (
              <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {card.area}
              </span>
            )}
            {card.labels.slice(0, 2).map((l) => (
              <span
                key={l}
                className="inline-block rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              >
                {l}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <IssueTypeIcon type={card.type} />
          <IssueKey number={card.number} />
          <div className="ml-auto flex items-center gap-1.5">
            <PriorityFlag priority={card.priority} />
            <EstimateChip estimate={card.estimate} />
            <AssigneeStack assignees={card.assignees} />
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

function AssigneeStack({ assignees }: { assignees: ScrumCard['assignees'] }) {
  if (!assignees.length) return null;
  return (
    <div className="flex -space-x-1.5">
      {assignees.slice(0, 3).map((a) => (
        <Avatar key={a.login} login={a.login} url={a.avatarUrl} size={20} />
      ))}
    </div>
  );
}

/* ── Estados ────────────────────────────────────────────────────────────── */
function NotConfigured({ reason }: { reason: string | null }) {
  const { t } = useTranslation();
  const key =
    reason && ['missing_github_token', 'board_not_found', 'github_error', 'client_not_found'].includes(reason)
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
