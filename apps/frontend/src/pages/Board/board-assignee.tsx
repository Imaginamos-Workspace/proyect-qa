import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import { Search, Check, UserPlus, X, Loader2 } from 'lucide-react';
import type { ScrumAssignee } from '@qa/shared-types';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Avatar } from './board-toolbar';

/**
 * Picker de responsable en cada tarjeta del Board. Searchbox + lista de los
 * usuarios de GitHub de la org (board.members). Al elegir, asigna en GitHub vía
 * el backend y refresca el board. Requiere que el backend tenga token de
 * escritura (GITHUB_WRITE_TOKEN); si no, muestra el error claro.
 */
export function AssigneePicker({
  slug,
  issueNumber,
  assignees,
  members,
}: {
  slug: string;
  issueNumber: number | null;
  assignees: ScrumAssignee[];
  members: ScrumAssignee[];
}) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (issueNumber == null) return <AvatarStack assignees={assignees} />;

  const current = assignees[0]?.login ?? null;
  const filtered = q ? members.filter((m) => m.login.toLowerCase().includes(q.toLowerCase())) : members;

  const assign = async (login: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/scrum/boards/${slug}/assign`, { issue: issueNumber, login });
      await qc.invalidateQueries({ queryKey: ['scrum', 'boards', slug] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo asignar');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover.Root onOpenChange={(o) => { if (!o) { setQ(''); setErr(null); } }}>
      <Popover.Trigger asChild>
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          title={current ? `Responsable: @${current} — cambiar` : 'Asignar responsable'}
          className="inline-flex items-center rounded-full transition-opacity hover:opacity-80"
        >
          {assignees.length ? (
            <AvatarStack assignees={assignees} />
          ) : (
            <span className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground hover:border-primary hover:text-primary">
              <UserPlus className="h-3 w-3" />
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          onClick={(e) => e.stopPropagation()}
          className="z-50 w-64 rounded-xl border border-border bg-card p-2 shadow-lg"
        >
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar persona…"
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          {err && <p className="mb-1 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{err}</p>}
          <div className="max-h-64 overflow-y-auto">
            <button
              onClick={() => assign(null)}
              disabled={busy}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-border"><X className="h-3 w-3" /></span>
              Sin asignar
            </button>
            {filtered.map((m) => {
              const sel = m.login === current;
              return (
                <button
                  key={m.login}
                  onClick={() => assign(m.login)}
                  disabled={busy}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted disabled:opacity-50',
                    sel && 'bg-muted',
                  )}
                >
                  <Avatar login={m.login} url={m.avatarUrl} size={20} />
                  <span className="min-w-0 flex-1 truncate">{m.login}</span>
                  {sel && <Check className="h-3.5 w-3.5 text-primary" strokeWidth={3} />}
                </button>
              );
            })}
            {filtered.length === 0 && <p className="px-2 py-3 text-center text-xs text-muted-foreground">Sin usuarios</p>}
          </div>
          {busy && (
            <p className="mt-1 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> asignando…
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AvatarStack({ assignees }: { assignees: ScrumAssignee[] }) {
  if (!assignees.length) return null;
  return (
    <span className="flex -space-x-1.5">
      {assignees.slice(0, 3).map((a) => (
        <Avatar key={a.login} login={a.login} url={a.avatarUrl} size={20} />
      ))}
    </span>
  );
}
