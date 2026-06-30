import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Play, FlagOff, AlertTriangle, Loader2, X, ExternalLink, CheckCircle2 } from 'lucide-react';
import {
  useSprintStates, useStartSprint, useCloseSprint, useCarryOver, useSprintStatus,
} from '@/hooks/use-scrum';
import { NO_SPRINT } from './board-toolbar';
import { cn } from '@/lib/utils';

/** Controles de ciclo de vida del sprint seleccionado: iniciar / cerrar.
 *  Iniciar y cerrar viven en Supabase (no necesitan token); el carry-over mueve
 *  issues en GitHub (sí necesita token de escritura). */
export function SprintControls({ slug, sprint }: { slug: string; sprint: string }) {
  const { data: states } = useSprintStates(slug);
  const start = useStartSprint(slug);
  const [closing, setClosing] = useState(false);

  if (!sprint || sprint === NO_SPRINT) return null;
  const state = states?.find((s) => s.title === sprint);
  const status = state?.status;

  return (
    <div className="flex items-center gap-1.5">
      {status === 'closed' ? (
        <span className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
          <CheckCircle2 className="h-3.5 w-3.5" /> Cerrado · {state?.completed_points ?? 0}/{state?.total_points ?? 0} pts
        </span>
      ) : status === 'active' ? (
        <>
          <span className="inline-flex items-center gap-1 rounded-lg border border-success/40 bg-success/10 px-2 py-1 text-xs font-semibold text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" /> Activo
          </span>
          <button
            onClick={() => setClosing(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <FlagOff className="h-4 w-4" /> Cerrar sprint
          </button>
        </>
      ) : (
        <button
          onClick={() => start.mutate(sprint)}
          disabled={start.isPending}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Iniciar sprint
        </button>
      )}
      {start.isError && <span className="text-xs text-destructive">No se pudo iniciar.</span>}

      <CloseSprintDialog slug={slug} sprint={sprint} open={closing} onOpenChange={setClosing} />
    </div>
  );
}

function CloseSprintDialog({ slug, sprint, open, onOpenChange }: {
  slug: string; sprint: string; open: boolean; onOpenChange: (o: boolean) => void;
}) {
  const { data: status, isLoading } = useSprintStatus(slug, sprint, open);
  const carry = useCarryOver(slug);
  const close = useCloseSprint(slug);
  const unfinished = status?.unfinished ?? [];
  const hasUnfinished = unfinished.length > 0;

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { carry.reset(); close.reset(); } }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[88vh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-foreground">Cerrar sprint</Dialog.Title>
            <Dialog.Close className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></Dialog.Close>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">{sprint}</p>

          {isLoading || !status ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Cargando estado del sprint…</p>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg border border-border bg-card p-2.5">
                  <span className="text-xs text-muted-foreground">Tarjetas</span>
                  <p className="font-semibold text-foreground">{status.done}/{status.total} terminadas</p>
                </div>
                <div className="rounded-lg border border-border bg-card p-2.5">
                  <span className="text-xs text-muted-foreground">Velocidad</span>
                  <p className="font-semibold text-success">{status.done_points}/{status.total_points} pts</p>
                </div>
              </div>

              {hasUnfinished ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="flex items-start gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    No podés cerrar el sprint: {unfinished.length} tarea(s) sin finalizar. Finalizalas en el board, o movelas al siguiente sprint (carry-over).
                  </p>
                  <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto">
                    {unfinished.map((u) => (
                      <li key={u.number ?? u.title} className="flex items-center gap-2 text-xs text-foreground">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{u.status ?? '—'}</span>
                        <span className="truncate">{u.number ? `#${u.number} ` : ''}{u.title}</span>
                        {u.url && <a href={u.url} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-primary"><ExternalLink className="h-3.5 w-3.5" /></a>}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => carry.mutate({ title: sprint, issues: unfinished.map((u) => u.number).filter((n): n is number => n != null) })}
                    disabled={carry.isPending}
                    className="mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                  >
                    {carry.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Carry-over de {unfinished.length} al siguiente sprint
                  </button>
                  {carry.isError && (
                    <p className="mt-1.5 text-xs text-destructive">{carry.error instanceof Error ? carry.error.message : 'No se pudo mover (¿token de escritura?).'}</p>
                  )}
                </div>
              ) : (
                <p className="flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
                  <CheckCircle2 className="h-4 w-4" /> Todo terminado. Podés cerrar el sprint.
                </p>
              )}

              {close.isError && (
                <p className="mt-2 text-sm text-destructive">{close.error instanceof Error ? close.error.message : 'No se pudo cerrar.'}</p>
              )}
            </>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close className="h-9 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground hover:bg-muted">Cancelar</Dialog.Close>
            <button
              onClick={async () => { try { await close.mutateAsync(sprint); onOpenChange(false); } catch { /* error mostrado arriba */ } }}
              disabled={hasUnfinished || isLoading || close.isPending}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-success px-4 text-sm font-semibold text-white hover:bg-success/90 disabled:opacity-50"
            >
              {close.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Cerrar sprint
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
