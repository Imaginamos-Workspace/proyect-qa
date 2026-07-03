import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown, ExternalLink } from 'lucide-react';
import type { ScrumCard, ScrumIssueType } from '@qa/shared-types';
import { IssueTypeIcon, PriorityFlag, IssueKey, EstimateChip } from '@/components/scrum/issue-bits';
import { Avatar } from './board-toolbar';
import { cn } from '@/lib/utils';

const TYPE_LABEL: Record<ScrumIssueType, string> = {
  epic: 'Épica', story: 'Historia', task: 'Tarea', bug: 'Bug',
  incident: 'Incidencia', spike: 'Spike', unknown: 'Sin tipo',
};
const PRIORITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

type SortKey = 'number' | 'title' | 'type' | 'status' | 'sprint' | 'area' | 'priority' | 'estimate';
type Dir = 'asc' | 'desc';

/** Valor comparable por columna (las nulas van al final en asc). */
function sortValue(c: ScrumCard, key: SortKey): string | number {
  switch (key) {
    case 'number': return c.number ?? Number.MAX_SAFE_INTEGER;
    case 'priority': return PRIORITY_RANK[c.priority ?? ''] ?? 0;
    case 'estimate': {
      if (typeof c.points === 'number') return c.points; // story points
      const n = Number(c.estimate);
      return Number.isFinite(n) ? n : (c.estimate ?? '').toString().toLowerCase();
    }
    case 'type': return TYPE_LABEL[c.type] ?? c.type;
    default: return (c[key] ?? '').toString().toLowerCase();
  }
}

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'number', label: '#', className: 'w-16' },
  { key: 'title', label: 'Título' },
  { key: 'type', label: 'Tipo', className: 'w-28' },
  { key: 'status', label: 'Estado', className: 'w-36' },
  { key: 'sprint', label: 'Sprint', className: 'w-40' },
  { key: 'area', label: 'Área', className: 'w-28' },
  { key: 'priority', label: 'Prioridad', className: 'w-24' },
  { key: 'estimate', label: 'Pts', className: 'w-16' },
];

/** Vista LISTA: datatable de los issues del tablero (ya filtrados por la barra),
 *  con orden por columna. Los filtros viven en la barra compartida del board. */
export function BoardList({ cards, onOpenDetail }: { cards: ScrumCard[]; onOpenDetail: (card: ScrumCard) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: 'number', dir: 'asc' });

  const sorted = useMemo(() => {
    const arr = [...cards];
    arr.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [cards, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  if (cards.length === 0) {
    return <p className="rounded-xl border border-border bg-card/60 px-4 py-10 text-center text-sm text-muted-foreground">No hay issues con los filtros actuales.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left">
            {COLUMNS.map((col) => {
              const active = sort.key === col.key;
              return (
                <th key={col.key} className={cn('px-3 py-2 font-medium text-muted-foreground', col.className)}>
                  <button
                    onClick={() => toggleSort(col.key)}
                    className={cn('inline-flex items-center gap-1 transition-colors hover:text-foreground', active && 'text-foreground')}
                  >
                    {col.label}
                    {active ? (
                      sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                    ) : (
                      <ChevronsUpDown className="h-3 w-3 opacity-40" />
                    )}
                  </button>
                </th>
              );
            })}
            <th className="w-32 px-3 py-2 font-medium text-muted-foreground">Responsable</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.id} onClick={() => onOpenDetail(c)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-muted/30">
              <td className="px-3 py-2"><IssueKey number={c.number} /></td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1 text-foreground">
                  <span className="line-clamp-1">{c.title}</span>
                  {c.url && (
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="shrink-0 text-muted-foreground hover:text-primary"
                      title="Ver en GitHub Projects"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </span>
              </td>
              <td className="px-3 py-2">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <IssueTypeIcon type={c.type} /> {TYPE_LABEL[c.type]}
                </span>
              </td>
              <td className="px-3 py-2 text-muted-foreground">{c.status ?? '—'}</td>
              <td className="px-3 py-2 text-muted-foreground"><span className="line-clamp-1">{c.sprint ?? '—'}</span></td>
              <td className="px-3 py-2 text-muted-foreground">{c.area ?? '—'}</td>
              <td className="px-3 py-2"><PriorityFlag priority={c.priority} /></td>
              <td className="px-3 py-2">{c.points != null ? <span className="font-medium text-foreground">{c.points}</span> : <EstimateChip estimate={c.estimate} />}</td>
              <td className="px-3 py-2">
                <div className="flex -space-x-1.5">
                  {c.assignees.slice(0, 3).map((a) => <Avatar key={a.login} login={a.login} url={a.avatarUrl} size={22} />)}
                  {c.assignees.length === 0 && <span className="text-xs text-muted-foreground/60">—</span>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
