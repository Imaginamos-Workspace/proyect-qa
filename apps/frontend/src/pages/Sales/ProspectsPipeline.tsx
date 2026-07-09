import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Building2, ExternalLink, Linkedin, Loader2, LockOpen, Mail, Phone, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useAddInteraction,
  useCreateOpportunity,
  useEnrichSavedProspect,
  useProspectInteractions,
  useSavedProspects,
  useUpdateProspect,
} from '@/hooks/use-sales';
import { api } from '@/lib/api';
import type { SavedProspect, SavedProspectEstado } from '@qa/shared-types';

// Mismo criterio kebab-case que exige CreateOpportunityDto en el backend.
function slugify(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const COLUMNS: { estado: SavedProspectEstado; label: string }[] = [
  { estado: 'por-contactar', label: 'Por contactar' },
  { estado: 'en-seguimiento', label: 'En seguimiento' },
  { estado: 'contactado', label: 'Contactado' },
  { estado: 'reunion-agendada', label: 'Reunión agendada' },
  { estado: 'referido', label: 'Referido' },
  { estado: 'convertido', label: 'Convertido' },
  { estado: 'descartado', label: 'Descartado' },
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
];

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

/** Panel de gestión del prospecto seleccionado: datos de contacto accionables,
 *  nutrición (teléfono/notas), registro de intentos con transición automática,
 *  referidos que crean prospecto nuevo, reintentos agendados, y conversión. */
function ProspectDetail({ prospect, onClose }: { prospect: SavedProspect; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: interactions, isLoading: loadingLog } = useProspectInteractions(prospect.id);
  const addInteraction = useAddInteraction();
  const updateProspect = useUpdateProspect();
  const enrichSaved = useEnrichSavedProspect();
  const createOpportunity = useCreateOpportunity();

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
      await updateProspect.mutateAsync({ id: prospect.id, estado: 'convertido', opportunityId: opp.id });
      navigate(`/ventas/${opp.id}`);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'No se pudo convertir el prospecto.');
    } finally {
      setConverting(false);
    }
  };

  return (
    <Card className="border-primary/40">
      <CardContent className="space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-foreground">{prospect.name}{prospect.title ? ` — ${prospect.title}` : ''}</p>
          <p className="text-sm text-muted-foreground">{prospect.company ?? 'Empresa por confirmar'}{prospect.industry ? ` · ${prospect.industry}` : ''}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>Cerrar</Button>
      </div>

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
      </div>

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

      {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}

      <div className="flex flex-wrap gap-2">
        <Button onClick={convertir} disabled={converting || prospect.estado === 'convertido'}>
          {converting ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Creando oportunidad…</> : prospect.estado === 'convertido' ? 'Ya convertido' : <><Sparkles className="mr-2 h-4 w-4" /> Crear oportunidad</>}
        </Button>
        {prospect.opportunityId && (
          <Button variant="outline" onClick={() => navigate(`/ventas/${prospect.opportunityId}`)}>Abrir oportunidad</Button>
        )}
        {prospect.estado !== 'descartado' && prospect.estado !== 'convertido' && (
          <Button
            variant="ghost"
            className="text-destructive"
            onClick={() => updateProspect.mutate({ id: prospect.id, estado: 'descartado' })}
          >
            <Trash2 className="mr-2 h-4 w-4" /> Descartar
          </Button>
        )}
      </div>
      </CardContent>
    </Card>
  );
}

/** Pipeline de prospección: kanban por estado de contacto. Se alimenta de la
 *  búsqueda (botón Guardar), de la corrida semanal (cron) y de referidos. */
export function ProspectsPipeline() {
  const { data: prospects, isLoading } = useSavedProspects();
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
      <div className="flex gap-4 overflow-x-auto pb-2">
        {COLUMNS.map((col) => {
          const items = all.filter((p) => p.estado === col.estado);
          return (
            <div key={col.estado} className="w-64 shrink-0">
              <div className="mb-2 flex items-center justify-between px-1">
                <p className="text-sm font-semibold text-foreground">{col.label}</p>
                <Badge variant="secondary">{items.length}</Badge>
              </div>
              <div className="space-y-2">
                {items.map((p) => (
                  <Card
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(p.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(p.id); }}
                    className={`cursor-pointer transition-colors hover:border-primary hover:bg-primary/5 ${selectedId === p.id ? 'border-primary' : ''}`}
                  >
                    <CardContent className="space-y-1 p-3">
                      <div className="flex items-center justify-between gap-1 text-muted-foreground">
                        <span className="flex items-center gap-1.5 truncate text-xs"><Building2 className="h-3 w-3 shrink-0" /> {p.company ?? 'Sin empresa'}</span>
                        {p.origen !== 'manual' && <Badge variant="secondary" className="shrink-0 text-[10px]">{p.origen}</Badge>}
                      </div>
                      <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
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
                  <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">Vacío</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
