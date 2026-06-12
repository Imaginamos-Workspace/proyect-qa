import { type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search, X, CalendarDays, CircleDot, CircleCheck } from 'lucide-react';
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
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function fmt(d: string | null): string {
  if (!d) return '';
  const [, m, day] = d.split('-');
  return `${day} ${MESES[Number(m) - 1] ?? ''}`;
}

export function SprintBar({
  sprints,
  meta,
  active,
  onPick,
}: {
  sprints: string[];
  meta: ScrumSprint[];
  active: string; // '' = todos
  onPick: (s: string) => void;
}) {
  const metaByTitle = new Map(meta.map((m) => [m.title, m]));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <SprintChip label="Todos los sprints" active={active === ''} onClick={() => onPick('')} />
      {sprints.map((s) => {
        const m = metaByTitle.get(s);
        const range = m?.startDate ? `${fmt(m.startDate)} – ${fmt(m.endDate)}` : null;
        return (
          <SprintChip
            key={s}
            label={s}
            range={range}
            completed={m?.completed}
            active={active === s}
            onClick={() => onPick(s)}
          />
        );
      })}
    </div>
  );
}

function SprintChip({
  label,
  range,
  completed,
  active,
  onClick,
}: {
  label: string;
  range?: string | null;
  completed?: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-xs transition-colors',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-foreground hover:bg-muted',
      )}
    >
      <span className="flex flex-col leading-tight">
        <span className="flex items-center gap-1.5 font-semibold">
          {label}
          {completed !== undefined &&
            (completed ? (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted-foreground">
                <CircleCheck className="h-2.5 w-2.5" /> Cerrado
              </span>
            ) : (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-success">
                <CircleDot className="h-2.5 w-2.5" /> Abierto
              </span>
            ))}
        </span>
        {range && (
          <span className="flex items-center gap-1 text-[10px] font-normal text-muted-foreground">
            <CalendarDays className="h-2.5 w-2.5" /> {range}
          </span>
        )}
      </span>
    </button>
  );
}
