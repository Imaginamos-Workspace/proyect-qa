import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, CalendarClock, Loader2 } from 'lucide-react';
import { useAssignSprint } from '@/hooks/use-scrum';
import { cn } from '@/lib/utils';
import { NO_SPRINT } from './board-toolbar';

/**
 * Picker de sprint en cada tarjeta del Board — mismo patrón que AssigneePicker
 * (board-assignee.tsx). Solo interactivo si `canMove` (mismo rol que arrastrar
 * tarjetas entre columnas, rules del monorepo). Persiste en GitHub vía el
 * backend (assignSprint), 1 issue por llamada — sin tope porque no es bulk.
 */
export function SprintPicker({
  slug,
  issueNumber,
  currentSprint,
  allSprints,
  canMove,
}: {
  slug: string;
  issueNumber: number | null;
  currentSprint: string | null;
  allSprints: string[];
  canMove: boolean;
}) {
  const assign = useAssignSprint(slug);

  if (issueNumber == null) return null;
  if (!canMove) {
    return currentSprint ? (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
        <CalendarClock className="h-3 w-3" /> {currentSprint}
      </span>
    ) : null;
  }

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          title={currentSprint ? `Sprint: ${currentSprint} — cambiar` : 'Asignar sprint'}
          className={cn(
            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
            currentSprint
              ? 'bg-muted text-muted-foreground hover:bg-muted/70'
              : 'border border-dashed border-muted-foreground/50 text-muted-foreground hover:border-primary hover:text-primary',
          )}
        >
          <CalendarClock className="h-3 w-3" />
          {currentSprint ?? 'sprint'}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          onClick={(e) => e.stopPropagation()}
          className="z-50 max-h-64 w-64 overflow-y-auto rounded-xl border border-border bg-card p-2 shadow-lg"
        >
          {assign.isError && (
            <p className="mb-1 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
              {assign.error instanceof Error ? assign.error.message : 'No se pudo asignar (¿token de escritura?).'}
            </p>
          )}
          {allSprints.filter((s) => s !== NO_SPRINT).map((s) => {
            const sel = s === currentSprint;
            return (
              <button
                key={s}
                onClick={() => assign.mutate({ issue: issueNumber, title: s })}
                disabled={assign.isPending}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50',
                  sel && 'bg-muted',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{s}</span>
                {sel && <Check className="h-3.5 w-3.5 text-primary" strokeWidth={3} />}
              </button>
            );
          })}
          {allSprints.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">Sin sprints definidos</p>}
          {assign.isPending && (
            <p className="mt-1 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> moviendo…
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
