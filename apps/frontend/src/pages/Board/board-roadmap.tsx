import { useMemo, useReducer, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, CalendarRange, Plus } from 'lucide-react';
import type { ScrumBoard, ScrumCard } from '@qa/shared-types';
import { IssueTypeIcon } from '@/components/scrum/issue-bits';
import { useSetIssueDates } from '@/hooks/use-scrum';
import { CreateIssueDialog } from './board-create';
import { cn } from '@/lib/utils';

const DAY = 86_400_000;
const LEFT = 256; // ancho de la columna fija de épicas (w-64)
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const isDone = (s: string | null) => !!s && /\b(done|hecho|listo|complet|cerrad|finaliz|resuel|staging)/i.test(s);
const parseDay = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).getTime() : null);
const toYMD = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// Tipo por defecto del hijo según el padre (épica → Historia; resto → Tarea).
const childType = (t: ScrumCard['type']) => (t === 'epic' ? 'Historia' : 'Tarea');

interface DragState {
  number: number; edge: 'l' | 'r' | 'move';
  origStart: number; origEnd: number; curStart: number; curEnd: number; startClientX: number;
}

type ZoomKey = 'week' | 'month' | 'year';
const ZOOMS: { key: ZoomKey; label: string; pxPerDay: number }[] = [
  { key: 'week', label: 'Semana', pxPerDay: 22 },
  { key: 'month', label: 'Mes', pxPerDay: 6 },
  { key: 'year', label: 'Año', pxPerDay: 1.4 },
];

const startOfWeek = (ms: number) => {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // lunes = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
};
const startOfMonth = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const addMonths = (ms: number, n: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1); };

function genTicks(start: number, end: number, unit: ZoomKey): { ms: number; label: string }[] {
  const ticks: { ms: number; label: string }[] = [];
  if (unit === 'week') {
    for (let t = startOfWeek(start); t <= end; t += 7 * DAY) {
      const d = new Date(t);
      ticks.push({ ms: t, label: `${d.getUTCDate()} ${MESES[d.getUTCMonth()]}` });
    }
  } else if (unit === 'month') {
    for (let t = startOfMonth(start); t <= end; t = addMonths(t, 1)) {
      const d = new Date(t);
      ticks.push({ ms: t, label: `${MESES[d.getUTCMonth()]} ${d.getUTCFullYear()}` });
    }
  } else {
    const endY = new Date(end).getUTCFullYear();
    for (let y = new Date(start).getUTCFullYear(); y <= endY; y++) ticks.push({ ms: Date.UTC(y, 0, 1), label: String(y) });
  }
  return ticks;
}

interface Node {
  card: ScrumCard;
  children: Node[];
  start: number | null;
  end: number | null;
  total: number;
  done: number;
}

/** Vista ROADMAP (Gantt) con zoom Semana/Mes/Año, eje de fechas limpio, sprints
 *  como bandas de fondo, línea de "hoy", jerarquía expandible y barra de avance. */
