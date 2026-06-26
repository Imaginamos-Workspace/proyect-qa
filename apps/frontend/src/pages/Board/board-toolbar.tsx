import { type ReactNode, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  Check, ChevronDown, Search, X, CalendarDays, CircleDot, CircleCheck, Rocket, Building2,
  LayoutGrid, List as ListIcon, GanttChartSquare, BarChart3,
} from 'lucide-react';
import type { ScrumAssignee, ScrumSprint } from '@qa/shared-types';
import { cn } from '@/lib/utils';

/* ── Avatar (foto o iniciales) ──────────────────────────────────────────── */
export function Avatar({ login, url, size = 24 }: { login: string; url?: string | null; size?: number }) {
  const s = { width: size, height: size };
  if (url) {
    return (
      <img
        src={url}
        alt={login}
        title={login}
        style={s}
        className="rounded-full border border-card object-cover"
      />
    );
  }
  return (
    <span
      title={login}
      style={s}
      className="flex items-center justify-center rounded-full border border-card bg-primary/15 text-[9px] font-semibold uppercase text-primary"
    >
      {login.slice(0, 2)}
    </span>
  );
}

/* ── Selector de VISTA (segmentado) ─────────────────────────────────────── */
export type BoardView = 'board' | 'list' | 'roadmap' | 'sprint';

const VIEWS: { key: BoardView; label: string; icon: typeof LayoutGrid; soon?: boolean }[] = [
  { key: 'board', label: 'Tablero', icon: LayoutGrid },
  { key: 'list', label: 'Lista', icon: ListIcon },
  { key: 'roadmap', label: 'Roadmap', icon: GanttChartSquare },
  { key: 'sprint', label: 'Progreso', icon: BarChart3 },
];

