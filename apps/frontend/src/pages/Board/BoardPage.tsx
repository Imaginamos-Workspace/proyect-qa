import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
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
import { useScrumBoards, useScrumBoard, useScrumMe, useMoveCard } from '@/hooks/use-scrum';
import type { ScrumCard, ScrumIssueType, ScrumStoryTests } from '@qa/shared-types';
import { TestsBadge, TraceabilityButton } from './board-traceability';
import { AssigneePicker } from './board-assignee';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { IssueTypeIcon, PriorityFlag, IssueKey, EstimateChip } from '@/components/scrum/issue-bits';
import { Avatar, SearchBox, FilterMenu, SprintSelect, ClientSelect, ViewSwitcher, NO_SPRINT, type FilterOption, type BoardView } from './board-toolbar';
import { BoardList } from './board-list';
import { BoardRoadmap } from './board-roadmap';
import { BoardSprint } from './board-sprint';
import { CreateIssueDialog } from './board-create';
import { SprintControls } from './board-sprint-controls';
import { useClient } from '@/hooks/use-dashboard';
import { RegressionProgress } from '@/components/clients/regression-progress';

const TYPE_LABEL: Record<ScrumIssueType, string> = {
  epic: 'Épica',
  story: 'Historia',
  task: 'Tarea',
  bug: 'Bug',
  incident: 'Incidencia',
  spike: 'Spike',
  unknown: 'Sin tipo',
};