export function BoardRoadmap({ board, slug }: { board: ScrumBoard; slug: string }) {
  const [zoom, setZoom] = useState<ZoomKey>('month');
  const pxPerDay = ZOOMS.find((z) => z.key === zoom)!.pxPerDay;
  const setDates = useSetIssueDates(slug);
  const dragRef = useRef<DragState | null>(null);
  const [, force] = useReducer((x: number) => x + 1, 0);

  const sprintRange = useMemo(() => {
    const m = new Map<string, { start: number | null; end: number | null }>();
    for (const s of board.sprintsMeta ?? []) m.set(s.title, { start: parseDay(s.startDate), end: parseDay(s.endDate) });
    return m;
  }, [board.sprintsMeta]);

  const { epics, domain } = useMemo(() => {
    const allCards = board.columns.flatMap((c) => c.cards);
    const childrenOf = new Map<number, ScrumCard[]>();
    for (const c of allCards) {
      if (c.parent != null) { const a = childrenOf.get(c.parent) ?? []; a.push(c); childrenOf.set(c.parent, a); }
    }
    const build = (card: ScrumCard, seen: Set<number>): Node => {
      const kids = card.number != null && !seen.has(card.number) ? childrenOf.get(card.number) ?? [] : [];
      if (card.number != null) seen.add(card.number);
      const children = kids.map((k) => build(k, seen));
      const own = card.sprint ? sprintRange.get(card.sprint) : undefined;
      const explicitStart = parseDay(card.startDate);
      const explicitEnd = parseDay(card.dueDate);
      const starts = [own?.start, ...children.map((c) => c.start)].filter((n): n is number => n != null);
      const ends = [own?.end, ...children.map((c) => c.end)].filter((n): n is number => n != null);
      return {
        card, children,
        start: explicitStart ?? (starts.length ? Math.min(...starts) : null),
        end: explicitEnd ?? (ends.length ? Math.max(...ends) : null),
        total: children.reduce((n, c) => n + c.total + 1, 0),
        done: children.reduce((n, c) => n + c.done + (isDone(c.card.status) ? 1 : 0), 0),
      };
    };
    const seen = new Set<number>();
    const epicNodes = allCards
      .filter((c) => c.type === 'epic')
      .map((c) => build(c, seen))
      .filter((n) => n.start != null && n.end != null)
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    const starts = [...(board.sprintsMeta ?? []).map((s) => parseDay(s.startDate)), ...epicNodes.map((n) => n.start)].filter((n): n is number => n != null);
    const ends = [...(board.sprintsMeta ?? []).map((s) => parseDay(s.endDate)), ...epicNodes.map((n) => n.end)].filter((n): n is number => n != null);
    return { epics: epicNodes, domain: starts.length && ends.length ? { start: Math.min(...starts), end: Math.max(...ends) } : null };
  }, [board.columns, board.sprintsMeta, sprintRange]);

  if (!domain || epics.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card/60 px-4 py-10 text-center text-sm text-muted-foreground">
        <CalendarRange className="mx-auto mb-2 h-8 w-8 opacity-40" />
        No hay épicas con fechas para el roadmap. Las fechas se derivan de los sprints de las historias/tareas
        de cada épica (o de los campos Inicio/Fin si los seteás en la épica).
      </div>
    );
  }

  const start = domain.start;
  const end = domain.end + 7 * DAY; // padding al final
  const totalDays = Math.ceil((end - start) / DAY);
  const width = Math.max(totalDays * pxPerDay, 480);
  const xOf = (ms: number) => ((ms - start) / DAY) * pxPerDay;
  const ticks = genTicks(start, end, zoom);
  const today = Date.now();
  const todayX = today >= start && today <= end ? xOf(today) : null;
  const bands = (board.sprintsMeta ?? [])
    .map((s) => ({ title: s.title, st: parseDay(s.startDate), en: parseDay(s.endDate) }))
    .filter((b): b is { title: string; st: number; en: number } => b.st != null && b.en != null);

  // Drag-resize: arrastrar borde izq/der (cambia Inicio/Fin) o el centro (mueve
  // ambos). Preview en vivo vía dragRef + force(); al soltar, escribe las fechas.
  const beginDrag = (e: React.MouseEvent, number: number, edge: DragState['edge'], startMs: number, endMs: number) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { number, edge, origStart: startMs, origEnd: endMs, curStart: startMs, curEnd: endMs, startClientX: e.clientX };
    force();
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = Math.round((ev.clientX - d.startClientX) / pxPerDay) * DAY;
      if (d.edge === 'l') d.curStart = Math.min(d.origStart + delta, d.origEnd - DAY);
      else if (d.edge === 'r') d.curEnd = Math.max(d.origEnd + delta, d.origStart + DAY);
      else { d.curStart = d.origStart + delta; d.curEnd = d.origEnd + delta; }
      force();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const d = dragRef.current;
      dragRef.current = null;
      force();
      if (!d || (d.curStart === d.origStart && d.curEnd === d.origEnd)) return;
      const payload: { issue: number; startDate?: string; dueDate?: string } = { issue: d.number };
      if (d.edge === 'l' || d.edge === 'move') payload.startDate = toYMD(d.curStart);
      if (d.edge === 'r' || d.edge === 'move') payload.dueDate = toYMD(d.curEnd);
      setDates.mutate(payload);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div className="space-y-2">
      {/* Control de zoom */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Escala:</span>
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
          {ZOOMS.map((z) => (
            <button
              key={z.key}
              onClick={() => setZoom(z.key)}
              className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                zoom === z.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
            >
              {z.label}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <div style={{ width: LEFT + width }}>
          {/* Encabezado: ticks de fecha */}
          <div className="flex border-b border-border bg-muted/30">
            <div className="sticky left-0 z-20 flex w-64 shrink-0 items-center border-r border-border bg-muted/30 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Épica
            </div>
            <div className="relative h-9" style={{ width }}>
              {ticks.map((t) => (
                <div key={t.ms} className="absolute top-0 h-full border-l border-border/60 pl-1 pt-2 text-[10px] text-muted-foreground" style={{ left: xOf(t.ms) }}>
                  {t.label}
                </div>
              ))}
            </div>
          </div>

          {/* Cuerpo: bandas de sprint + hoy + filas */}
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 z-0" style={{ left: LEFT, width }}>
              {bands.map((b, i) => (
                <div key={b.title} className={cn('absolute inset-y-0', i % 2 ? 'bg-muted/25' : 'bg-transparent')}
                  style={{ left: xOf(b.st), width: Math.max(xOf(b.en) - xOf(b.st), 1) }} title={b.title} />
              ))}
              {ticks.map((t) => <div key={t.ms} className="absolute inset-y-0 w-px bg-border/40" style={{ left: xOf(t.ms) }} />)}
              {todayX != null && <div className="absolute inset-y-0 z-10 w-px bg-destructive/70" style={{ left: todayX }} title="Hoy" />}
            </div>
            {epics.map((n) => <RoadmapRow key={n.card.id} node={n} depth={0} xOf={xOf} width={width} today={today} slug={slug} drag={dragRef.current} onDrag={beginDrag} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

function RoadmapRow({ node, depth, xOf, width, today, slug, drag, onDrag }: {
  node: Node; depth: number; xOf: (ms: number) => number; width: number; today: number;
  slug: string; drag: DragState | null; onDrag: (e: React.MouseEvent, n: number, edge: DragState['edge'], s: number, en: number) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const { card, start, end, total, done } = node;
  const progress = total ? Math.round((done / total) * 100) : isDone(card.status) ? 100 : 0;
  const atRisk = end != null && end < today && progress < 100;
  const hasKids = node.children.length > 0;
  // Preview en vivo si esta fila se está arrastrando.
  const live = drag && drag.number === card.number ? drag : null;
  const s = live ? live.curStart : start;
  const e2 = live ? live.curEnd : end;
  const left = s != null ? xOf(s) : 0;
  const w = s != null && e2 != null ? Math.max(xOf(e2) - xOf(s), 4) : 0;
  const editable = card.number != null && start != null && end != null;

  return (
    <>
      <div className="group flex items-stretch border-b border-border/50 hover:bg-muted/20">
        <div className="sticky left-0 z-10 flex w-64 shrink-0 items-center gap-1 border-r border-border bg-card px-2 py-1.5" style={{ paddingLeft: 8 + depth * 14 }}>
          {hasKids ? (
            <button onClick={() => setOpen((o) => !o)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted">
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          ) : <span className="w-[18px] shrink-0" />}
          <IssueTypeIcon type={card.type} />
          <a href={card.url ?? undefined} target="_blank" rel="noreferrer" title={card.title}
            className={cn('truncate text-xs hover:text-primary hover:underline', depth === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
            {card.title}
          </a>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            {card.number != null && (
              <CreateIssueDialog
                slug={slug}
                parentNumber={card.number}
                parentTitle={card.title}
                defaultType={childType(card.type)}
                trigger={
                  <button title="Crear sub-issue" className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-primary group-hover:opacity-100">
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                }
              />
            )}
            {atRisk && <AlertTriangle className="h-3.5 w-3.5 text-destructive" />}
          </div>
        </div>
        <div className="relative select-none py-2" style={{ width }}>
          {w > 0 && (
            <div className={cn('absolute top-1/2 h-4 -translate-y-1/2 overflow-hidden rounded-md border',
              atRisk ? 'border-destructive/40 bg-destructive/15' : depth === 0 ? 'border-primary/40 bg-primary/15' : 'border-info/40 bg-info/10',
              live && 'ring-2 ring-primary/50')}
              style={{ left, width: w }} title={`${progress}% · ${done}/${total} listas`}>
              <div className={cn('h-full', atRisk ? 'bg-destructive/50' : depth === 0 ? 'bg-primary/60' : 'bg-info/50')} style={{ width: `${progress}%` }} />
              {depth === 0 && w > 36 && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-foreground/80">{progress}%</span>
              )}
              {editable && (
                <>
                  <div onMouseDown={(ev) => onDrag(ev, card.number!, 'l', start!, end!)} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize hover:bg-foreground/10" />
                  <div onMouseDown={(ev) => onDrag(ev, card.number!, 'move', start!, end!)} className="absolute inset-y-0 left-2 right-2 cursor-grab active:cursor-grabbing" />
                  <div onMouseDown={(ev) => onDrag(ev, card.number!, 'r', start!, end!)} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize hover:bg-foreground/10" />
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {open && hasKids && node.children
        .slice().sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
        .map((c) => <RoadmapRow key={c.card.id} node={c} depth={depth + 1} xOf={xOf} width={width} today={today} slug={slug} drag={drag} onDrag={onDrag} />)}
    </>
  );
}
