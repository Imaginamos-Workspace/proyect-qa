import { useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  FlaskConical,
  ExternalLink,
  CircleCheck,
  CircleX,
  CircleAlert,
  Link2Off,
  X,
} from 'lucide-react';
import type { ScrumBoard, ScrumCard, ScrumStoryTests } from '@qa/shared-types';
import { cn } from '@/lib/utils';

/* ── Chip de pruebas en cada tarjeta (✓ 3/3 verde · ✗ 1 fallo rojo) ───────── */
export function TestsBadge({ entry, reportUrl }: { entry?: ScrumStoryTests; reportUrl?: string | null }) {
  if (!entry || !entry.total) return null;
  const ok = entry.failed === 0;
  const chip = (
    <span
      title={`${entry.passed}/${entry.total} pruebas OK${entry.failed ? ` · ${entry.failed} fallando` : ''} — ver evidencia`}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
        ok ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive',
      )}
    >
      <FlaskConical className="h-3 w-3" />
      {entry.passed}/{entry.total}
    </span>
  );
  return reportUrl ? (
    <a
      href={reportUrl}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="inline-flex"
    >
      {chip}
    </a>
  ) : (
    chip
  );
}

/* ── Panel "Trazabilidad": mapeo pruebas↔historias + pendientes ───────────── */
export function TraceabilityButton({ board }: { board: ScrumBoard }) {
  const qa = board.qa;
  const stories = useMemo(
    () =>
      board.columns
        .flatMap((c) => c.cards)
        .filter((c): c is ScrumCard & { number: number } => c.type === 'story' && c.number != null),
    [board],
  );
  const byStory = useMemo(() => new Map((qa?.story_map ?? []).map((e) => [e.story, e])), [qa]);

  const withTests = stories.filter((s) => byStory.has(s.number));
  const withoutTests = stories.filter((s) => !byStory.has(s.number));
  const unmapped = qa?.unmapped_tests ?? [];
  const pending = withoutTests.length + unmapped.length;

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button
          className={cn(
            'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-colors',
            pending > 0
              ? 'border-warning/50 bg-warning/10 text-warning-foreground text-amber-700'
              : 'border-border bg-card text-foreground hover:bg-muted',
          )}
        >
          <FlaskConical className="h-4 w-4" />
          Trazabilidad
          {pending > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white">
              {pending}
            </span>
          )}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl">
          <div className="mb-1 flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-foreground">
              Trazabilidad pruebas ↔ tareas
            </Dialog.Title>
            <Dialog.Close asChild>
              <button aria-label="Cerrar" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          {!qa ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Aún no hay corridas de QA ingestadas para este cliente. Cuando el QA corra la
              regresión y sincronice (<code>qa:apply</code>), acá se mapea cada prueba con su
              historia y su evidencia.
            </p>
          ) : (
            <div className="space-y-5">
              <p className="text-xs text-muted-foreground">
                Última corrida: {qa.run_at ? new Date(qa.run_at).toLocaleString() : '—'}
                {qa.report_url && (
                  <a
                    href={qa.report_url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" /> Ver evidencia (reporte)
                  </a>
                )}
              </p>

              {/* Historias CON pruebas */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <CircleCheck className="h-4 w-4 text-success" /> Historias con pruebas ({withTests.length})
                </h3>
                {withTests.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Ninguna todavía.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {withTests.map((s) => {
                      const e = byStory.get(s.number)!;
                      const ok = e.failed === 0;
                      return (
                        <li key={s.id} className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-sm">
                          {ok ? (
                            <CircleCheck className="h-4 w-4 shrink-0 text-success" />
                          ) : (
                            <CircleX className="h-4 w-4 shrink-0 text-destructive" />
                          )}
                          <span className="font-mono text-[11px] text-muted-foreground">#{s.number}</span>
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                          <span className={cn('text-xs font-semibold', ok ? 'text-success' : 'text-destructive')}>
                            {e.passed}/{e.total}
                          </span>
                          {s.url && (
                            <a href={s.url} target="_blank" rel="noreferrer" className="text-primary" title="Abrir issue">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              {/* Historias SIN pruebas — mapeo pendiente */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <CircleAlert className="h-4 w-4 text-amber-500" /> Historias sin pruebas ({withoutTests.length})
                </h3>
                {withoutTests.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Todas las historias tienen pruebas. 🎉</p>
                ) : (
                  <>
                    <ul className="max-h-44 space-y-1 overflow-y-auto">
                      {withoutTests.map((s) => (
                        <li key={s.id} className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
                          <span className="font-mono text-[11px]">#{s.number}</span>
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-2 rounded-lg bg-muted/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
                      <b>Cómo mapear:</b> el QA crea el spec ligado (<code>npm run qa:new-spec -- {board.client_slug} &lt;flujo&gt; --story N</code>),
                      el test lleva <code>// Spec: &lt;archivo&gt;.spec.md</code> en su cabecera, y al correr
                      <code> qa:apply</code> la historia aparece arriba con su resultado.
                    </p>
                  </>
                )}
              </section>

              {/* Pruebas SIN historia — mapeo pendiente */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  <Link2Off className="h-4 w-4 text-amber-500" /> Pruebas sin historia ({unmapped.length})
                </h3>
                {unmapped.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Todas las pruebas están ligadas a una historia. 🎉</p>
                ) : (
                  <>
                    <ul className="max-h-44 list-inside list-disc space-y-0.5 overflow-y-auto text-sm text-muted-foreground">
                      {unmapped.map((t, i) => (
                        <li key={i} className="truncate">{t}</li>
                      ))}
                    </ul>
                    <p className="mt-2 rounded-lg bg-muted/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
                      <b>Cómo mapear:</b> agregá <code>// Spec:</code> en la cabecera del test y{' '}
                      <code>**Story:** #N</code> en su spec (rules/96). Si la historia no existe en el
                      tablero, validá con <code>qa:story-check</code> (rules/11) y pedila al PM.
                    </p>
                  </>
                )}
              </section>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
