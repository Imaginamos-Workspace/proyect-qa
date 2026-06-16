import {
  type LucideIcon,
  Zap,
  Bookmark,
  SquareCheckBig,
  Bug,
  FlaskConical,
  Circle,
  ChevronsUp,
  Equal,
  ChevronsDown,
} from 'lucide-react';
import type { ScrumIssueType, ScrumPriority } from '@qa/shared-types';
import { cn } from '@/lib/utils';

/* ── Tipo de issue: cuadrito de color con glifo (estilo Jira) ───────────── */
const TYPE_META: Record<ScrumIssueType, { icon: LucideIcon; bg: string; label: string }> = {
  epic: { icon: Zap, bg: 'bg-primary', label: 'Épica' },
  story: { icon: Bookmark, bg: 'bg-success', label: 'Historia' },
  task: { icon: SquareCheckBig, bg: 'bg-info', label: 'Tarea' },
  bug: { icon: Bug, bg: 'bg-destructive', label: 'Bug' },
  spike: { icon: FlaskConical, bg: 'bg-warning', label: 'Spike' },
  unknown: { icon: Circle, bg: 'bg-muted-foreground', label: '—' },
};

export function IssueTypeIcon({ type, className }: { type: ScrumIssueType; className?: string }) {
  const m = TYPE_META[type] ?? TYPE_META.unknown;
  const Icon = m.icon;
  return (
    <span
      title={m.label}
      className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm', m.bg, className)}
    >
      <Icon className="h-2.5 w-2.5 text-white" strokeWidth={2.5} />
    </span>
  );
}

/* ── Píldora de estado (columna) ────────────────────────────────────────── */
// Tono DERIVADO del nombre del estado (por categoría), no de una lista fija: el
// workflow es el del cliente (puede estar en español: "Pruebas QA", "Listo en
// Staging"…) y aún así la píldora toma el color correcto. Sin hardcode de columnas.
function statusTone(status: string): string {
  const k = status.toLowerCase();
  if (/(done|hecho|listo|complet|cerrad|finaliz|resuel|staging)/.test(k)) return 'bg-success/15 text-success';
  if (/(review|revisi|pull|qa|prueba|test|aprob)/.test(k)) return 'bg-primary/15 text-primary';
  if (/(progress|curso|progreso|doing|haciendo|desarrollo|deploy)/.test(k)) return 'bg-info/15 text-info';
  return 'bg-muted text-muted-foreground'; // por hacer / to do / backlog / nuevo
}
export function StatusPill({ status }: { status: string | null }) {
  if (!status) return null;
  const tone = statusTone(status);
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', tone)}>
      {status}
    </span>
  );
}

/* ── Bandera de prioridad (estilo Jira: flechas de color) ───────────────── */
const PRIORITY_META: Record<Exclude<ScrumPriority, null>, { icon: LucideIcon; cls: string; label: string }> = {
  high: { icon: ChevronsUp, cls: 'text-destructive', label: 'Alta' },
  medium: { icon: Equal, cls: 'text-warning', label: 'Media' },
  low: { icon: ChevronsDown, cls: 'text-success', label: 'Baja' },
};
export function PriorityFlag({ priority }: { priority: ScrumPriority }) {
  if (!priority) return null;
  const m = PRIORITY_META[priority];
  const Icon = m.icon;
  return <Icon className={cn('h-4 w-4', m.cls)} aria-label={m.label} />;
}

/* ── Clave del issue (#N) ───────────────────────────────────────────────── */
export function IssueKey({ number }: { number: number | null }) {
  if (!number) return null;
  return <span className="font-mono text-[11px] text-muted-foreground">#{number}</span>;
}

/* ── Chip de estimación (puntos / talla) ────────────────────────────────── */
export function EstimateChip({ estimate }: { estimate: string | null }) {
  if (!estimate) return null;
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[10px] font-semibold text-muted-foreground">
      {estimate}
    </span>
  );
}
