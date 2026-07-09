import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  ArrowDown,
  ArrowLeft,
  Send,
  RefreshCw,
  CheckCircle2,
  ExternalLink,
  Paperclip,
  Sparkles,
  Handshake,
  Trash2,
  MessageSquare,
  FileText,
  Settings,
  RotateCcw,
  Lock,
  UserPlus,
  Users,
  Loader2,
} from 'lucide-react';
import {
  useSalesOpportunity,
  useSendSalesMessage,
  useSyncBrief,
  useHandoffToTl,
  useDeleteOpportunity,
  useClaimOpportunity,
  useTransferOpportunity,
  useVendedores,
} from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { salesStatusMeta } from '@/lib/sales-status';
import { SalesPipelineStepper } from './SalesPipelineStepper';
import { ProposalAccessCard } from './ProposalAccessCard';

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

const TAB_TRIGGER_CLASS = 'h-auto whitespace-normal py-2 text-center text-xs leading-tight sm:text-sm';

// Un draft "sucio" (modelos viejos escribieron listas/objetos en campos de
// texto) crashearía el render de React ("Objects are not valid as a React
// child"). Convertimos cualquier valor a texto legible.
function fieldText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(fieldText).join('; ');
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${k}: ${fieldText(x)}`)
      .join('; ');
  }
  return String(v);
}

export function SalesChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');

  const { data: opp, isLoading, isError, error } = useSalesOpportunity(id ?? null);
  const sendMessage = useSendSalesMessage(id ?? '');
  const syncBrief = useSyncBrief(id ?? '');
  const handoff = useHandoffToTl(id ?? '');
  const deleteOpportunity = useDeleteOpportunity();
  const claim = useClaimOpportunity(id ?? '');
  const transfer = useTransferOpportunity(id ?? '');
  const { data: vendedores } = useVendedores();

  const [draftMessage, setDraftMessage] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [failedMessage, setFailedMessage] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [transferTo, setTransferTo] = useState('');
  const [showScrollDown, setShowScrollDown] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const confirmDelete = () => {
    if (!id) return;
    deleteOpportunity.mutate(id, { onSuccess: () => navigate('/ventas') });
  };

  const send = (content: string) => {
    setFailedMessage(null);
    sendMessage.mutate(content, {
      onSuccess: () => setDraftMessage(''),
      // Guardamos EXACTAMENTE lo que falló (no lo que esté en el input en
      // ese momento — el vendedor puede haber seguido escribiendo mientras
      // esperaba) para que "Reintentar" mande lo mismo, no algo distinto.
      onError: () => setFailedMessage(content),
    });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // isPending también, no solo el texto — sin esto, Enter repetido rápido
    // (o mantenido) dispara un segundo mutate() mientras el primero sigue en
    // vuelo: dos prompts que no se ven entre sí, y el update del draft final
    // es last-write-wins — una de las dos respuestas del LLM se pierde.
    if (!draftMessage.trim() || sendMessage.isPending) return;
    send(draftMessage);
  };

  // Contador de segundos mientras el LLM responde — la cascada (Gemini→
  // Groq→DeepSeek) puede tardar 20-30s en picos de carga; sin este número
  // visible, un vendedor no puede distinguir "está pensando" de "se colgó".
  useEffect(() => {
    if (!sendMessage.isPending) { setElapsedSec(0); return; }
    const t = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [sendMessage.isPending]);

  // Auto-scroll al último mensaje (o al indicador de "Pensando…") — un chat
  // que no baja solo con cada mensaje nuevo se siente roto/no-reactivo.
  //
  // OJO: antes usaba scrollIntoView({behavior:'smooth'}) en un div ancla al
  // final. Bug real: el mensaje del vendedor y la respuesta del asistente
  // llegan MUY seguidos (update optimista + respuesta real), cada uno
  // disparaba una animación smooth nueva que cancelaba a la anterior a
  // mitad de camino — el scroll quedaba pegado antes de llegar al final,
  // tapando el final de la última respuesta. Set directo de scrollTop es
  // instantáneo (sin animación que interrumpir) y siempre llega al fondo real.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // Nota: elapsedSec (el contador de "Pensando…") NO va acá a propósito —
    // si el vendedor scrollea para arriba a releer algo mientras espera, no
    // queremos forzarlo de vuelta al fondo cada 1s.
  }, [opp?.messages.length, sendMessage.isPending]);

  // Botón "bajar al final": visible solo cuando el vendedor scrolleó hacia
  // arriba (releer algo largo, p. ej.) — a menos de 200px del fondo no aporta.
  // El auto-scroll de arriba dispara el evento scroll igual, así que el botón
  // se esconde solo cuando un mensaje nuevo baja la vista al fondo.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const onScroll = () => setShowScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [opp?.messages.length]);

  const scrollToBottom = () => {
    const el = messagesContainerRef.current;
    // smooth acá es seguro: es UNA animación disparada por el usuario, no las
    // ráfagas encadenadas que rompían el auto-scroll (ver nota de arriba).
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
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

  if (isError) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            No se pudo cargar la oportunidad: {(error as Error).message}
          </CardContent>
        </Card>
        <Link to="/ventas" className="text-sm text-muted-foreground hover:underline">
          ← Volver a oportunidades
        </Link>
      </div>
    );
  }

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
  // Solo el dueño (vendedor) edita: chatear, sincronizar, ceder, borrar. El
  // backend lo re-verifica; esto es solo para no mostrar controles inútiles.
  const canEdit = isVendedor && opp.isOwner;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
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

      {/* El tracker va siempre de primero, visible sin importar qué pestaña
          esté activa abajo — es el "dónde estamos" del negocio. */}
      <SalesPipelineStepper cliente={opp.cliente} status={opp.status} />

      {/* Proceso ajeno: bloqueado. El chat no viaja (el backend lo oculta) —
          solo se ve el estado general de arriba. */}
      {opp.locked && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 p-4">
            <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <div className="text-sm">
              <p className="font-medium text-foreground">
                Este proceso es de <span className="font-semibold">@{opp.vendedorLogin}</span>.
              </p>
              <p className="text-muted-foreground">
                Solo su dueño puede abrir la conversación y editar el brief. Pídele que te lo
                ceda desde su módulo si necesitas continuarlo.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Proceso sin dueño (descubierto del monorepo/legacy): reclamable. */}
      {opp.canClaim && isVendedor && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-start gap-3 text-sm">
              <UserPlus className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div>
                <p className="font-medium text-foreground">Este proceso no tiene vendedor asignado.</p>
                <p className="text-muted-foreground">
                  Reclámalo para volverte su dueño y poder trabajar el brief desde el chat.
                </p>
              </div>
            </div>
            <Button onClick={() => claim.mutate()} disabled={claim.isPending} className="shrink-0">
              <UserPlus className="mr-2 h-4 w-4" />
              {claim.isPending ? 'Reclamando…' : 'Reclamar proceso'}
            </Button>
          </CardContent>
        </Card>
      )}
      {claim.isError && (
        <p className="px-1 text-sm text-destructive">{(claim.error as Error).message}</p>
      )}

      <Tabs defaultValue="chat">
        <TabsList className="grid h-auto w-full grid-cols-3 gap-1 py-1">
          <TabsTrigger value="chat" className={TAB_TRIGGER_CLASS}>
            <MessageSquare className="mr-1.5 h-4 w-4 shrink-0" /> Chat
          </TabsTrigger>
          <TabsTrigger value="resumen" className={TAB_TRIGGER_CLASS}>
            <FileText className="mr-1.5 h-4 w-4 shrink-0" /> Resumen
          </TabsTrigger>
          <TabsTrigger value="propuesta" className={TAB_TRIGGER_CLASS}>
            <Settings className="mr-1.5 h-4 w-4 shrink-0" /> Propuesta
          </TabsTrigger>
        </TabsList>

        {/* ── Chat: inspirado en la UI de Gemini — mensajes livianos sin
            bubble pesado para el asistente, input tipo "pill". ── */}
        <TabsContent value="chat">
          <Card className="flex h-[65vh] flex-col overflow-hidden">
            <CardContent className="flex flex-1 flex-col overflow-hidden p-0">
              <div className="relative flex-1 overflow-hidden">
              <div ref={messagesContainerRef} className="h-full space-y-5 overflow-y-auto px-6 py-6">
                {opp.messages.length === 0 && (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                      {canEdit ? <Sparkles className="h-6 w-6 text-primary" /> : <Lock className="h-6 w-6 text-muted-foreground" />}
                    </div>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      {canEdit
                        ? 'Cuéntame del cliente y del problema que quiere resolver — o adjunta la transcripción de la reunión (📎) y extraigo lo que pueda de ahí.'
                        : opp.locked
                          ? `La conversación de este proceso es privada de @${opp.vendedorLogin}.`
                          : opp.canClaim
                            ? 'Reclama el proceso (arriba) para empezar la conversación.'
                            : 'Todavía no hay conversación en este proceso.'}
                    </p>
                  </div>
                )}
                {opp.messages.map((m) =>
                  m.role === 'system' ? (
                    <div key={m.id} className="flex justify-center">
                      <p className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                        {m.content}
                      </p>
                    </div>
                  ) : m.role === 'vendor' ? (
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
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                        Pensando
                        <span className="inline-flex gap-0.5">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:-0.3s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:-0.15s]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/60" />
                        </span>
                        {elapsedSec > 0 && <span className="text-xs font-normal text-muted-foreground">({elapsedSec}s)</span>}
                      </p>
                      {elapsedSec >= 12 && (
                        <p className="text-xs text-muted-foreground">
                          El modelo gratuito puede estar saturado. Si se pasa de ~1 minuto, te aviso para reintentar.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {showScrollDown && (
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  onClick={scrollToBottom}
                  title="Ir al final de la conversación"
                  className="absolute bottom-3 right-4 h-9 w-9 rounded-full border border-border shadow-md"
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
              )}
              </div>

              {canEdit && (
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
                      title={sendMessage.isPending ? 'Esperando la respuesta…' : 'Enviar'}
                    >
                      {sendMessage.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </Button>
                  </form>
                  {sendMessage.isError && (
                    <div className="mt-2 flex items-center justify-between gap-2 px-2">
                      <p className="text-sm text-destructive">{(sendMessage.error as Error).message}</p>
                      {failedMessage && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => send(failedMessage)}
                          disabled={sendMessage.isPending}
                        >
                          <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Reintentar
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Resumen: lo que el chat extrajo del brief + las acciones que
            operan SOBRE ese contenido (sincronizar, pasar a TL). ── */}
        <TabsContent value="resumen" className="space-y-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Draft del brief
              </p>
              {SECTIONS.map((s) => (
                <div key={s.key}>
                  <p className="text-xs font-medium text-muted-foreground">{s.label}</p>
                  <p className="text-sm text-foreground">
                    {fieldText((draft as Record<string, unknown>)[s.key]) || <span className="text-muted-foreground">—</span>}
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
                        {fieldText(a?.texto)} — <span className="text-muted-foreground">{fieldText(a?.impactoSiFalla)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          {canEdit && (
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

          {/* Ceder el proceso a otro vendedor — el histórico de la conversación
              viaja con él. Tras ceder, este vendedor pierde el acceso. */}
          {canEdit && (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium text-foreground">Ceder el proceso a otro vendedor</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  La conversación y el brief se transfieren completos. Vas a dejar de ver este
                  proceso cuando lo cedas.
                </p>
                <div className="flex flex-wrap gap-2">
                  <select
                    value={transferTo}
                    onChange={(e) => setTransferTo(e.target.value)}
                    className="min-w-[200px] flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Elegí un vendedor…</option>
                    {(vendedores ?? [])
                      .filter((v) => v.login.toLowerCase() !== opp.vendedorLogin.toLowerCase())
                      .map((v) => (
                        <option key={v.login} value={v.login}>
                          {v.name ? `${v.name} (@${v.login})` : `@${v.login}`}
                        </option>
                      ))}
                  </select>
                  <Button
                    variant="outline"
                    className="shrink-0"
                    disabled={!transferTo || transfer.isPending}
                    onClick={() =>
                      transfer.mutate(transferTo, { onSuccess: () => navigate('/ventas') })
                    }
                  >
                    <Handshake className="mr-2 h-4 w-4" />
                    {transfer.isPending ? 'Cediendo…' : 'Ceder'}
                  </Button>
                </div>
                {transfer.isError && (
                  <p className="text-xs text-destructive">{(transfer.error as Error).message}</p>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Propuesta: link/contraseña/métricas (resumen — el detalle vive
            en /ventas/:id/propuesta) + la zona de peligro de la oportunidad. ── */}
        <TabsContent value="propuesta" className="space-y-4">
          {opp.locked ? (
            <Card>
              <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Lock className="h-4 w-4 shrink-0" />
                La propuesta (link y contraseña) es privada de @{opp.vendedorLogin}.
              </CardContent>
            </Card>
          ) : (
            <ProposalAccessCard id={opp.id} cliente={opp.cliente} oportunidad={opp.oportunidad} />
          )}

          {canEdit && (
            <Card className="border-destructive/30">
              <CardContent className="space-y-2 p-4">
                {confirmingDelete ? (
                  <>
                    <p className="text-xs text-destructive">
                      Esto borra <span className="font-semibold">todo</span>: los archivos en{' '}
                      <code className="rounded bg-destructive/10 px-1">sales/{opp.cliente}/{opp.oportunidad}/</code>{' '}
                      del monorepo y el registro acá. No se puede deshacer desde la plataforma.
                      {opp.status !== 'brief' && (
                        <> Esta oportunidad ya está en etapa <strong>{salesStatusMeta(opp.status).label}</strong> — verificá que de verdad quiera borrarla y no solo archivarla.</>
                      )}
                    </p>
                    <div className="flex gap-2">
                      <Button variant="outline" className="flex-1" onClick={() => setConfirmingDelete(false)}>
                        Cancelar
                      </Button>
                      <Button
                        variant="destructive"
                        className="flex-1"
                        onClick={confirmDelete}
                        disabled={deleteOpportunity.isPending}
                      >
                        {deleteOpportunity.isPending ? 'Borrando…' : 'Sí, borrar todo'}
                      </Button>
                    </div>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Eliminar del pipeline
                  </Button>
                )}
                {deleteOpportunity.isError && (
                  <p className="text-xs text-destructive">{(deleteOpportunity.error as Error).message}</p>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-between px-1">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Handshake className="h-3.5 w-3.5" /> Vendedor: {opp.vendedorLogin}
        </p>
        <Link to="/ventas" className="text-sm text-muted-foreground hover:underline">
          ← Volver a oportunidades
        </Link>
      </div>
    </div>
  );
}
