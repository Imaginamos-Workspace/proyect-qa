import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ExternalLink, X, Loader2, GitBranch, Paperclip, Send, CheckCircle2 } from 'lucide-react';
import type { ScrumCard } from '@qa/shared-types';
import { useIssueDetail, useScrumMe, useAddEvidence } from '@/hooks/use-scrum';
import { IssueTypeIcon, PriorityFlag, IssueKey, EstimateChip } from '@/components/scrum/issue-bits';
import { Avatar } from './board-toolbar';

/**
 * Panel lateral tipo Jira — ve el contenido completo de un issue (cuerpo,
 * criterios, comentarios, jerarquía) SIN salir de la plataforma. "Abrir en
 * GitHub" queda como acción explícita, no como único camino.
 */
export function IssueDetailPanel({
  slug,
  card,
  open,
  onOpenChange,
}: {
  slug: string;
  card: ScrumCard | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data, isLoading, isError, error } = useIssueDetail(slug, open ? card?.number ?? null : null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[min(92vw,640px)] flex-col overflow-y-auto border-l border-border bg-card p-6 shadow-2xl focus:outline-none">
          {card && (
            <>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
                    <IssueTypeIcon type={card.type} />
                    <IssueKey number={card.number} />
                  </div>
                  <Dialog.Title className="text-lg font-semibold leading-snug text-foreground">
                    {card.title}
                  </Dialog.Title>
                </div>
                <Dialog.Close className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted">
                  <X className="h-4 w-4" />
                </Dialog.Close>
              </div>

              <div className="mb-4 flex flex-wrap items-center gap-2">
                {card.status && <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-foreground">{card.status}</span>}
                {card.area && <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">{card.area}</span>}
                {card.sprint && <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">{card.sprint}</span>}
                <PriorityFlag priority={card.priority} />
                {card.points != null ? (
                  <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">{card.points} pts</span>
                ) : (
                  <EstimateChip estimate={card.estimate} />
                )}
              </div>

              {card.assignees.length > 0 && (
                <div className="mb-4 flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Responsables:</span>
                  {card.assignees.map((a) => <Avatar key={a.login} login={a.login} url={a.avatarUrl} size={22} />)}
                </div>
              )}

              {card.labels.length > 0 && (
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {card.labels.map((l) => (
                    <span key={l} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{l}</span>
                  ))}
                </div>
              )}

              <a
                href={card.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="mb-5 inline-flex w-fit items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Ver en GitHub Projects
              </a>

              <hr className="mb-5 border-border" />

              {isLoading && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Cargando contenido…
                </p>
              )}
              {isError && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error instanceof Error ? error.message : 'No se pudo cargar el detalle.'}
                </p>
              )}

              {data && (
                <>
                  {(data.parent || data.subIssues.length > 0) && (
                    <div className="mb-5 space-y-1.5">
                      {data.parent && (
                        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <GitBranch className="h-3.5 w-3.5" /> Épica/historia padre: <span className="font-medium text-foreground">#{data.parent.number} {data.parent.title}</span>
                        </p>
                      )}
                      {data.subIssues.length > 0 && (
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer font-medium">Subtareas ({data.subIssues.length})</summary>
                          <ul className="mt-1.5 space-y-1 pl-4">
                            {data.subIssues.map((s) => (
                              <li key={s.number}>#{s.number} {s.title} {s.state === 'CLOSED' && <span className="text-success">✓</span>}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )}

                  <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:text-foreground prose-p:text-foreground prose-li:text-foreground prose-strong:text-foreground">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.body || '_(sin descripción)_'}</ReactMarkdown>
                  </div>

                  {data.comments.length > 0 && (
                    <div className="mt-6 space-y-3 border-t border-border pt-4">
                      <p className="text-xs font-semibold text-muted-foreground">Comentarios ({data.comments.length})</p>
                      {data.comments.map((c, i) => (
                        <div key={i} className="rounded-lg bg-muted/50 p-3">
                          <p className="mb-1 text-xs font-medium text-foreground">@{c.author} · {new Date(c.createdAt).toLocaleDateString('es-CO')}</p>
                          <div className="prose prose-xs max-w-none dark:prose-invert">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.body}</ReactMarkdown>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {card.number != null && <EvidenceForm slug={slug} issueNumber={card.number} />}
                </>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Cargar evidencia + comentario en el issue, sin salir de la plataforma. Solo
 * para roles de ejecución (QA/TL/PM/dev/devops) — el QA puede no tener silla en
 * GitHub: se identifica por email y la plataforma postea el comentario con el
 * token de servicio, atribuido a esa persona. Los archivos van a la storage de
 * la plataforma; el issue queda con el link.
 */
function EvidenceForm({ slug, issueNumber }: { slug: string; issueNumber: number }) {
  const { data: me } = useScrumMe();
  const addEvidence = useAddEvidence(slug, issueNumber);
  const [comment, setComment] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!me?.canUploadEvidence) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (addEvidence.isPending || (!comment.trim() && files.length === 0)) return;
    addEvidence.mutate(
      { comment, files },
      { onSuccess: () => { setComment(''); setFiles([]); } },
    );
  };

  return (
    <form onSubmit={submit} className="mt-6 space-y-2 border-t border-border pt-4">
      <p className="text-xs font-semibold text-muted-foreground">Cargar evidencia / comentario</p>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Qué probaste, resultado, pasos… (opcional si adjuntás evidencia)"
        rows={3}
        className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.mp4,.webm,.mov,.pdf,.txt,.log,.json,.zip,.har"
        className="hidden"
        onChange={(e) => {
          setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      {files.length > 0 && (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between rounded bg-muted/50 px-2 py-1 text-xs text-foreground">
              <span className="truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                className="ml-2 shrink-0 text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Paperclip className="h-3.5 w-3.5" /> Adjuntar evidencia
        </button>
        <button
          type="submit"
          disabled={addEvidence.isPending || (!comment.trim() && files.length === 0)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {addEvidence.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          {addEvidence.isPending ? 'Publicando…' : 'Publicar en el issue'}
        </button>
      </div>
      {addEvidence.isSuccess && (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <CheckCircle2 className="h-3.5 w-3.5" /> Publicado en el issue.
        </p>
      )}
      {addEvidence.isError && (
        <p className="text-xs text-destructive">{(addEvidence.error as Error).message}</p>
      )}
    </form>
  );
}
