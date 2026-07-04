import { useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  ArrowLeft,
  Send,
  RefreshCw,
  CheckCircle2,
  ExternalLink,
  Paperclip,
  Sparkles,
  Handshake,
} from 'lucide-react';
import {
  useSalesOpportunity,
  useSendSalesMessage,
  useSyncBrief,
  useHandoffToTl,
} from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { salesStatusMeta } from '@/lib/sales-status';

const SECTIONS: { key: string; label: string }[] = [
  { key: 'cliente', label: 'Cliente' },
  { key: 'problema', label: 'Problema' },
  { key: 'outcomes', label: 'Outcomes' },
  { key: 'usuariosYFuncionalidades', label: 'Usuarios y funcionalidades' },
  { key: 'limites', label: 'Límites' },
  { key: 'integraciones', label: 'Integraciones' },
  { key: 'riesgos', label: 'Riesgos' },
  { key: 'sensacionVendedor', label: 'Sensación del vendedor' },
];

export function SalesChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');

  const { data: opp, isLoading } = useSalesOpportunity(id ?? null);
  const sendMessage = useSendSalesMessage(id ?? '');
  const syncBrief = useSyncBrief(id ?? '');
  const handoff = useHandoffToTl(id ?? '');

  const [draftMessage, setDraftMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftMessage.trim()) return;
    sendMessage.mutate(draftMessage, { onSuccess: () => setDraftMessage('') });
  };

  const onPickTranscript = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite volver a elegir el mismo archivo después
    if (!file) return;
    const text = await file.text();
    // Se precarga en el input para que el vendedor revise/edite antes de
    // mandarlo — no se envía solo (rules/13 §Modo C, "confirmar antes de seguir").
    setDraftMessage((prev) => (prev ? `${prev}\n\n${text}` : text));
  };

  if (isLoading || !opp) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const draft = opp.draft ?? {};
  const asunciones = draft.asunciones ?? [];
  const statusMeta = salesStatusMeta(opp.status);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/ventas')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-xl font-semibold">{opp.oportunidad}</h1>
            <p className="text-sm text-muted-foreground">{opp.cliente}</p>
          </div>
        </div>
        <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {/* Chat — inspirado en la UI de Gemini: mensajes livianos sin bubble
            pesado para el asistente, input tipo "pill" con acciones adentro. */}
        <Card className="flex h-[75vh] flex-col overflow-hidden">
          <CardContent className="flex flex-1 flex-col overflow-hidden p-0">
            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-6">
              {opp.messages.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                    <Sparkles className="h-6 w-6 text-primary" />
                  </div>
                  <p className="max-w-sm text-sm text-muted-foreground">
                    Contame del cliente y del problema que quiere resolver — o adjuntá la
                    transcripción de la reunión (📎) y extraigo lo que pueda de ahí.
                  </p>
                </div>
              )}
              {opp.messages.map((m) =>
                m.role === 'vendor' ? (
                  <div key={m.id} className="flex justify-end">
                    <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary px-4 py-2.5 text-sm text-primary-foreground">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id} className="flex gap-3">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="max-w-[80%] whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {m.content}
                    </div>
                  </div>
                ),
              )}
              {sendMessage.isPending && (
                <div className="flex gap-3">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" />
                  </div>
                  <p className="text-sm text-muted-foreground">Pensando…</p>
                </div>
              )}
            </div>

            {isVendedor && (
              <div className="border-t border-border p-4">
                <form
                  onSubmit={submit}
                  className="flex items-end gap-2 rounded-3xl border border-input bg-background px-3 py-2 shadow-sm focus-within:ring-2 focus-within:ring-ring"
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.md,text/plain"
                    className="hidden"
                    onChange={onPickTranscript}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="shrink-0 rounded-full"
                    title="Adjuntar transcripción de la reunión (.txt)"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                  <Textarea
                    value={draftMessage}
                    onChange={(e) => setDraftMessage(e.target.value)}
                    placeholder="Escribí acá, o adjuntá la transcripción de la reunión…"
                    className="min-h-[40px] flex-1 resize-none border-0 bg-transparent px-1 py-1.5 shadow-none focus-visible:ring-0"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); }
                    }}
                  />
                  <Button
                    type="submit"
                    size="icon"
                    className="shrink-0 rounded-full"
                    disabled={sendMessage.isPending || !draftMessage.trim()}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </form>
                {sendMessage.isError && (
                  <p className="mt-2 px-2 text-sm text-destructive">{(sendMessage.error as Error).message}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Draft preview + acciones */}
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Draft del brief
              </p>
              {SECTIONS.map((s) => (
                <div key={s.key}>
                  <p className="text-xs font-medium text-muted-foreground">{s.label}</p>
                  <p className="text-sm text-foreground">
                    {(draft as Record<string, string | undefined>)[s.key] || <span className="text-muted-foreground">—</span>}
                  </p>
                </div>
              ))}
              <div>
                <p className="text-xs font-medium text-muted-foreground">Asunciones</p>
                {asunciones.length === 0 ? (
                  <p className="text-sm text-muted-foreground">—</p>
                ) : (
                  <ul className="space-y-1 text-sm text-foreground">
                    {asunciones.map((a, i) => (
                      <li key={i}>
                        {a.texto} — <span className="text-muted-foreground">{a.impactoSiFalla}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          {isVendedor && (
            <Card>
              <CardContent className="space-y-2 p-4">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => syncBrief.mutate()}
                  disabled={syncBrief.isPending}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {syncBrief.isPending ? 'Sincronizando…' : 'Sincronizar brief.md'}
                </Button>
                {syncBrief.data && (
                  <a
                    href={syncBrief.data.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" /> Ver en GitHub
                  </a>
                )}
                <Button
                  className="w-full"
                  onClick={() => handoff.mutate()}
                  disabled={handoff.isPending || opp.status !== 'brief'}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {opp.status !== 'brief' ? 'Ya está con el TL' : handoff.isPending ? 'Pasando…' : 'Pasar a TL'}
                </Button>
                {(syncBrief.isError || handoff.isError) && (
                  <p className="text-xs text-destructive">
                    {((syncBrief.error ?? handoff.error) as Error).message}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <Handshake className="h-3.5 w-3.5" /> Vendedor: {opp.vendedorLogin}
          </p>
        </div>
      </div>

      <Link to="/ventas" className="text-sm text-muted-foreground hover:underline">
        ← Volver a oportunidades
      </Link>
    </div>
  );
}