export function BoardPage() {
  const { t } = useTranslation();
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  // Vista activa en la URL (?view=) → compartible y sobrevive recargas.
  const [searchParams, setSearchParams] = useSearchParams();
  const view = ((searchParams.get('view') as BoardView) || 'board');
  const setView = (v: BoardView) =>
    setSearchParams((p) => { const n = new URLSearchParams(p); n.set('view', v); return n; }, { replace: true });
  const { data: boards } = useScrumBoards();
  const { data: board, isLoading } = useScrumBoard(slug);
  // Inventario del cliente (universo de regresión + credenciales) para los paneles
  // del tablero. Es un fetch aparte del board (dashboard), cacheado por react-query.
  const { data: client } = useClient(slug);

  // ── Permiso + estado de drag-and-drop (mover tarjetas entre columnas) ───
  const { data: me } = useScrumMe();
  const canMove = !!me?.canMove;
  const move = useMoveCard(slug);
  const [dragIssue, setDragIssue] = useState<number | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  // ── Estado de filtros ──────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  // El sprint es una SELECCIÓN explícita del usuario; null = usar el default
  // (sprint activo). Por defecto el tablero muestra SOLO el sprint activo, nunca
  // todas las tarjetas → no renderiza cientos de tarjetas de golpe.
  const [sprintOverride, setSprintOverride] = useState<string | null>(null);
  const [assignees, setAssignees] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [statuses, setStatuses] = useState<Set<string>>(new Set());

  // Al cambiar de cliente volvemos al default (el sprint activo del nuevo board).
  useEffect(() => setSprintOverride(null), [slug]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void) => (v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setter(next);
  };

  // ── Opciones de filtro derivadas del board ─────────────────────────────
  const allCards = useMemo(() => (board?.columns ?? []).flatMap((c) => c.cards), [board]);
  const noSprintCount = useMemo(() => allCards.filter((c) => !c.sprint).length, [allCards]);

  // Sprint activo + issues abiertos por sprint (para el default y el selector).
  const { activeSprint, openBySprint } = useMemo(() => {
    const openBy = new Map<string, number>();
    // Columnas "terminadas" detectadas por nombre (dinámico): el workflow es el del
    // cliente (p. ej. "Listo en Staging" matchea por "listo", "Finalizada"), no una
    // lista fija. "staging" NO va solo en esta lista: es un ambiente de despliegue,
    // no un estado de finalización — una columna llamada "En Staging" (validación
    // pendiente) NO es lo mismo que "terminado" (bug real: hacía que equirent-fleet,
    // con casi todo su trabajo real en "En Staging", pareciera no tener tareas
    // abiertas en NINGÚN sprint, y el tablero caía a un sprint sin tarjetas).
    const isDone = (key: string) => /\b(done|hecho|listo|complet|cerrad|finaliz|resuel)/i.test(key);
    for (const col of board?.columns ?? []) {
      if (isDone(col.key)) continue;
      for (const c of col.cards) if (c.sprint) openBy.set(c.sprint, (openBy.get(c.sprint) ?? 0) + 1);
    }
    const meta = board?.sprintsMeta ?? [];
    const today = new Date().toISOString().slice(0, 10);
    // 1) activo por fecha: hoy dentro del rango y no cerrado.
    let active =
      meta.find((m) => !m.completed && m.startDate && m.endDate && m.startDate <= today && today <= m.endDate)?.title ?? null;
    // 2) si las fechas están mal/ausentes: el sprint MÁS RECIENTE con issues abiertos.
    if (!active) {
      const withOpen = meta
        .filter((m) => (openBy.get(m.title) ?? 0) > 0)
        .sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
      active = withOpen[0]?.title
        ?? [...openBy.keys()].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
        ?? null;
    }
    return { activeSprint: active, openBySprint: openBy };
  }, [board]);

  // Sprint efectivo: el elegido por el usuario, o el default (activo, o el más
  // reciente si no se detecta activo). El tablero SIEMPRE filtra por un sprint.
  const sprints = board?.sprints ?? [];
  const defaultSprint = activeSprint ?? sprints[sprints.length - 1] ?? '';
  const sprint = sprintOverride ?? defaultSprint;

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
    if (sprint === NO_SPRINT) {
      if (c.sprint) return false; // solo tarjetas sin sprint asignado
    } else if (sprint && c.sprint !== sprint) {
      return false;
    }
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
  // Mismos issues filtrados, en plano (para la vista Lista).
  const visibleCards = visibleColumns.flatMap((col) => col.cards);
  const showFilters = view === 'board' || view === 'list';

  // Trazabilidad: resultado de pruebas por historia (#N) de la última corrida.
  const testsByStory = useMemo(
    () => new Map((board?.qa?.story_map ?? []).map((e) => [e.story, e])),
    [board],
  );

  const totalShown = visibleColumns.reduce((n, c) => n + c.cards.length, 0);
  // El sprint ya no cuenta como filtro "limpiable": siempre hay uno seleccionado.
  const activeFilters = search.length + assignees.size + types.size + statuses.size;

  const clearAll = () => {
    setSearch('');
    setSprintOverride(null); // vuelve al sprint activo, no a "todos"
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
        <div className="flex items-center gap-2">
          <ClientSelect
            clients={boards ?? []}
            currentSlug={slug}
            onPick={(s) => navigate(`/board/${s}`)}
          />
          {board?.configured && <CreateIssueDialog slug={slug} />}
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
          <ViewSwitcher value={view} onChange={setView} />

          {/* ── Barra de filtros (estilo Jira) — vistas Tablero/Lista ────── */}
          {showFilters && (
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
            <TraceabilityButton board={board} />
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
          )}

          {/* ── Sprints (Tablero/Lista/Progreso; el Roadmap muestra todos) ─ */}
          {(showFilters || view === 'sprint') && board.sprints.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <SprintSelect
                sprints={board.sprints}
                meta={board.sprintsMeta ?? []}
                value={sprint}
                onPick={setSprintOverride}
                activeTitle={activeSprint}
                openByTitle={openBySprint}
                noSprintCount={noSprintCount}
              />
              {activeSprint && sprint !== activeSprint && (
                <button
                  onClick={() => setSprintOverride(activeSprint)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-3 text-sm font-medium text-success transition-colors hover:bg-success/20"
                >
                  Ir al sprint activo
                </button>
              )}
              <SprintControls slug={slug} sprint={sprint} />
            </div>
          )}

          {/* ── Widget de regresión (solo Tablero) ───────────────────────── */}
          {view === 'board' && (
            <RegressionProgress
              universe={client?.inventory?.universe}
              credentials={client?.inventory?.credentials}
              slug={slug}
            />
          )}

          {/* ── Vista LISTA (datatable) ──────────────────────────────────── */}
          {view === 'list' && <BoardList cards={visibleCards} />}

          {/* ── Vista ROADMAP (Gantt de épicas) ──────────────────────────── */}
          {view === 'roadmap' && <BoardRoadmap board={board} slug={slug} />}

          {/* ── Vista PROGRESO (gráficas del sprint) ─────────────────────── */}
          {view === 'sprint' && <BoardSprint board={board} sprint={sprint} />}

          {/* ── Vista TABLERO (kanban) ───────────────────────────────────── */}
          {view === 'board' && (
          <>
          {move.isError && (
            <p className="mb-2 rounded-md bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
              {move.error instanceof Error ? move.error.message : 'No se pudo mover la tarjeta.'}
            </p>
          )}
          <div className="flex gap-4 overflow-x-auto pb-3">
            {visibleColumns.map((col) => (
              <div
                key={col.key}
                className="flex w-72 shrink-0 flex-col"
                onDragOver={(e) => {
                  if (canMove && dragIssue != null) {
                    e.preventDefault();
                    if (overCol !== col.key) setOverCol(col.key);
                  }
                }}
                onDragLeave={() => setOverCol((c) => (c === col.key ? null : c))}
                onDrop={(e) => {
                  e.preventDefault();
                  const issue = dragIssue ?? Number(e.dataTransfer.getData('text/plain'));
                  setOverCol(null);
                  setDragIssue(null);
                  if (canMove && issue && !Number.isNaN(issue) && !col.cards.some((c) => c.number === issue)) {
                    move.mutate({ issue, status: col.key });
                  }
                }}
              >
                <div className="mb-2 flex items-center justify-between px-1">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {col.title}
                  </span>
                  <span className="rounded-full bg-muted px-2 text-[11px] font-medium text-muted-foreground">
                    {col.cards.length}
                  </span>
                </div>
                <div
                  className={cn(
                    'flex min-h-[3rem] flex-col gap-2 rounded-xl bg-muted/40 p-2 transition-colors',
                    overCol === col.key && canMove && 'bg-primary/5 ring-2 ring-primary/40',
                  )}
                >
                  {col.cards.length === 0 ? (
                    <p className="px-1 py-8 text-center text-xs text-muted-foreground/60">—</p>
                  ) : (
                    col.cards.map((card) => {
                      const draggable = canMove && card.number != null;
                      return (
                        <div
                          key={card.id}
                          draggable={draggable}
                          onDragStart={(e) => {
                            if (!draggable) return;
                            setDragIssue(card.number as number);
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('text/plain', String(card.number));
                          }}
                          onDragEnd={() => {
                            setDragIssue(null);
                            setOverCol(null);
                          }}
                          className={cn(
                            draggable && 'cursor-grab active:cursor-grabbing',
                            dragIssue === card.number && 'opacity-40',
                          )}
                        >
                          <IssueCard
                            card={card}
                            qaEntry={card.number != null ? testsByStory.get(card.number) : undefined}
                            reportUrl={board.qa?.report_url}
                            slug={slug}
                            members={board.members ?? []}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
          </>
          )}
        </>
      )}
    </div>
  );
}

/* ── Tarjeta de issue (estilo Jira) ─────────────────────────────────────── */
function IssueCard({
  card,
  qaEntry,
  reportUrl,
  slug,
  members,
}: {
  card: ScrumCard;
  qaEntry?: ScrumStoryTests;
  reportUrl?: string | null;
  slug: string;
  members: import('@qa/shared-types').ScrumAssignee[];
}) {
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
          <TestsBadge entry={qaEntry} reportUrl={reportUrl} />
          <div className="ml-auto flex items-center gap-1.5">
            <PriorityFlag priority={card.priority} />
            {card.points != null ? (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary" title="story points">{card.points} pts</span>
            ) : (
              <EstimateChip estimate={card.estimate} />
            )}
            <AssigneePicker slug={slug} issueNumber={card.number} assignees={card.assignees} members={members} />
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
