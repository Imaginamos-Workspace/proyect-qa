import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, ExternalLink, CalendarRange } from 'lucide-react';
import type { ScrumBoard, ScrumCard } from '@qa/shared-types';
import { IssueTypeIcon } from '@/components/scrum/issue-bits';
import { cn } from '@/lib/utils';

const DAY = 86_400_000;
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const isDone = (s: string | null) =>
  !!s && /\b(done|hecho|listo|complet|cerrad|finaliz|resuel|staging)/i.test(s);
const parseDay = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).getTime() : null);
const fmt = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
};

interface Node {
  card: ScrumCard;
  children: Node[];
  start: number | null;
  end: number | null;
  total: number; // issues en el subárbol (sin contar este)
  done: number;
}

/** Vista ROADMAP (Gantt): épicas en una línea de tiempo, con fechas DERIVADAS de
 *  los sprints de sus hijos (sub-issues nativos), barra con % de avance, sub-tareas
 *  expandibles, bandas de sprint + línea de "hoy", y marca de "en riesgo". */
export function BoardRoadmap({ board }: { board: ScrumBoard }) {
  const sprintRange = useMemo(() => {
    const m = new Map<string, { start: number | null; end: number | null }>();
    for (const s of board.sprintsMeta ?? []) m.set(s.title, { start: parseDay(s.startDate), end: parseDay(s.endDate) });
    return m;
  }, [board.sprintsMeta]);

  const { epics, domain } = useMemo(() => {
    const allCards = board.columns.flatMap((c) => c.cards);
    const childrenOf = new Map<number, ScrumCard[]>();
    for (const c of allCards) {
      if (c.parent != null) {
        const arr = childrenOf.get(c.parent) ?? [];
        arr.push(c);
        childrenOf.set(c.parent, arr);
      }
    }

    const build = (card: ScrumCard, seen: Set<number>): Node => {
      const kids = card.number != null && !seen.has(card.number) ? childrenOf.get(card.number) ?? [] : [];
      if (card.number != null) seen.add(card.number);
      const children = kids.map((k) => build(k, seen));
      const own = card.sprint ? sprintRange.get(card.sprint) : undefined;
      const starts = [own?.start, ...children.map((c) => c.start)].filter((n): n is number => n != null);
      const ends = [own?.end, ...children.map((c) => c.end)].filter((n): n is number => n != null);
      const total = children.reduce((n, c) => n + c.total + 1, 0);
      const done = children.reduce((n, c) => n + c.done + (isDone(c.card.status) ? 1 : 0), 0);
      return {
        card,
        children,
        start: starts.length ? Math.min(...starts) : null,
        end: ends.length ? Math.max(...ends) : null,
        total,
        done,
      };
    };

    const seen = new Set<number>();
    const epicNodes = allCards
      .filter((c) => c.type === 'epic')
      .map((c) => build(c, seen))
      .filter((n) => n.start != null && n.end != null)
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

    const allStart = Math.min(...(board.sprintsMeta ?? []).map((s) => parseDay(s.startDate) ?? Infinity), Infinity);
    const allEnd = Math.max(...(board.sprintsMeta ?? []).map((s) => parseDay(s.endDate) ?? -Infinity), -Infinity);
    return {
      epics: epicNodes,
      domain: Number.isFinite(allStart) && Number.isFinite(allEnd) ? { start: allStart, end: allEnd } : null,
    };
  }, [board.columns, board.sprintsMeta, sprintRange]);

  if (!domain || epics.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card/60 px-4 py-10 text-center text-sm text-muted-foreground">
        <CalendarRange className="mx-auto mb-2 h-8 w-8 opacity-40" />
        No hay épicas con fechas para el roadmap. Las fechas se derivan de los sprints de las
        historias/tareas de cada épica: asegurate de que el board tenga sprints con fecha y que
        las épicas tengan sub-issues asignados a esos sprints.
      </div>
    );
  }

  const span = Math.max(domain.end - domain.start, DAY);
  const pct = (ms: number) => ((ms - domain.start) / span) * 100;
  const today = Date.now();
  const todayPct = today >= domain.start && today <= domain.end ? pct(today) : null;

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <div className="min-w-[760px]">
        {/* Eje: bandas de sprint */}
        <div className="relative flex border-b border-border bg-muted/30">
          <div className="w-64 shrink-0 border-r border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Épica
          </div>
          <div className="relative flex-1">
            <div className="flex h-full">
              {(board.sprintsMeta ?? [])
                .filter((s) => parseDay(s.startDate) != null)
                .map((s, i) => {
                  const st = parseDay(s.startDate)!;
                  const en = parseDay(s.endDate) ?? st + 14 * DAY;
                  return (
                    <div
                      key={s.title}
                      className={cn(
                        'overflow-hidden whitespace-nowrap border-r border-border/50 px-1.5 py-2 text-[10px] text-muted-foreground',
                        i % 2 ? 'bg-muted/20' : '',
                      )}
                      style={{ width: `${((en - st) / span) * 100}%` }}
                      title={`${s.title} · ${fmt(st)}–${fmt(en)}`}
                    >
                      {s.title.replace(/^Sprint\s+/i, 'S')}
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
        {/* Filas de épicas */}
        <div className="relative">
          {todayPct != null && (
            <div
              className="pointer-events-none absolute bottom-0 top-0 z-10 w-px bg-destructive/70"
              style={{ left: `calc(16rem + (100% - 16rem) * ${todayPct / 100})` }}
              title="Hoy"
            />
          )}
          {epics.map((n) => (
            <RoadmapRow key={n.card.id} node={n} depth={0} pct={pct} today={today} />
          ))}
        </div>
      </div>
    </div>
  );
}

function RoadmapRow({
  node,
  depth,
  pct,
  today,
}: {
  node: Node;
  depth: number;
  pct: (ms: number) => number;
  today: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  const { card, start, end, total, done } = node;
  const progress = total ? Math.round((done / total) * 100) : isDone(card.status) ? 100 : 0;
  const atRisk = end != null && end < today && progress < 100;
  const hasKids = node.children.length > 0;
  const left = start != null ? pct(start) : 0;
  const width = start != null && end != null ? Math.max(pct(end) - pct(start), 1.2) : 0;

  return (
    <>
      <div className="flex items-stretch border-b border-border/50 hover:bg-muted/20">
        {/* Etiqueta */}
        <div className="flex w-64 shrink-0 items-center gap-1 border-r border-border px-2 py-1.5" style={{ paddingLeft: `${8 + depth * 14}px` }}>
          {hasKids ? (
            <button onClick={() => setOpen((o) => !o)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted">
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <span className="w-[18px] shrink-0" />
          )}
          <IssueTypeIcon type={card.type} />
          <a
            href={card.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            className={cn('truncate text-xs hover:text-primary hover:underline', depth === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground')}
            title={card.title}
          >
            {card.title}
          </a>
          {atRisk && <AlertTriangle className="ml-auto h-3.5 w-3.5 shrink-0 text-destructive" />}
        </div>
        {/* Barra */}
        <div className="relative flex-1 py-2">
          {width > 0 && (
            <div
              className={cn(
                'absolute top-1/2 h-4 -translate-y-1/2 overflow-hidden rounded-md border',
                atRisk ? 'border-destructive/40 bg-destructive/15' : depth === 0 ? 'border-primary/40 bg-primary/15' : 'border-info/40 bg-info/10',
              )}
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${progress}% · ${done}/${total} listas`}
            >
              <div
                className={cn('h-full', atRisk ? 'bg-destructive/50' : depth === 0 ? 'bg-primary/60' : 'bg-info/50')}
                style={{ width: `${progress}%` }}
              />
              <span className="absolute inset-0 flex items-center justify-center px-1 text-[10px] font-semibold text-foreground/80">
                {depth === 0 ? `${progress}%` : ''}
              </span>
            </div>
          )}
        </div>
      </div>
      {open && hasKids && node.children
        .slice()
        .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
        .map((c) => <RoadmapRow key={c.card.id} node={c} depth={depth + 1} pct={pct} today={today} />)}
    </>
  );
}