export function ViewSwitcher({ value, onChange }: { value: BoardView; onChange: (v: BoardView) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-xl border border-border bg-card p-0.5">
      {VIEWS.map(({ key, label, icon: Icon, soon }) => {
        const active = value === key;
        return (
          <button
            key={key}
            disabled={soon}
            onClick={() => onChange(key)}
            title={soon ? 'Próximamente' : label}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors',
              active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              soon && 'cursor-not-allowed opacity-50 hover:bg-transparent',
            )}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{label}</span>
            {soon && <span className="rounded bg-muted px-1 text-[9px] font-bold uppercase text-muted-foreground">pronto</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ── Selector de CLIENTE con buscador/autocomplete ──────────────────────── */
// Reemplaza la fila de botones (inservible al crecer la lista). Etiquetado claro
// ("Cliente:") + ícono, con buscador por nombre o slug. Es el control más visible
// del encabezado del tablero.
export interface ClientOption {
  client_slug: string;
  client_name: string;
}

export function ClientSelect({
  clients,
  currentSlug,
  onPick,
}: {
  clients: ClientOption[];
  currentSlug: string;
  onPick: (slug: string) => void;
}) {
  const [q, setQ] = useState('');
  const current = clients.find((c) => c.client_slug === currentSlug);
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? clients.filter(
        (c) =>
          c.client_name.toLowerCase().includes(needle) || c.client_slug.toLowerCase().includes(needle),
      )
    : clients;

  return (
    <Popover.Root onOpenChange={(o) => !o && setQ('')}>
      <Popover.Trigger asChild>
        <button
          aria-label="Selector de cliente"
          className="inline-flex h-10 min-w-[13rem] max-w-[22rem] items-center gap-2 rounded-xl border-2 border-primary/30 bg-card px-3 text-sm shadow-sm transition-colors hover:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/25"
        >
          <Building2 className="h-4 w-4 shrink-0 text-primary" />
          <span className="shrink-0 text-muted-foreground">Cliente:</span>
          <span className="truncate font-semibold text-foreground">
            {current ? current.client_name : 'Selecciona…'}
          </span>
          <ChevronDown className="ml-auto h-4 w-4 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[20rem] rounded-xl border border-border bg-card p-2 shadow-lg"
        >
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar cliente…"
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="max-h-[22rem] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">Sin resultados</p>
            ) : (
              filtered.map((c) => (
                <Popover.Close asChild key={c.client_slug}>
                  <button
                    onClick={() => onPick(c.client_slug)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                      c.client_slug === currentSlug && 'bg-muted',
                    )}
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        c.client_slug === currentSlug ? 'text-primary opacity-100' : 'opacity-0',
                      )}
                      strokeWidth={3}
                    />
                    <span className="truncate font-medium text-foreground">{c.client_name}</span>
                  </button>
                </Popover.Close>
              ))
            )}
          </div>
          <p className="mt-1 border-t border-border px-2 pt-1.5 text-[11px] text-muted-foreground">
            {clients.length} cliente{clients.length === 1 ? '' : 's'}
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* ── Buscador ───────────────────────────────────────────────────────────── */
export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Buscar tarjeta…"
        className="h-9 w-44 rounded-lg border border-border bg-card pl-8 pr-7 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-56"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          aria-label="Limpiar búsqueda"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/* ── Menú de filtro multi-select (persona / tipo / estado) ──────────────── */
export interface FilterOption {
  value: string;
  label: string;
  adornment?: ReactNode; // avatar o icono a la izquierda
}

export function FilterMenu({
  label,
  icon,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  icon?: ReactNode;
  options: FilterOption[];
  selected: Set<string>;
  onToggle: (v: string) => void;
  onClear: () => void;
}) {
  const count = selected.size;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors',
            count > 0
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border bg-card text-foreground hover:bg-muted',
          )}
        >
          {icon}
          {label}
          {count > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
              {count}
            </span>
          )}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 max-h-72 w-56 overflow-y-auto rounded-xl border border-border bg-card p-1 shadow-lg"
        >
          {options.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">Sin opciones</p>
          ) : (
            options.map((o) => {
              const on = selected.has(o.value);
              return (
                <button
                  key={o.value}
                  onClick={() => onToggle(o.value)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                    )}
                  >
                    {on && <Check className="h-3 w-3" strokeWidth={3} />}
                  </span>
                  {o.adornment}
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })
          )}
          {count > 0 && (
            <button
              onClick={onClear}
              className="mt-1 w-full rounded-md border-t border-border px-2 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Limpiar ({count})
            </button>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* ── Barra de sprints (con fechas + abierto/cerrado) ────────────────────── */
// Valor sentinela para filtrar las tarjetas SIN sprint asignado (data-quality:
// idealmente todas deben tener uno, aunque sea el actual). No es un título real.
export const NO_SPRINT = '__none__';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fmt(d: string | null): string {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${day} ${MESES[Number(m) - 1] ?? ''}`;
}

// Selector de sprints: dropdown CON BUSCADOR, orden DESCENDENTE (recientes
// arriba), el ACTIVO primero y marcado. Reemplaza la fila de chips (inservible
// con 50+ sprints). `activeTitle` lo calcula el BoardPage (por fecha o, si las
// fechas están mal, por el sprint reciente con issues abiertos).
export function SprintSelect({
  sprints,
  meta,
  value,
  onPick,
  activeTitle,
  openByTitle,
  noSprintCount = 0,
}: {
  sprints: string[];
  meta: ScrumSprint[];
  value: string; // título de sprint, o NO_SPRINT
  onPick: (s: string) => void;
  activeTitle: string | null;
  openByTitle: Map<string, number>;
  noSprintCount?: number; // tarjetas sin sprint asignado
}) {
  const [q, setQ] = useState('');
  const metaByTitle = new Map(meta.map((m) => [m.title, m]));

  const options = sprints
    .map((title) => {
      const m = metaByTitle.get(title);
      return {
        title,
        start: m?.startDate ?? '',
        range: m?.startDate ? `${fmt(m.startDate)} – ${fmt(m.endDate)}` : null,
        completed: m?.completed,
        active: title === activeTitle,
        open: openByTitle.get(title) ?? 0,
      };
    })
    // Activo primero; luego DESCENDENTE por fecha (recientes arriba); luego nombre.
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.start !== b.start) return (b.start || '').localeCompare(a.start || '');
      return b.title.localeCompare(a.title, undefined, { numeric: true });
    });

  const filtered = q ? options.filter((o) => o.title.toLowerCase().includes(q.toLowerCase())) : options;
  const current = value ? options.find((o) => o.title === value) : null;

  return (
    <Popover.Root onOpenChange={(o) => !o && setQ('')}>
      <Popover.Trigger asChild>
        <button
          className={cn(
            'inline-flex h-9 max-w-[20rem] items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors',
            value ? 'border-primary/40 bg-primary/10 text-primary' : 'border-border bg-card text-foreground hover:bg-muted',
          )}
        >
          <CalendarDays className="h-4 w-4 shrink-0 opacity-70" />
          <span className="truncate">{value === NO_SPRINT ? 'Sin sprint' : value || 'Sprint'}</span>
          {current?.active && <Rocket className="h-3.5 w-3.5 shrink-0 text-success" />}
          <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-[20rem] rounded-xl border border-border bg-card p-2 shadow-lg"
        >
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar sprint…"
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div className="max-h-[22rem] overflow-y-auto">
            {!q && (
              <SprintRow
                label="Sin sprint"
                sub={`${noSprintCount} sin asignar`}
                selected={value === NO_SPRINT}
                onClick={() => onPick(NO_SPRINT)}
              />
            )}
            {filtered.map((o) => (
              <SprintRow
                key={o.title}
                label={o.title}
                sub={o.range}
                active={o.active}
                completed={o.completed}
                open={o.open}
                selected={value === o.title}
                onClick={() => onPick(o.title)}
              />
            ))}
            {filtered.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">Sin resultados</p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SprintRow({
  label,
  sub,
  active,
  completed,
  open = 0,
  selected,
  onClick,
}: {
  label: string;
  sub?: string | null;
  active?: boolean;
  completed?: boolean;
  open?: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Popover.Close asChild>
      <button
        onClick={onClick}
        className={cn(
          'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted',
          selected && 'bg-muted',
          active && 'ring-1 ring-success/40',
        )}
      >
        <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', selected ? 'text-primary opacity-100' : 'opacity-0')} strokeWidth={3} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">{label}</span>
            {active && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-success">
                <Rocket className="h-2.5 w-2.5" /> Activo
              </span>
            )}
            {!active && completed === true && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted-foreground">
                <CircleCheck className="h-2.5 w-2.5" /> Cerrado
              </span>
            )}
            {!active && completed === false && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-info/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-info">
                <CircleDot className="h-2.5 w-2.5" /> Abierto
              </span>
            )}
          </span>
          {(sub || open > 0) && (
            <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
              {sub && (
                <>
                  <CalendarDays className="h-2.5 w-2.5" /> {sub}
                </>
              )}
              {open > 0 && <span className="font-medium text-amber-600">· {open} abiertas</span>}
            </span>
          )}
        </span>
      </button>
    </Popover.Close>
  );
}
