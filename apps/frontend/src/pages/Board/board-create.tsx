import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Plus, X, Loader2, ExternalLink, AlertCircle } from 'lucide-react';
import { useCreateMeta, useCreateIssue, useScrumMe, type CreateIssueInput } from '@/hooks/use-scrum';

const STORY_RE = /histor/i;
const input = 'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const area = 'w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'mb-1 block text-xs font-medium text-muted-foreground';

const empty: CreateIssueInput = { title: '', type: '', description: '' };

/** Botón + modal para crear un issue (cualquier tipo) que aterriza en GitHub + el
 *  board del cliente, con autor = el usuario logueado. Valida la metodología
 *  (descripción siempre; criterios de aceptación en Historia). */
export function CreateIssueDialog({ slug }: { slug: string }) {
  const { data: meta } = useCreateMeta(slug);
  const { data: me } = useScrumMe();
  const create = useCreateIssue(slug);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CreateIssueInput>(empty);
  const [linksText, setLinksText] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const set = <K extends keyof CreateIssueInput>(k: K, v: CreateIssueInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const isStory = STORY_RE.test(form.type);

  const reset = () => { setForm(empty); setLinksText(''); setErr(null); create.reset(); };

  const submit = async () => {
    setErr(null);
    if (!form.type) return setErr('Elegí el tipo.');
    if (!form.title.trim()) return setErr('El título es obligatorio.');
    if (!form.description.trim()) return setErr('La descripción es obligatoria (metodología).');
    if (isStory && !form.acceptanceCriteria?.trim()) return setErr('Una Historia requiere criterios de aceptación (Gherkin).');
    const links = linksText.split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      await create.mutateAsync({ ...form, links });
      reset();
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'No se pudo crear el issue.');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <Dialog.Trigger asChild>
        <button className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90">
          <Plus className="h-4 w-4" /> Crear issue
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[min(92vw,640px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-lg font-semibold text-foreground">Crear issue</Dialog.Title>
            <Dialog.Close className="rounded-lg p-1 text-muted-foreground hover:bg-muted"><X className="h-4 w-4" /></Dialog.Close>
          </div>

          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Tipo *</label>
                <select className={input} value={form.type} onChange={(e) => set('type', e.target.value)}>
                  <option value="">Elegí…</option>
                  {(meta?.types ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Estimación</label>
                <select className={input} value={form.estimate ?? ''} onChange={(e) => set('estimate', e.target.value || undefined)}>
                  <option value="">—</option>
                  {(meta?.estimates ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className={labelCls}>Título *</label>
              <input className={input} value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Resumen corto del issue" />
            </div>

            <div>
              <label className={labelCls}>Descripción *</label>
              <textarea className={area} rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Contexto, qué se pide, detalle…" />
            </div>

            <div>
              <label className={labelCls}>Criterios de aceptación {isStory && <span className="text-destructive">* (Gherkin, obligatorio en Historia)</span>}</label>
              <textarea className={area} rows={3} value={form.acceptanceCriteria ?? ''} onChange={(e) => set('acceptanceCriteria', e.target.value)} placeholder={'Dado … Cuando … Entonces …'} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Área</label>
                <select className={input} value={form.area ?? ''} onChange={(e) => set('area', e.target.value || undefined)}>
                  <option value="">—</option>
                  {(meta?.areas ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Prioridad</label>
                <select className={input} value={form.priority ?? ''} onChange={(e) => set('priority', e.target.value || undefined)}>
                  <option value="">—</option>
                  {(meta?.priorities ?? []).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={labelCls}>Sprint</label>
                <select className={input} value={form.sprint ?? ''} onChange={(e) => set('sprint', e.target.value || undefined)}>
                  <option value="">—</option>
                  {(meta?.sprints ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Inicio</label>
                <input type="date" className={input} value={form.startDate ?? ''} onChange={(e) => set('startDate', e.target.value || undefined)} />
              </div>
              <div>
                <label className={labelCls}>Entrega</label>
                <input type="date" className={input} value={form.dueDate ?? ''} onChange={(e) => set('dueDate', e.target.value || undefined)} />
              </div>
            </div>

            <div>
              <label className={labelCls}>Adjuntos (una URL por línea)</label>
              <textarea className={area} rows={2} value={linksText} onChange={(e) => setLinksText(e.target.value)} placeholder="https://… (imágenes se ven inline; archivos como link)" />
            </div>

            <p className="text-xs text-muted-foreground">
              Se creará en GitHub y en el board, asignado a <b>@{me?.login ?? 'ti'}</b>.
            </p>

            {err && (
              <p className="flex items-start gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {err}
              </p>
            )}
            {create.isSuccess && create.data && (
              <a href={create.data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                <ExternalLink className="h-3.5 w-3.5" /> Issue #{create.data.number} creado
              </a>
            )}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close className="h-9 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground hover:bg-muted">Cancelar</Dialog.Close>
            <button
              onClick={submit}
              disabled={create.isPending}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Crear
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
