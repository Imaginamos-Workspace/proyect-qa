import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Building2, Check, ChevronDown, ExternalLink, Linkedin, Loader2, LockOpen, Mail, Phone, RotateCcw, Send, Sparkles, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SalesChatPage } from './SalesChatPage';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAddInteraction,
  useCreateOpportunity,
  useEnrichSavedProspect,
  useProspectInteractions,
  useSavedProspects,
  useSalesOpportunities,
  useUpdateProspect,
  useAddTlReview,
  useTlReviews,
} from '@/hooks/use-sales';
import { api } from '@/lib/api';
import type { SavedProspect, SavedProspectEstado, SavedProspectEtapa } from '@qa/shared-types';
import { ProspectContacts } from './ProspectContacts';

// Mismo criterio kebab-case que exige CreateOpportunityDto en el backend.
function slugify(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Las 11 etapas del proceso comercial, en el orden numerado por el equipo.
 * `hint` es el criterio para mover una tarjeta acá: sin un criterio explícito
 * cada vendedor interpreta "Propuesta" o "Frío" a su manera y el embudo deja
 * de ser comparable entre personas.
 */
/**
 * Equivalencia de los esquemas anteriores (7 y 11 estados) a las 4 columnas,
 * SOLO para mostrar. Existe porque el código puede desplegarse antes de que
 * corra la migración 033: sin esto una tarjeta con un estado viejo no
 * coincidiría con ninguna columna y desaparecería del tablero.
 *
 * Cuando la migración corra, ningún registro cae acá y se puede borrar.
 */
const LEGACY: Record<string, SavedProspectEstado> = {
  'por-contactar': 'backlog', referido: 'backlog', contacto: 'backlog', recontactar: 'backlog',
  'en-seguimiento': 'en-gestion', contactado: 'en-gestion', 'reunion-agendada': 'en-gestion',
  reunion: 'en-gestion', propuesta: 'en-gestion', 'en-revision': 'en-gestion', 'cambio-propuesta': 'en-gestion',
  convertido: 'aprobado', 'aprobado-documentos': 'aprobado', 'aprobado-cerrado': 'aprobado',
  descartado: 'rechazado', perdido: 'rechazado', 'no-calificado': 'rechazado', frio: 'rechazado',
};

/** Columna efectiva, tolerando los estados de esquemas anteriores. */
export function columnaDe(estado: string): SavedProspectEstado {
  return (LEGACY[estado] ?? estado) as SavedProspectEstado;
}

/** Etapa vigente, tolerando prospectos guardados antes de la migración 033. */
export function etapaDeProspecto(p: { etapa?: string; estado: string }): SavedProspectEtapa {
  if (p.etapa) return p.etapa as SavedProspectEtapa;
  return (ETAPA_LEGACY[p.estado] ?? 'contacto') as SavedProspectEtapa;
}

/** Estados viejos → etapa equivalente, para los que aún no tienen `etapa`. */
const ETAPA_LEGACY: Record<string, SavedProspectEtapa> = {
  'por-contactar': 'contacto', referido: 'contacto', contactado: 'contacto',
  'en-seguimiento': 'recontactar', 'reunion-agendada': 'reunion',
  convertido: 'aprobado-cerrado', descartado: 'perdido',
};

/**
 * Las 4 columnas del tablero. `accent` es la línea de color bajo el título:
 * da un ancla visual para saber dónde estás sin tener que leer.
 */
/** Las 11 etapas del proceso comercial, con el criterio de cada una. */
export const ETAPAS: { etapa: SavedProspectEtapa; label: string; hint: string }[] = [
  { etapa: 'contacto', label: 'Contacto', hint: 'Lead registrado y primer acercamiento para validar interés y necesidad.' },
  { etapa: 'reunion', label: 'Reunión', hint: 'Reuniones para entender necesidad, contexto y alcance. Puede repetirse.' },
  { etapa: 'propuesta', label: 'Propuesta', hint: 'Etapa interna: armás alcance, tiempos e inversión.' },
  { etapa: 'en-revision', label: 'En revisión', hint: 'Enviada, el cliente la evalúa. Registra servicios, monto y fecha.' },
  { etapa: 'aprobado-documentos', label: 'Aprobado / Documentos', hint: 'Confirmó avanzar: contrato, documentos y primera factura.' },
  { etapa: 'aprobado-cerrado', label: 'Aprobado / Cerrado', hint: 'Firmado y listo para operaciones.' },
  { etapa: 'perdido', label: 'Perdido', hint: 'No avanzó. El motivo es obligatorio en las notas.' },
  { etapa: 'frio', label: 'Frío', hint: 'Sin contacto tras 3 intentos.' },
  { etapa: 'cambio-propuesta', label: 'Cambio de propuesta', hint: 'Pidió ajustes de alcance, tiempos o inversión.' },
  { etapa: 'no-calificado', label: 'No calificado', hint: 'Tras la reunión inicial, no es cliente potencial.' },
  { etapa: 'recontactar', label: 'Recontactar', hint: 'Aplazó o dejó de contestar, pero se ve potencial.' },
];

/** Color de cada columna, para que el estado del card se lea de un vistazo. */
const ESTADO_COLOR: Record<SavedProspectEstado, string> = {
  backlog: 'bg-slate-500',
  'en-gestion': 'bg-emerald-600',
  rechazado: 'bg-rose-600',
  aprobado: 'bg-amber-600',
};

export const COLUMNS: { estado: SavedProspectEstado; label: string; hint: string; accent: string }[] = [
  { estado: 'backlog', label: 'Backlog', accent: 'bg-slate-400', hint: 'Leads por trabajar: registrados, sin gestión activa todavía.' },
  { estado: 'en-gestion', label: 'En gestión', accent: 'bg-emerald-500', hint: 'Se está trabajando: reuniones, propuesta, revisión o ajustes pedidos por el cliente.' },
  { estado: 'rechazado', label: 'Rechazado', accent: 'bg-rose-500', hint: 'No avanzó: desistió, no calificó o se enfrió. Anota el motivo en las notas.' },
  { estado: 'aprobado', label: 'Aprobado', accent: 'bg-amber-500', hint: 'Cerrado: aprobado, documentos firmados, listo para operaciones.' },
];

const TIPOS = [
  { value: 'llamada', label: 'Llamada' },
  { value: 'correo', label: 'Correo' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'otro', label: 'Otro' },
];

const RESULTADOS = [
  { value: 'sin-respuesta', label: 'Sin respuesta' },
  { value: 'contacto-logrado', label: 'Contacto logrado' },
  { value: 'reunion-agendada', label: 'Reunión agendada' },
  { value: 'referido', label: 'Me refirió a otra persona' },
  { value: 'rechazado', label: 'No le interesa' },
  { value: 'ya-no-trabaja', label: 'Ya no trabaja ahí' },
];

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

/** Panel de gestión del prospecto seleccionado: datos de contacto accionables,
 *  nutrición (teléfono/notas), registro de intentos con transición automática,
 *  referidos que crean prospecto nuevo, reintentos agendados, y conversión. */
/**
 * Envío de la propuesta al TL para revisión. Se registra como historial y no
 * como un campo del prospecto: si el cliente pide cambios ("Cambio de
 * propuesta"), la propuesta vuelve al TL y hay que poder ver las dos vueltas.
 *
 * La fecha la declara el vendedor —pudo haberla mandado ayer y registrarla
 * hoy—, así que no se usa la del servidor.
 */
function TlReviewModal({ prospect, onClose }: { prospect: SavedProspect; onClose: () => void }) {
  const enviar = useAddTlReview(prospect.id);
  const { data: previos } = useTlReviews(prospect.id);
  const [tlEmail, setTlEmail] = useState('');
  // Por defecto hoy, que es el caso normal.
  const [sentAt, setSentAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [comments, setComments] = useState('');

  const emailValido = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(tlEmail.trim());

  const guardar = () => {
    if (!emailValido || !sentAt) return;
    enviar.mutate(
      { tlEmail: tlEmail.trim(), sentAt, comments: comments.trim() || undefined },
      { onSuccess: onClose },
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Enviar propuesta al TL"
      onClick={onClose}
    >
      <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <CardContent className="space-y-4 p-5">
          <div>
            <p className="font-semibold text-foreground">Enviar propuesta al TL</p>
            <p className="text-sm text-muted-foreground">
              {prospect.company ?? prospect.name} · queda registrado en el historial de revisiones.
            </p>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="tl-email">Correo del TL</label>
            <Input
              id="tl-email"
              type="email"
              value={tlEmail}
              onChange={(e) => setTlEmail(e.target.value)}
              placeholder="nombre@imaginamos.com"
            />
            {tlEmail && !emailValido && (
              <p className="text-xs text-destructive">Ese correo no parece válido.</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="tl-fecha">Fecha de envío</label>
            <Input id="tl-fecha" type="date" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="tl-coment">Comentarios</label>
            <Textarea
              id="tl-coment"
              rows={4}
              value={comments}
              onChange={(e) => setComments(e.target.value)}
              placeholder="Qué revisar, alcance propuesto, dudas para el TL…"
            />
          </div>

          {!!previos?.length && (
            <div className="rounded-lg border border-border p-3">
              <p className="mb-1 text-xs font-medium text-foreground">Envíos anteriores</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {previos.map((r) => (
                  <li key={r.id}>{r.sentAt} · {r.tlEmail}{r.comments ? ` — ${r.comments}` : ''}</li>
                ))}
              </ul>
            </div>
          )}

          {enviar.isError && (
            <p className="text-sm text-destructive">{(enviar.error as Error).message}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button onClick={guardar} disabled={!emailValido || !sentAt || enviar.isPending}>
              {enviar.isPending
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Registrando…</>
                : <><Send className="mr-2 h-4 w-4" /> Registrar envío</>}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ProspectDetail({ prospect, onClose }: { prospect: SavedProspect; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: interactions, isLoading: loadingLog } = useProspectInteractions(prospect.id);
  const addInteraction = useAddInteraction();
  const updateProspect = useUpdateProspect();
  const enrichSaved = useEnrichSavedProspect();
  const createOpportunity = useCreateOpportunity();

  const [modalTl, setModalTl] = useState(false);
  const [tipo, setTipo] = useState('llamada');
  const [resultado, setResultado] = useState('sin-respuesta');
  const [notas, setNotas] = useState('');
  const [referidoNombre, setReferidoNombre] = useState('');
  const [referidoContacto, setReferidoContacto] = useState('');
  const [reintentarAt, setReintentarAt] = useState('');
  const [phone, setPhone] = useState(prospect.phone ?? '');
  const [notes, setNotes] = useState(prospect.notes ?? '');
  const [converting, setConverting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const registrar = () => {
    setErrorMsg(null);
    addInteraction.mutate(
      {
        id: prospect.id,
        tipo,
        resultado,
        notas: notas.trim() || undefined,
        referidoNombre: resultado === 'referido' ? referidoNombre.trim() || undefined : undefined,
        referidoContacto: resultado === 'referido' ? referidoContacto.trim() || undefined : undefined,
        reintentarAt: reintentarAt ? new Date(reintentarAt).toISOString() : undefined,
      },
      {
        onSuccess: () => { setNotas(''); setReferidoNombre(''); setReferidoContacto(''); setReintentarAt(''); },
        onError: (e) => setErrorMsg((e as Error).message),
      },
    );
  };

  const nutrir = () => {
    setErrorMsg(null);
    updateProspect.mutate(
      { id: prospect.id, phone: phone.trim(), notes: notes.trim() },
      { onError: (e) => setErrorMsg((e as Error).message) },
    );
  };

  // Convertir: crea la oportunidad con los datos ya enriquecidos, siembra el
  // chat y marca el prospecto como convertido (enlazado a la oportunidad).
  const convertir = async () => {
    setErrorMsg(null);
    setConverting(true);
    try {
      const cliente = slugify(prospect.company ?? prospect.name);
      const opp = await createOpportunity.mutateAsync({ cliente, oportunidad: 'contacto-inicial' });
      const seedMessage =
        `Prospecto trabajado en el pipeline de prospección — ${prospect.company ?? 'empresa por confirmar'}` +
        `${prospect.industry ? ` (${prospect.industry})` : ''}. ` +
        `Contacto: ${prospect.name}${prospect.title ? `, ${prospect.title}` : ''}.` +
        `${prospect.email ? ` Email: ${prospect.email}.` : ''}` +
        `${prospect.phone ? ` Teléfono: ${prospect.phone}.` : ''}` +
        `${prospect.location ? ` Ubicación: ${prospect.location}.` : ''}` +
        `${prospect.notes ? ` Notas de prospección: ${prospect.notes}.` : ''}` +
        ` Ayúdame a armar el brief con esto como punto de partida.`;
      await api.post(`/sales/opportunities/${opp.id}/messages`, { content: seedMessage }, 55_000);
      // Crear la oportunidad además cierra la etapa comercial: el negocio
      // quedó aprobado y pasa a operaciones.
      await updateProspect.mutateAsync({ id: prospect.id, etapa: 'aprobado-cerrado', opportunityId: opp.id });
      navigate(`/ventas/${opp.id}`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'No se pudo convertir el prospecto.');
    } finally {
      setConverting(false);
    }
  };

  // Si el prospecto ya tiene oportunidad, el trabajo real está en el brief:
  // el chat se abre y la gestión arranca comprimida. Si no la tiene, no hay
  // chat que mostrar, así que la gestión queda abierta.
  const tieneBrief = !!prospect.opportunityId;
  const [gestionAbierta, setGestionAbierta] = useState(!tieneBrief);

  return (
    <div
      className="fixed inset-0 z-40 overflow-y-auto bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Caso de ${prospect.company ?? prospect.name}`}
      onClick={onClose}
    >
    <Card className="mx-auto max-w-5xl border-primary/40" onClick={(e) => e.stopPropagation()}>
      <CardContent className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-foreground">{prospect.name}{prospect.title ? ` — ${prospect.title}` : ''}</p>
          <p className="text-sm text-muted-foreground">{prospect.company ?? 'Empresa por confirmar'}{prospect.industry ? ` · ${prospect.industry}` : ''}</p>
        </div>
        {/* Esquina superior: el estado ACTUAL (columna del tablero, solo
            lectura porque se deriva) y el desplegable con las 11 etapas. */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold uppercase tracking-wide text-white ${ESTADO_COLOR[columnaDe(prospect.estado)]}`}
            title={COLUMNS.find((c) => c.estado === columnaDe(prospect.estado))?.hint}
          >
            <Check className="h-4 w-4" /> {COLUMNS.find((c) => c.estado === columnaDe(prospect.estado))?.label}
          </span>

          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={etapaDeProspecto(prospect)}
            onChange={(e) => updateProspect.mutate({ id: prospect.id, etapa: e.target.value as SavedProspectEtapa })}
            title={ETAPAS.find((x) => x.etapa === etapaDeProspecto(prospect))?.hint}
            aria-label="Etapa del proceso comercial"
          >
            {ETAPAS.map((x) => <option key={x.etapa} value={x.etapa}>{x.label}</option>)}
          </select>
          {updateProspect.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

          <Button variant="ghost" size="sm" onClick={onClose}>Cerrar</Button>
        </div>
      </div>

      <div>
        <Button variant="outline" size="sm" onClick={() => setModalTl(true)}>
          <Send className="mr-2 h-4 w-4" /> Enviar propuesta al TL
        </Button>
      </div>

      {modalTl && <TlReviewModal prospect={prospect} onClose={() => setModalTl(false)} />}

      {/* El brief con la IA, abierto y en el paso donde quedó el agente: el
          chat carga su propio historial y el stepper marca la etapa real. */}
      {tieneBrief && (
        <div className="rounded-lg border border-border">
          <SalesChatPage opportunityId={prospect.opportunityId!} embedded />
        </div>
      )}

      {/* Gestión y datos: comprimida cuando ya hay brief, porque el foco pasa
          a ser la conversación, no la ficha. */}
      <button
        type="button"
        onClick={() => setGestionAbierta((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/50"
        aria-expanded={gestionAbierta}
      >
        <span>Gestión y datos</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${gestionAbierta ? 'rotate-180' : ''}`} />
      </button>
      {gestionAbierta && (
      <>

      {/* Accesos directos de contacto — para llamar/escribir sin salir. */}
      <div className="flex flex-wrap gap-2 text-sm">
        {prospect.email && (
          <a href={`mailto:${prospect.email}`}><Badge variant="secondary" className="gap-1"><Mail className="h-3 w-3" /> {prospect.email}</Badge></a>
        )}
        {prospect.phone && (
          <a href={`tel:${prospect.phone}`}><Badge variant="secondary" className="gap-1"><Phone className="h-3 w-3" /> {prospect.phone}</Badge></a>
        )}
        {prospect.linkedinUrl && (
          <a href={prospect.linkedinUrl} target="_blank" rel="noreferrer"><Badge variant="secondary" className="gap-1"><Linkedin className="h-3 w-3" /> LinkedIn</Badge></a>
        )}
        {prospect.companyWebsite && (
          <a href={prospect.companyWebsite} target="_blank" rel="noreferrer"><Badge variant="secondary" className="gap-1"><ExternalLink className="h-3 w-3" /> Sitio</Badge></a>
        )}
        {prospect.nextAttemptAt && (
          <Badge variant="warning" className="gap-1"><RotateCcw className="h-3 w-3" /> Reintentar {fmtDate(prospect.nextAttemptAt)}</Badge>
        )}
        {/* Los de la corrida semanal entran con la vista previa (sin email) —
            desbloquear trae el dato completo de Apollo (1 crédito). */}
        {!prospect.apolloId.startsWith('ref-') && (!prospect.email || !prospect.linkedinUrl) && (
          <Button
            size="sm"
            variant="outline"
            disabled={enrichSaved.isPending}
            onClick={() => enrichSaved.mutate(prospect.id, { onError: (e) => setErrorMsg((e as Error).message) })}
          >
            {enrichSaved.isPending
              ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Desbloqueando…</>
              : <><LockOpen className="mr-1.5 h-3.5 w-3.5" /> Desbloquear dato (1 crédito)</>}
          </Button>
        )}
      </div>

      {/* Nutrir datos: teléfono (Apollo casi nunca lo trae) y notas. */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[160px]">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Teléfono</label>
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+57 …" />
        </div>
        <div className="min-w-[220px] flex-1">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Notas</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="contexto, mejor horario, etc." />
        </div>
        <Button variant="outline" size="sm" onClick={nutrir} disabled={updateProspect.isPending}>Guardar datos</Button>
      </div>

      {/* Registrar intento de contacto — el estado del pipeline se mueve solo. */}
      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-foreground">Registrar intento de contacto</p>
        <div className="flex flex-wrap gap-2">
          <select value={tipo} onChange={(e) => setTipo(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
            {TIPOS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <select value={resultado} onChange={(e) => setResultado(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
            {RESULTADOS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
          <Input className="min-w-[180px] flex-1" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="notas del intento (opcional)" />
        </div>
        {resultado === 'referido' && (
          <div className="flex flex-wrap gap-2">
            <Input className="min-w-[180px] flex-1" value={referidoNombre} onChange={(e) => setReferidoNombre(e.target.value)} placeholder="Nombre del referido" />
            <Input className="min-w-[180px] flex-1" value={referidoContacto} onChange={(e) => setReferidoContacto(e.target.value)} placeholder="Email o teléfono del referido" />
          </div>
        )}
        {resultado === 'sin-respuesta' && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Volver a intentar el</label>
            <Input type="date" className="w-40" value={reintentarAt} onChange={(e) => setReintentarAt(e.target.value)} />
          </div>
        )}
        <Button size="sm" onClick={registrar} disabled={addInteraction.isPending}>
          {addInteraction.isPending ? <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Registrando…</> : 'Registrar'}
        </Button>
        {resultado === 'referido' && (
          <p className="text-xs text-muted-foreground">El referido se crea como prospecto nuevo en "Por contactar".</p>
        )}
        {resultado === 'ya-no-trabaja' && (
          <p className="text-xs text-muted-foreground">
            Se descarta con su bitácora. Si te dio otro nombre, usa mejor "Me refirió a otra persona"; si no,
            agrega otro contacto de {prospect.company ? `"${prospect.company}"` : 'la empresa'} en el panel de Contactos.
          </p>
        )}
      </div>

      {/* Contactos — se cargan al abrir la ficha, que es cuando el vendedor
          empieza a trabajar el prospecto. Único punto que puede consumir
          créditos, y solo la primera vez. */}
      <ProspectContacts prospectId={prospect.id} />

      {/* Bitácora */}
      <div>
        <p className="mb-1 text-sm font-medium text-foreground">Bitácora</p>
        {loadingLog ? (
          <Skeleton className="h-10 w-full" />
        ) : !interactions?.length ? (
          <p className="text-xs text-muted-foreground">Sin intentos registrados todavía.</p>
        ) : (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {interactions.map((i) => (
              <li key={i.id}>
                <span className="font-medium text-foreground">{fmtDate(i.createdAt)}</span> · {i.tipo} → {i.resultado}
                {i.referidoNombre ? ` (refirió a ${i.referidoNombre}${i.referidoContacto ? `, ${i.referidoContacto}` : ''})` : ''}
                {i.reintentarAt ? ` · reintentar ${fmtDate(i.reintentarAt)}` : ''}
                {i.notas ? ` — ${i.notas}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>

      </>
      )}

      {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={convertir} disabled={converting || etapaDeProspecto(prospect) === 'aprobado-cerrado'}>
          {converting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creando oportunidad…</> : etapaDeProspecto(prospect) === 'aprobado-cerrado' ? 'Ya convertido' : <><Sparkles className="mr-2 h-4 w-4" /> Crear oportunidad</>}
        </Button>
        {prospect.opportunityId && (
          <Button variant="outline" onClick={() => navigate(`/ventas/${prospect.opportunityId}`)}>Abrir oportunidad</Button>
        )}
        {columnaDe(prospect.estado) !== 'rechazado' && columnaDe(prospect.estado) !== 'aprobado' && (
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => updateProspect.mutate({ id: prospect.id, etapa: 'perdido' })}
          >
            <Trash2 className="mr-2 h-4 w-4" /> Marcar perdido
          </Button>
        )}
      </div>
      </CardContent>
    </Card>
    </div>
  );
}

/** Pipeline de prospección: kanban por estado de contacto. Se alimenta de la
 *  búsqueda (botón Guardar), de la corrida semanal (cron) y de referidos. */
export function ProspectsPipeline({
  abrirId = null,
  onAbierto,
}: {
  /** Ficha a abrir al entrar — se usa al saltar desde la búsqueda. */
  abrirId?: string | null;
  onAbierto?: () => void;
} = {}) {
  const { data: prospects, isLoading } = useSavedProspects();
  // Para poder mostrar en qué etapa va la oportunidad de un cliente convertido,
  // sin obligar al vendedor a salir del tablero a buscarla.
  const { data: oportunidades } = useSalesOpportunities();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Abrir la ficha pedida desde la búsqueda, una sola vez.
  useEffect(() => {
    if (!abrirId) return;
    setSelectedId(abrirId);
    onAbierto?.();
  }, [abrirId, onAbierto]);

  // Drag & drop nativo de HTML5: cero dependencias nuevas.
  const [arrastrando, setArrastrando] = useState<string | null>(null);
  const [sobre, setSobre] = useState<SavedProspectEstado | null>(null);
  const mover = useUpdateProspect();

  /** @param idSoltado viene del dataTransfer; es más confiable que el estado
   *  de React, que puede haberse limpiado si el dragend llegó antes. */
  const soltarEn = (estado: SavedProspectEstado, idSoltado?: string) => {
    const id = idSoltado || arrastrando;
    setArrastrando(null);
    setSobre(null);
    if (!id) return;
    const actual = (prospects ?? []).find((p) => p.id === id);
    if (!actual || columnaDe(actual.estado) === estado) return; // soltó en su misma columna
    mover.mutate({ id, estado });
  };

  const etapaDe = (opportunityId: string) =>
    (oportunidades ?? []).find((o) => o.id === opportunityId)?.status ?? null;

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  const all = prospects ?? [];
  const selected = all.find((p) => p.id === selectedId) ?? null;

  if (!all.length) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          Tu pipeline está vacío — guarda prospectos desde la pestaña "Buscar" o guarda una búsqueda
          semanal y se llenará solo cada lunes.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {selected && <ProspectDetail key={selected.id} prospect={selected} onClose={() => setSelectedId(null)} />}
      {/* Rejilla que envuelve, NO scroll horizontal: con 7 columnas de ancho
          fijo, "Convertido" y "Descartado" quedaban fuera de pantalla y el
          vendedor creía que sus clientes habían desaparecido. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => {
          const items = all.filter((p) => columnaDe(p.estado) === col.estado);
          return (
            <div
              key={col.estado}
              className={`min-w-0 rounded-lg p-1 transition-colors ${sobre === col.estado ? 'bg-primary/10 ring-2 ring-primary' : ''}`}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setSobre(col.estado); }}
              onDragLeave={() => setSobre((x) => (x === col.estado ? null : x))}
              onDrop={(e) => { e.preventDefault(); soltarEn(col.estado, e.dataTransfer.getData('text/plain')); }}
            >
              <div className="mb-3 px-1">
                <div className="flex items-baseline justify-between gap-2">
                  {/* text-base = 2 puntos menos que el text-lg del mockup. */}
                  <p className="cursor-help text-base font-semibold uppercase tracking-wide text-foreground" title={col.hint}>
                    {col.label}
                  </p>
                  <span className="text-base font-medium text-muted-foreground">{items.length}</span>
                </div>
                <div className={`mt-1 h-0.5 w-full rounded-full ${col.accent}`} />
              </div>
              <div className="space-y-2">
                {items.map((p) => (
                  <Card
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    draggable
                    onDragStart={(e) => {
                      // setData es OBLIGATORIO: sin datos en el dataTransfer el
                      // navegador considera el arrastre inválido y nunca dispara
                      // el drop — la tarjeta se veía arrastrar y volvía a su sitio.
                      e.dataTransfer.setData('text/plain', p.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setArrastrando(p.id);
                    }}
                    onDragEnd={() => { setArrastrando(null); setSobre(null); }}
                    onClick={() => setSelectedId(p.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(p.id); }}
                    className={`cursor-grab transition-colors hover:border-primary hover:bg-primary/5 active:cursor-grabbing ${selectedId === p.id ? 'border-primary' : ''} ${arrastrando === p.id ? 'opacity-40' : ''}`}
                  >
                    <CardContent className="space-y-1 p-3">
                      <div className="flex items-center justify-between gap-1 text-muted-foreground">
                        <span className="flex items-center gap-1.5 truncate text-xs"><Building2 className="h-3 w-3 shrink-0" /> {p.company ?? 'Sin empresa'}</span>
                        {p.origen !== 'manual' && <Badge variant="secondary" className="shrink-0 text-[10px]">{p.origen}</Badge>}
                      </div>
                      <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                      {/* Un cliente convertido sigue vivo: mostrar en qué etapa
                          va su oportunidad evita tener que salir a buscarla. */}
                      {p.opportunityId && etapaDe(p.opportunityId) && (
                        <Badge variant="outline" className="text-[10px]">{etapaDe(p.opportunityId)}</Badge>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        {p.email && <Mail className="h-3 w-3" />}
                        {p.phone && <Phone className="h-3 w-3" />}
                        {p.linkedinUrl && <Linkedin className="h-3 w-3" />}
                        {p.nextAttemptAt && <span className="flex items-center gap-0.5 text-amber-600"><RotateCcw className="h-3 w-3" /> {fmtDate(p.nextAttemptAt)}</span>}
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {items.length === 0 && (
                  <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                    {sobre === col.estado ? 'Soltá acá' : 'Vacío'}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
