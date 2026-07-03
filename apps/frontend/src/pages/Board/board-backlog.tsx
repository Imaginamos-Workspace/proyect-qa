import { useMemo, useState } from 'react';
import { Loader2, Inbox } from 'lucide-react';
import type { ScrumBoard, ScrumCard } from '@qa/shared-types';
import { useCarryOver } from '@/hooks/use-scrum';
import { IssueTypeIcon, PriorityFlag, IssueKey, EstimateChip } from '@/components/scrum/issue-bits';
import { SprintPicker } from './board-sprint-picker';

/**
 * Vista Backlog — issues SIN sprint asignado, como en Jira. Independiente
 * del selector de sprint del resto del board (ese filtra POR sprint; acá se
 * ven justamente los que no tienen ninguno). Permite asignar de a uno
 * (SprintPicker) o en lote (checkboxes + acción masiva), persistiendo en
 * GitHub con el mismo tope de 50 por acción que el carry-over.
 */
export function BoardBacklog({ board, slug, canMove }: { board: ScrumBoard; slug: string; canMove: boolean }) {
  const backlogCards = useMemo(
    () => board.columns.flatMap((c) => c.cards).filter((c) => !c.sprint),
    [board.columns],
  );
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState(board.sprints[0] ?? '');
  const carry = useCarryOver(slug);

  const toggle = (n: number | null) => {
    if (n == null) return;
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(n)) next.delete(n); else next.add(n);
      return next;
    });
  };
  const toggleAll = () => {
    if (selected.size === backlogCards.length) setSelected(new Set());
    else setSelected(new Set(backlogCards.map((c) => c.number).filter((n): n is number => n != null)));
  };

  const assignSelected = () => {
    if (!target || selected.size === 0) return;
    carry.mutate(
      { title: 'Sin sprint', issues: [...selected], to: target },
      { onSuccess: () => setSelected(new Set()) },
    );
  };

  if (backlogCards.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card/60 px-4 py-14 text-center text-sm text-muted-foreground">
        <Inbox className="h-8 w-8 opacity-40" />
        Sin backlog — todos los issues tienen sprint asignado.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {canMove && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
          <span className="text-sm text-muted-foreground">{selected.size} seleccionado(s)</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
          >
            {board.sprints.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button
            onClick={assignSelected}
            disabled={selected.size === 0 || !target || carry.isPending}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {carry.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Asignar seleccionados a sprint
          </button>
          {carry.data && (
            <span className="text-xs text-muted-foreground">
              {carry.data.moved} movido(s){carry.data.remaining > 0 ? ` · ${carry.data.remaining} pendiente(s) (repetí la acción)` : ''}
            </span>
          )}
          {carry.isError && (
            <span className="text-xs text-destructive">{carry.error instanceof Error ? carry.error.message : 'No se pudo asignar.'}</span>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              {canMove && (
                <th className="w-8 px-3 py-2">
                  <input type="checkbox" checked={selected.size === backlogCards.length} onChange={toggleAll} />
                </th>
              )}
              <th className="w-16 px-3 py-2 font-medium text-muted-foreground">#</th>
              <th className="px-3 py-2 font-medium text-muted-foreground">Título</th>
              <th className="w-28 px-3 py-2 font-medium text-muted-foreground">Tipo</th>
              <th className="w-36 px-3 py-2 font-medium text-muted-foreground">Estado</th>
              <th className="w-28 px-3 py-2 font-medium text-muted-foreground">Área</th>
              <th className="w-24 px-3 py-2 font-medium text-muted-foreground">Prioridad</th>
              <th className="w-16 px-3 py-2 font-medium text-muted-foreground">Pts</th>
              <th className="w-40 px-3 py-2 font-medium text-muted-foreground">Sprint</th>
            </tr>
          </thead>
          <tbody>
            {backlogCards.map((c: ScrumCard) => (
              <tr key={c.id} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                {canMove && (
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={c.number != null && selected.has(c.number)} onChange={() => toggle(c.number)} />
                  </td>
                )}
                <td className="px-3 py-2"><IssueKey number={c.number} /></td>
                <td className="px-3 py-2">
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer" className="line-clamp-1 text-foreground hover:text-primary hover:underline">{c.title}</a>
                  ) : (
                    <span className="line-clamp-1 text-foreground">{c.title}</span>
                  )}
                </td>
                <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5 text-muted-foreground"><IssueTypeIcon type={c.type} /> {c.type}</span></td>
                <td className="px-3 py-2 text-muted-foreground">{c.status ?? '—'}</td>
                <td className="px-3 py-2 text-muted-foreground">{c.area ?? '—'}</td>
                <td className="px-3 py-2"><PriorityFlag priority={c.priority} /></td>
                <td className="px-3 py-2">{c.points != null ? <span className="font-medium text-foreground">{c.points}</span> : <EstimateChip estimate={c.estimate} />}</td>
                <td className="px-3 py-2">
                  <SprintPicker slug={slug} issueNumber={c.number} currentSprint={c.sprint} allSprints={board.sprints} canMove={canMove} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
