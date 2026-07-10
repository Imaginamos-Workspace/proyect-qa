import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import { GeminiProvider } from '../ai/providers/gemini.provider';
import { SalesRagService } from './sales-rag.service';
import { RolesService } from '../scrum/roles.service';
import type {
  SalesBriefDraft,
  SalesMessage,
  SalesNotificationsResult,
  SalesOpportunity,
  SalesOpportunityDetail,
  SalesOwnershipResult,
  SalesProposalAccess,
  SalesProposalMetrics,
  SalesRegenerateProposalResult,
  SalesSendMessageResult,
  SalesSyncResult,
} from '../../shared-types';

const OWNER = 'imaginamos';
const REPO = 'qa-automation-monorepo';
const OPPORTUNITIES_TABLE = 'sales_opportunities';
const MESSAGES_TABLE = 'sales_messages';
const NOTIFICATIONS_TABLE = 'sales_notifications';
// Últimos N turnos que entran al prompt — suficiente contexto conversacional
// sin inflar tokens en cada mensaje (una sesión de brief son ~10-20 turnos).
const HISTORY_WINDOW = 12;
// Directorios de sales/ que NO son oportunidades reales — se saltan al descubrir.
const NON_OPPORTUNITY_DIRS = new Set(['templates', '_stock']);
// Throttle del descubrimiento — evita listar todo `sales/` en cada carga de la
// lista (mismo criterio que los TTL de caché de scrum.service.ts).
const DISCOVERY_TTL_MS = 60_000;
// Tope duro: el descubrimiento no puede bloquear la carga de la lista más que
// esto. Si GitHub está lento, la lista devuelve lo que hay en la base y el
// descubrimiento se completa en otra carga.
const DISCOVERY_DEADLINE_MS = 6_000;
// Ventana en la que se rechaza un segundo dispatch de "regenerar contraseña"
// para la misma oportunidad — un poco más que el timeout de polling del
// frontend (2 min), para cubrir el caso de un CI lento.
const REGENERATE_COOLDOWN_MS = 3 * 60_000;
// Auto-sync de brief.md al monorepo por checkpoints: durante una ráfaga de
// mensajes se sincroniza como MÁXIMO una vez cada 10 min, en vez de un commit
// por turno (que ensuciaría el historial de main). El botón "Sincronizar" y el
// handoff siguen forzando la sincronización inmediata sin este límite.
const AUTOSYNC_DEBOUNCE_MS = 10 * 60_000;
// Deadline duro de la respuesta del LLM. Si la cascada (flash→pro→Groq→DeepSeek)
// se pasa de esto, cortamos con un error accionable en vez de dejar la request
// colgada — el usuario veía "Pensando… (200s)" sin fin. Debe quedar por debajo
// del maxDuration de Vercel (60s) y del timeout del cliente (55s) para que el
// backend SIEMPRE devuelva algo antes de que lo maten.
const LLM_DEADLINE_MS = 40_000;
// El RAG es un extra: si su embedding se cuelga, no puede demorar la respuesta.
const RAG_RETRIEVE_DEADLINE_MS = 6_000;
// Auto-compact del chat (tipo Claude Code): lo que queda fuera de la ventana de
// HISTORY_WINDOW turnos se resume en un bloque compacto que viaja en cada
// prompt. Se recompacta en lote (cada SUMMARY_BATCH mensajes nuevos fuera de la
// ventana), en el post-turno (no bloquea la respuesta), con el modelo rápido.
const CHAT_SUMMARY_BATCH = 6;
const CHAT_SUMMARY_MAX_CHARS = 1500;
// Presupuesto de caracteres del lote a compactar. `chat_summary_upto` solo
// avanza hasta el último mensaje que ENTRÓ al presupuesto — nunca se marca
// como compactado algo que no viajó al modelo (antes un slice descartaba el
// excedente pero igual avanzaba el puntero: pérdida permanente de contexto).
const CHAT_CHUNK_MAX_CHARS = 6000;
// Metodología de ventas (rules/13 del monorepo) inyectada SIEMPRE en el prompt,
// para que la IA se base en las reglas/fases reales (no genérico). Cacheada:
// los cambios que haga el PM en rules/13 se reflejan solos en ≤10 min, sin
// reindexar. Acotada en chars para no inflar el prompt del LLM gratuito.
const METHODOLOGY_PATH = 'rules/13-ventas-y-propuestas.md';
const METHODOLOGY_TTL_MS = 10 * 60_000;
// Tope del DIGEST de reglas del BRIEF (etapa 1 — lo que necesita el vendedor).
// El digest enfocado en el brief es ~2.2k chars (~600 tokens); 4000 da margen
// si el PM agrega reglas al brief. Economía de tokens del LLM gratuito: el
// workflow del TL (etapa 2) NO se inyecta acá (este chat es del vendedor).
const METHODOLOGY_MAX_CHARS = 4000;

interface DbOpportunity {
  id: string;
  cliente: string;
  oportunidad: string;
  vendedor_login: string;
  status: string;
  draft: SalesBriefDraft;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

function toOpportunity(row: DbOpportunity): SalesOpportunity {
  return {
    id: row.id,
    cliente: row.cliente,
    oportunidad: row.oportunidad,
    vendedorLogin: row.vendedor_login,
    status: row.status as SalesOpportunity['status'],
    draft: row.draft ?? {},
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class SalesService {
  private readonly logger = new Logger(SalesService.name);
  private readonly writeToken: string | undefined;
  private lastDiscoveryAt = 0;
  private methodologyCache: { ts: number; text: string } | null = null;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gemini: GeminiProvider,
    private readonly rag: SalesRagService,
    private readonly roles: RolesService,
    config: ConfigService,
  ) {
    this.writeToken = process.env.GITHUB_WRITE_TOKEN || config.get<string>('GITHUB_TOKEN');
  }

  async listOpportunities(): Promise<SalesOpportunity[]> {
    // El descubrimiento del monorepo (varias llamadas a GitHub) es best-effort y
    // ACOTADO: NUNCA debe bloquear la carga de la lista más de unos segundos. Si
    // GitHub está lento, la lista igual carga con lo que ya hay en la base — antes
    // esto colgaba el dashboard en skeletons (y React Query reintentaba). El
    // throttle es por instancia (memoria), así que en serverless puede correr en
    // cada arranque en frío; el tope lo mantiene inofensivo.
    await withTimeout(this.discoverOpportunitiesFromMonorepo(), DISCOVERY_DEADLINE_MS).catch(() => undefined);

    const { data, error } = await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw new Error(`No se pudieron listar las oportunidades: ${error.message}`);
    return (data ?? []).map(toOpportunity);
  }

  /** Las oportunidades creadas ANTES de que existiera este módulo (con
   *  `sales:new` local) no tienen fila en Supabase — sin esto, quedarían
   *  invisibles en la plataforma aunque ya existan en el monorepo (ej.
   *  corona/pantalla-interactiva). Escanea `sales/<cliente>/<oportunidad>/`
   *  y crea la fila que falte, leyendo estado/vendedor de su `status.md`
   *  real — NUNCA pisa una fila que ya existe (no queremos clobbear un
   *  draft en progreso). */
  private async discoverOpportunitiesFromMonorepo(): Promise<void> {
    if (Date.now() - this.lastDiscoveryAt < DISCOVERY_TTL_MS) return;
    this.lastDiscoveryAt = Date.now();

    try {
      // Listado PARALELO (antes era en serie → lento y bloqueaba la lista): una
      // sola ola para las subcarpetas de cada cliente.
      const clientes = (await this.listRepoSubdirs('sales')).filter(
        (c) => !NON_OPPORTUNITY_DIRS.has(c) && !c.startsWith('_'),
      );
      const perCliente = await Promise.all(
        clientes.map(async (cliente) => ({ cliente, ops: await this.listRepoSubdirs(`sales/${cliente}`) })),
      );
      const found = perCliente.flatMap(({ cliente, ops }) => ops.map((oportunidad) => ({ cliente, oportunidad })));
      if (!found.length) return;

      const { data: existing } = await this.supabase
        .from(OPPORTUNITIES_TABLE)
        .select('id, cliente, oportunidad, vendedor_login, status');
      const existingSet = new Set((existing ?? []).map((r) => `${r.cliente}/${r.oportunidad}`));
      const missing = found.filter((f) => !existingSet.has(`${f.cliente}/${f.oportunidad}`));

      // Lectura PARALELA de los status.md faltantes + inserción de los que existan.
      const now = new Date().toISOString();
      const rows = (
        await Promise.all(
          missing.map(async (m) => {
            const statusFile = await this.readFileFromRepo(`sales/${m.cliente}/${m.oportunidad}/status.md`).catch(() => null);
            if (!statusFile) return null; // sin status.md → no es una oportunidad real
            return {
              cliente: m.cliente,
              oportunidad: m.oportunidad,
              vendedor_login: statusFile.content.match(/\*\*Owner vendedor:\*\*\s*@?([\w-]+)/)?.[1] ?? 'desconocido',
              status: statusFile.content.match(/\*\*Etapa actual:\*\*\s*(\S+)/)?.[1] ?? 'brief',
              draft: {},
              created_at: now,
              updated_at: now,
            };
          }),
        )
      ).filter(Boolean);
      if (rows.length) await this.supabase.from(OPPORTUNITIES_TABLE).insert(rows);

      // Re-SYNC de status de las filas que YA existen: el TL/PM mueve
      // status.md en el monorepo (propuesta lista, negociación, ganada,
      // congelada, diseño/desarrollo…) y la fila de Supabase quedaba con el
      // estado viejo — el vendedor no se enteraba de que le tocaba continuar.
      // Cada transición detectada actualiza la fila Y crea una notificación
      // con CTA para el vendedor dueño (best-effort si falta la migración 025).
      await Promise.all(
        (existing ?? []).map(async (row) => {
          const statusFile = await this.readFileFromRepo(`sales/${row.cliente}/${row.oportunidad}/status.md`).catch(() => null);
          const fresh = statusFile?.content.match(/\*\*Etapa actual:\*\*\s*(\S+)/)?.[1];
          if (!fresh || fresh === row.status) return;
          await this.supabase
            .from(OPPORTUNITIES_TABLE)
            .update({ status: fresh, updated_at: new Date().toISOString() })
            .eq('id', row.id);
          await this.notifyStatusChange(row, fresh);
        }),
      );
    } catch (err) {
      this.logger.error(`Descubrimiento de oportunidades del monorepo falló: ${(err as Error).message}`);
    }
  }

  /** Crea la notificación de una transición de etapa, con el CTA que lleva al
   *  vendedor DIRECTO a la acción que sigue. Las etapas del pipeline las define
   *  el monorepo (strings abiertos a propósito) — lo no mapeado cae al mensaje
   *  genérico, así etapas nuevas (diseño, desarrollo…) también notifican. */
  private async notifyStatusChange(
    opp: { id: string; cliente: string; oportunidad: string; vendedor_login: string },
    newStatus: string,
  ): Promise<void> {
    const base = `/ventas/${opp.id}`;
    const name = `${opp.cliente}/${opp.oportunidad}`;
    const map: Record<string, { title: string; body: string; ctaLabel: string; ctaPath: string }> = {
      'propuesta-en-armado': {
        title: `El TL está armando la propuesta de ${name}`,
        body: 'Cuando la publique te avisamos por acá.',
        ctaLabel: 'Ver proceso',
        ctaPath: base,
      },
      'propuesta-enviada': {
        title: `El TL terminó la propuesta de ${name}`,
        body: 'Revisa el link y la contraseña, y envíasela al cliente.',
        ctaLabel: 'Abrir propuesta',
        ctaPath: `${base}?tab=propuesta`,
      },
      negociacion: {
        title: `${name} entró en negociación`,
        body: 'Continúa el seguimiento con el cliente desde el chat.',
        ctaLabel: 'Continuar en el chat',
        ctaPath: `${base}?tab=chat`,
      },
      ganada: {
        title: `¡${name} GANADA! 🎉`,
        body: 'Venta cerrada — se dispara el traspaso a QA y Diseño (rules/13).',
        ctaLabel: 'Ver resumen',
        ctaPath: `${base}?tab=resumen`,
      },
      perdida: {
        title: `${name} quedó marcada como perdida`,
        body: 'El histórico queda disponible para el post-mortem.',
        ctaLabel: 'Ver proceso',
        ctaPath: base,
      },
      congelada: {
        title: `${name} se congeló por tiempo`,
        body: 'Decide si retomar el contacto con el cliente o cerrarla.',
        ctaLabel: 'Retomar en el chat',
        ctaPath: `${base}?tab=chat`,
      },
    };
    const n = map[newStatus] ?? {
      title: `${name} pasó a "${newStatus}"`,
      body: 'El proceso avanzó de etapa — continúa desde el detalle.',
      ctaLabel: 'Ver proceso',
      ctaPath: base,
    };
    const { error } = await this.supabase.from(NOTIFICATIONS_TABLE).insert({
      opportunity_id: opp.id,
      vendedor_login: opp.vendedor_login,
      type: `status:${newStatus}`,
      title: n.title,
      body: n.body,
      cta_label: n.ctaLabel,
      cta_path: n.ctaPath,
    });
    // Tabla ausente (migración 025 sin correr) → feature apagada, el re-sync
    // del status igual ya quedó hecho.
    if (error) this.logger.warn(`No se pudo crear la notificación de ${name}: ${error.message}`);
  }

  /** Notificaciones del que consulta (las últimas 30). Fail-soft: sin la
   *  migración 025 devuelve vacío y la campana simplemente no muestra nada.
   *  DISPARA el discovery (throttled 60s + deadline 6s, igual que la lista):
   *  la campana hace polling cada 60s desde cualquier vista, así que las
   *  transiciones del TL se detectan aunque nadie abra la lista de
   *  oportunidades (caso real: el TL terminó y la campana quedó muda 20+ min
   *  porque el vendedor estaba en el Dashboard). */
  async listNotifications(login: string | null): Promise<SalesNotificationsResult> {
    if (!login) return { notifications: [], unseenCount: 0 };
    await withTimeout(this.discoverOpportunitiesFromMonorepo(), DISCOVERY_DEADLINE_MS).catch(() => undefined);
    const { data, error } = await this.supabase
      .from(NOTIFICATIONS_TABLE)
      .select('*')
      .eq('vendedor_login', login)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) return { notifications: [], unseenCount: 0 };
    const notifications = (data ?? []).map((r) => ({
      id: r.id as string,
      opportunityId: r.opportunity_id as string,
      type: r.type as string,
      title: r.title as string,
      body: (r.body as string | null) ?? null,
      ctaLabel: (r.cta_label as string | null) ?? null,
      ctaPath: (r.cta_path as string | null) ?? null,
      seen: !!r.seen,
      createdAt: r.created_at as string,
    }));
    return { notifications, unseenCount: notifications.filter((n) => !n.seen).length };
  }

  /** Marca como vistas las notificaciones del que consulta (todas, o solo ids). */
  async markNotificationsSeen(login: string | null, ids?: string[]): Promise<{ ok: true }> {
    if (!login) return { ok: true };
    let query = this.supabase
      .from(NOTIFICATIONS_TABLE)
      .update({ seen: true })
      .eq('vendedor_login', login)
      .eq('seen', false);
    if (ids?.length) query = query.in('id', ids);
    const { error } = await query;
    if (error) this.logger.warn(`No se pudieron marcar notificaciones vistas: ${error.message}`);
    return { ok: true };
  }

  private async listRepoSubdirs(path: string): Promise<string[]> {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      headers: {
        Authorization: `Bearer ${this.writeToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'qa-portal-sales',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const entries = (await res.json()) as Array<{ name: string; type: 'file' | 'dir' }>;
    return entries.filter((e) => e.type === 'dir').map((e) => e.name);
  }

  async createOpportunity(cliente: string, oportunidad: string, vendedorLogin: string): Promise<SalesOpportunity> {
    // Gate: si esta oportunidad YA existe de verdad en el monorepo (creada
    // antes con sales:new local, o por otro vendedor) pero todavía no la
    // "descubrimos" (ventana de DISCOVERY_TTL_MS, o le falta status.md),
    // NO crear una fila nueva encima — quedaría una fila con draft={} tapando
    // una carpeta real, y el scaffold fallaría en silencio al toparse con
    // archivos que ya existen (GitHub Contents API rechaza el PUT sin sha).
    const existing = await this.readFileFromRepo(`sales/${cliente}/${oportunidad}/status.md`);
    if (existing) {
      throw new BadRequestException(
        `${cliente}/${oportunidad} ya existe en el monorepo — no se puede crear de nuevo. Si no aparece en la lista, esperá un minuto (el descubrimiento tiene un caché corto) o refrescá la página.`,
      );
    }

    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .insert({
        cliente,
        oportunidad,
        vendedor_login: vendedorLogin,
        status: 'brief',
        draft: {},
        created_at: now,
        updated_at: now,
      })
      .select('*')
      .single();
    if (error) throw new BadRequestException(`No se pudo crear la oportunidad (¿ya existe ${cliente}/${oportunidad}?): ${error.message}`);

    // Scaffold de la carpeta completa en el monorepo — el vendedor NUNCA
    // necesita correr `sales:new` a mano (rules/13).
    try {
      await this.scaffoldOpportunityFolder(cliente, oportunidad, vendedorLogin, now.slice(0, 10));
    } catch (err) {
      this.logger.error(`Scaffold de ${cliente}/${oportunidad} falló: ${(err as Error).message}`);
      // No revertimos la fila de Supabase — el vendedor puede reintentar el
      // scaffold vía "Sincronizar brief.md" más adelante; el chat igual funciona.
    }

    return toOpportunity(data as DbOpportunity);
  }

  /** Carga interna COMPLETA (sin lógica de candado) — la usan los métodos que
   *  ya validaron permiso aparte (sendMessage, syncBrief, etc.). NUNCA se
   *  expone al controller directamente: la vista pública pasa por
   *  getOpportunityDetail, que aplica el candado por propiedad. */
  private async loadOpportunity(
    id: string,
  ): Promise<{ opp: SalesOpportunity; messages: SalesMessage[]; chatSummary: string }> {
    const { data: oppRow, error: oppErr } = await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (oppErr) throw new Error(oppErr.message);
    if (!oppRow) throw new NotFoundException('Oportunidad no encontrada.');

    const { data: msgRows, error: msgErr } = await this.supabase
      .from(MESSAGES_TABLE)
      .select('*')
      .eq('opportunity_id', id)
      .order('created_at', { ascending: true });
    if (msgErr) throw new Error(msgErr.message);

    const messages: SalesMessage[] = (msgRows ?? []).map((m) => ({
      id: m.id,
      opportunityId: m.opportunity_id,
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
    }));

    // chat_summary llega vía select('*') solo si la migración 024 ya corrió —
    // antes de eso queda '' y el sistema degrada al fallback de hechos crudos.
    const chatSummary = typeof (oppRow as Record<string, unknown>).chat_summary === 'string'
      ? ((oppRow as Record<string, unknown>).chat_summary as string)
      : '';

    return { opp: toOpportunity(oppRow as DbOpportunity), messages, chatSummary };
  }

  /** ¿Quién es el dueño y qué puede hacer el que consulta? (rules/13: solo el
   *  dueño abre el chat/edita; sin dueño real se puede reclamar). */
  private ownership(vendedorLogin: string, requesterLogin: string | null) {
    const owner = (vendedorLogin ?? '').toLowerCase();
    const me = (requesterLogin ?? '').toLowerCase();
    const unowned = !owner || owner === 'desconocido';
    const isOwner = !!me && me === owner;
    return { unowned, isOwner, locked: !isOwner && !unowned };
  }

  /** Verifica que el que consulta puede EDITAR (chatear/sincronizar/borrar/
   *  regenerar). Falla con un mensaje claro si el proceso es de otro o si no
   *  tiene dueño (hay que reclamarlo primero). */
  private assertCanEdit(opp: SalesOpportunity, requesterLogin: string | null): void {
    const { unowned, isOwner } = this.ownership(opp.vendedorLogin, requesterLogin);
    if (isOwner) return;
    if (unowned) {
      throw new ForbiddenException(
        'Este proceso no tiene un vendedor asignado. Reclámalo primero para poder trabajarlo.',
      );
    }
    throw new ForbiddenException(
      `Este proceso es de @${opp.vendedorLogin}. Pídele que te lo ceda para poder abrirlo.`,
    );
  }

  /** Verifica que el que consulta puede VER datos sensibles del proceso
   *  (link/contraseña de la propuesta, métricas). Permite al dueño y a los
   *  procesos sin dueño; bloquea los ajenos. */
  private assertCanView(opp: SalesOpportunity, requesterLogin: string | null): void {
    const { locked } = this.ownership(opp.vendedorLogin, requesterLogin);
    if (locked) {
      throw new ForbiddenException(`Este proceso es de @${opp.vendedorLogin} — no puedes ver su propuesta.`);
    }
  }

  /** Vista pública: detalle + candado por propiedad. Si está bloqueado (es de
   *  otro vendedor), el historial de mensajes NO viaja — solo se ve el estado
   *  general del proceso, no la conversación privada. */
  async getOpportunityDetail(id: string, requesterLogin: string | null): Promise<SalesOpportunityDetail> {
    const { opp, messages } = await this.loadOpportunity(id);
    const { unowned, isOwner, locked } = this.ownership(opp.vendedorLogin, requesterLogin);
    return {
      ...opp,
      messages: locked ? [] : messages,
      isOwner,
      locked,
      canClaim: unowned,
    };
  }

  /** Reclama un proceso SIN dueño real ('desconocido'/vacío) — el que reclama
   *  se vuelve el vendedor. Deja rastro de sistema en el chat y actualiza el
   *  owner en status.md del monorepo (best-effort). */
  async claimOpportunity(id: string, requesterLogin: string): Promise<SalesOwnershipResult> {
    const { opp } = await this.loadOpportunity(id);
    const { unowned } = this.ownership(opp.vendedorLogin, requesterLogin);
    if (!unowned) {
      throw new ForbiddenException(
        `Este proceso ya es de @${opp.vendedorLogin} — no se puede reclamar. Si necesitas trabajarlo, pídele que te lo ceda.`,
      );
    }
    await this.setOwner(id, opp, requesterLogin, `Proceso reclamado por @${requesterLogin}.`);
    return { vendedorLogin: requesterLogin };
  }

  /** Cede el proceso a otro vendedor: el histórico de la conversación viaja
   *  con él (sigue colgado del mismo opportunity_id). Solo el dueño actual
   *  puede ceder; el destino debe ser un vendedor (lo valida el controller). */
  async transferOpportunity(id: string, requesterLogin: string, toLogin: string): Promise<SalesOwnershipResult> {
    const { opp } = await this.loadOpportunity(id);
    this.assertCanEdit(opp, requesterLogin);
    if (toLogin.toLowerCase() === opp.vendedorLogin.toLowerCase()) {
      throw new BadRequestException('El proceso ya es de ese vendedor.');
    }
    await this.setOwner(id, opp, toLogin, `Proceso cedido de @${opp.vendedorLogin} a @${toLogin}.`);
    return { vendedorLogin: toLogin };
  }

  /** Cambia el dueño (Supabase + status.md del monorepo) y deja una nota de
   *  sistema en el chat. Centraliza claim y transfer. */
  private async setOwner(id: string, opp: SalesOpportunity, newLogin: string, note: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .update({ vendedor_login: newLogin, updated_at: now })
      .eq('id', id);
    if (error) throw new Error(`No se pudo cambiar el dueño del proceso: ${error.message}`);

    await this.supabase.from(MESSAGES_TABLE).insert({
      opportunity_id: id,
      role: 'system',
      content: note,
      created_at: now,
    });

    // status.md del monorepo: mantener el owner sincronizado (best-effort — no
    // rompemos la cesión si el archivo no está o falla la escritura).
    try {
      const statusPath = `sales/${opp.cliente}/${opp.oportunidad}/status.md`;
      const current = await this.readFileFromRepo(statusPath);
      if (current && /\*\*Owner vendedor:\*\*/.test(current.content)) {
        const updated = current.content.replace(
          /\*\*Owner vendedor:\*\*\s*@?[\w-]+/,
          `**Owner vendedor:** @${newLogin}`,
        );
        await this.writeFileToRepo(
          statusPath,
          updated,
          `sales(${opp.cliente}): ${opp.oportunidad} cambia de owner a @${newLogin}`,
          current.sha,
        );
      }
    } catch (err) {
      this.logger.warn(`No se pudo actualizar el owner en status.md de ${opp.cliente}/${opp.oportunidad}: ${(err as Error).message}`);
    }
  }

  async sendMessage(id: string, content: string, requesterLogin: string | null): Promise<SalesSendMessageResult> {
    const { opp, messages, chatSummary } = await this.loadOpportunity(id);
    this.assertCanEdit(opp, requesterLogin);
    const now = new Date().toISOString();

    // 1. Persistir el mensaje del vendedor. Capturamos su id: si el LLM falla o
    //    se pasa del deadline, lo BORRAMOS (abajo) para no dejar un mensaje
    //    huérfano sin respuesta — así "Reintentar" no deja duplicados y la vista
    //    queda consistente con la base (hidratación limpia).
    const { data: vendorRow } = await this.supabase
      .from(MESSAGES_TABLE)
      .insert({ opportunity_id: id, role: 'vendor', content, created_at: now })
      .select('id')
      .single();

    try {
      // 2. RAG: recuperar SOLO los fragmentos relevantes al mensaje actual. Con
      //    deadline corto — si el embedding del RAG se cuelga, NO puede demorar
      //    la respuesta (best-effort → sin contexto, sigue con draft + ventana).
      const [context, methodology, tlOptions] = await Promise.all([
        withTimeout(this.rag.retrieve(content, opp.cliente), RAG_RETRIEVE_DEADLINE_MS).catch(() => [] as string[]),
        this.getMethodologyText().catch(() => ''),
        // TLs reales de team.json (cacheado) — para que "¿a cuál TL?" se
        // responda con datos reales y no con mecanismos inventados.
        this.roles.listTls().catch(() => [] as { login: string; name: string | null }[]),
      ]);

      // 3. Llamar al LLM CON DEADLINE DURO: si tarda más de LLM_DEADLINE_MS,
      //    cortamos con un error accionable en vez de dejar la request colgada
      //    indefinidamente (el usuario veía "Pensando… (200s)" sin fin).
      const history = [...messages, { role: 'vendor' as const, content, id: '', opportunityId: id, createdAt: now }]
        .slice(-HISTORY_WINDOW);
      // Contexto viejo (fuera de la ventana de HISTORY_WINDOW):
      // 1. Si ya hay RESUMEN COMPACTADO (auto-compact tipo Claude Code, se
      //    genera en el post-turno), va ese — cubre toda la conversación vieja
      //    en ~1500 chars.
      // 2. Fallback (sin resumen todavía, o migración 024 sin correr): los
      //    mensajes VIEJOS del vendedor crudos (ahí viven los hechos; acotado)
      //    para que re-extraiga sin hacer repetir a nadie.
      const olderVendorNotes = chatSummary.trim()
        ? ''
        : messages
            .slice(0, Math.max(0, messages.length - (HISTORY_WINDOW - 1)))
            .filter((m) => m.role === 'vendor')
            .map((m) => m.content)
            .join('\n---\n')
            .slice(0, 2500);
      const prompt = buildBriefPrompt(opp.draft, history, context, methodology, opp.status, olderVendorNotes, chatSummary, tlOptions);

      const raw = await withTimeout(
        this.gemini.generateRaw({
          prompt,
          // 0.45 (no 0.3): con temperatura muy baja los modelos gratis calcaban
          // la MISMA frase plantilla turno tras turno (caso real). Sigue siendo
          // conservador para la extracción del draft.
          temperature: 0.45,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          // Chat interactivo, TODO gratis: Groq PRIMERO (rápido/estable), y de
          // respaldo gemini-2.5-flash → gemini-2.0-flash → OpenRouter. Timeout
          // por intento de 10s para no colgarse. Groq responde en ~100-400ms.
          cascade: { preferGroq: true, attemptTimeoutMs: 10_000, primaryAttempts: 1, useProFallback: true },
        }),
        LLM_DEADLINE_MS,
        'El asistente tardó demasiado en responder (el modelo gratuito puede estar saturado). Volvé a intentar en un momento.',
      );

      const parsed = parseAssistantResponse(raw);
      // Fusión defensiva: lo ya registrado NUNCA se pierde aunque el modelo
      // devuelva un draft parcial (causa raíz de re-preguntar el presupuesto).
      const mergedDraft = mergeDrafts(opp.draft, parsed.draft);
      // ASUNCIONES las escribe el SERVIDOR — es la única sección con shape
      // anidado ({texto, impactoSiFalla}) y los modelos gratis NO logran
      // emitirla: decían "Registrado ✓" en el reply pero el draft llegaba sin
      // ella → el brief quedaba clavado en 8/9 con el vendedor pidiendo
      // continuar en bucle (caso real, 3 rondas de capturas).
      if (!(mergedDraft.asunciones ?? []).length) {
        // Caso 1: "no hay asunciones/suposiciones" explícito.
        if (/(no (hay|tengo|tenemos)( m[áa]s)?|sin|ninguna)\s*(suposici|asunci)/i.test(content)) {
          mergedDraft.asunciones = [{ texto: 'Sin asunciones relevantes (confirmado por el vendedor)', impactoSiFalla: 'N/A' }];
        } else {
          // Caso 2: asunciones es LO ÚNICO que falta y el vendedor confirma o
          // pide continuar/cerrar → registrar con sus propias palabras si
          // traen contenido; si es un "sí, continúa" pelado, el placeholder.
          const restoLleno = DRAFT_TEXT_KEYS.every((k) => (fieldToText(mergedDraft[k]) ?? '').trim().length > 0);
          const affirms =
            /^(s[ií]\b|dale|ok\b|listo|claro|de acuerdo|correcto|confirmo|perfecto)/i.test(content.trim()) ||
            /(contin[uú]a|cierra|cerrar|avancemos|pasemos|adelante|siguiente (paso|etapa|fase))/i.test(content);
          if (restoLleno && affirms) {
            const stripped = content.trim().replace(/^(s[ií][,.\s]*|dale[,.\s]*|ok[,.\s]*|claro[,.\s]*|perfecto[,.\s]*)/i, '').trim();
            mergedDraft.asunciones = [
              stripped.length >= 25
                ? { texto: stripped, impactoSiFalla: 'Por validar con el cliente' }
                : { texto: 'Sin asunciones adicionales (el vendedor confirmó cerrar el brief)', impactoSiFalla: 'N/A' },
            ];
          }
        }
      }

      // 4. Persistir la respuesta + draft actualizado.
      const nowReply = new Date().toISOString();
      await this.supabase.from(MESSAGES_TABLE).insert({
        opportunity_id: id,
        role: 'assistant',
        content: parsed.reply,
        created_at: nowReply,
      });
      await this.supabase
        .from(OPPORTUNITIES_TABLE)
        .update({ draft: mergedDraft, updated_at: nowReply })
        .eq('id', id);

      // 5. Post-turno (indexar RAG + auto-sync de brief.md) FUERA del camino de
      //    respuesta: no demora ni un segundo la respuesta al vendedor. Best-
      //    effort (en serverless puede no completar; el brief igual se sincroniza
      //    con "Sincronizar"/handoff, y el RAG se reindexa después).
      const result = { reply: parsed.reply, draft: mergedDraft };
      void this.afterTurn(id, opp, content, result).catch((err) =>
        this.logger.warn(`Post-turno de ${opp.cliente}/${opp.oportunidad} degradó: ${(err as Error).message}`),
      );

      return result;
    } catch (err) {
      // El turno no produjo respuesta → limpiamos el mensaje del vendedor para
      // que la conversación no quede con un mensaje colgado (el contenido no se
      // pierde: el frontend lo guarda para "Reintentar").
      if (vendorRow?.id) {
        await this.supabase.from(MESSAGES_TABLE).delete().eq('id', vendorRow.id).then(
          () => undefined,
          () => undefined,
        );
      }
      if (err instanceof HttpException) throw err;
      // Un Error genérico (timeout del LLM, respuesta con shape inválido, red)
      // se volvía un 500 "Internal server error" opaco — el vendedor nunca veía
      // el mensaje útil. 503 con el detalle real + acción clara.
      this.logger.error(`sendMessage(${id}) falló: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        `El asistente no pudo responder en este intento (${(err as Error).message.slice(0, 140)}). Vuelve a intentar — tu mensaje no se perdió.`,
      );
    }
  }

  /** Tareas post-turno: (a) indexar el turno nuevo en la memoria RAG del
   *  proceso (incremental, 1 sola llamada de embeddings); (b) mantener el
   *  monorepo al día auto-sincronizando brief.md. Cada una es best-effort:
   *  su fallo se loguea pero no rompe el chat ni frena a la otra. */
  private async afterTurn(
    id: string,
    opp: SalesOpportunity,
    vendorContent: string,
    parsed: SalesSendMessageResult,
  ): Promise<void> {
    await this.rag
      .indexTurn({ ...opp, draft: parsed.draft }, vendorContent, parsed.reply)
      .catch((err) => this.logger.warn(`RAG indexTurn de ${opp.cliente}/${opp.oportunidad} degradó: ${(err as Error).message}`));

    // Auto-compact del chat (tipo Claude Code) — fuera del camino de respuesta.
    await this.maybeCompactChat(id).catch((err) =>
      this.logger.warn(`Auto-compact del chat de ${opp.cliente}/${opp.oportunidad} degradó: ${(err as Error).message}`),
    );

    // Auto-sync del monorepo por CHECKPOINT: brief.md se mantiene al día, pero
    // sin un commit por turno. Solo sincroniza si nunca se sincronizó o si pasó
    // el debounce desde la última vez (una ráfaga de mensajes colapsa en ~1
    // commit por ventana). El botón "Sincronizar" y el handoff fuerzan aparte.
    // No pisamos con un draft vacío (mismo guardado que syncBrief).
    if (!isDraftEmpty(parsed.draft) && this.autoSyncDue(opp.syncedAt)) {
      try {
        const path = `sales/${opp.cliente}/${opp.oportunidad}/brief.md`;
        await this.writeFileToRepo(
          path,
          renderBriefMd(parsed.draft),
          `sales(${opp.cliente}): auto-sync brief de ${opp.oportunidad} desde el chat [skip ci]`,
        );
        await this.supabase
          .from(OPPORTUNITIES_TABLE)
          .update({ synced_at: new Date().toISOString() })
          .eq('id', id);
      } catch (err) {
        this.logger.warn(`Auto-sync de brief.md de ${opp.cliente}/${opp.oportunidad} degradó: ${(err as Error).message}`);
      }
    }
  }

  /** ¿Toca auto-sincronizar? Sí si nunca se sincronizó o si pasó el debounce
   *  desde la última sincronización (manual o automática). */
  private autoSyncDue(syncedAt: string | null): boolean {
    if (!syncedAt) return true;
    return Date.now() - new Date(syncedAt).getTime() >= AUTOSYNC_DEBOUNCE_MS;
  }

  /** Auto-compact del chat (tipo Claude Code): fusiona los mensajes que ya
   *  quedaron fuera de la ventana de HISTORY_WINDOW con el resumen anterior en
   *  UN bloque compacto (hechos del cliente, decisiones, pendientes) que viaja
   *  en cada prompt. Incremental (chat_summary_upto marca hasta dónde se
   *  compactó) y en lote (recompacta cada CHAT_SUMMARY_BATCH mensajes nuevos
   *  fuera de ventana) — 1 llamada barata al modelo rápido cada ~6 mensajes.
   *  Best-effort: si la migración 024 no corrió o el LLM falla, no pasa nada. */
  private async maybeCompactChat(id: string): Promise<void> {
    const { data: row, error: rowErr } = await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .select('chat_summary, chat_summary_upto')
      .eq('id', id)
      .maybeSingle();
    if (rowErr || !row) return; // columna ausente (sin migración 024) → feature apagada

    const { data: msgs } = await this.supabase
      .from(MESSAGES_TABLE)
      .select('role, content')
      .eq('opportunity_id', id)
      .order('created_at', { ascending: true });
    const total = msgs?.length ?? 0;
    const cutoff = total - HISTORY_WINDOW; // mensajes que YA no ve el modelo
    const upto = (row.chat_summary_upto as number | null) ?? 0;
    if (cutoff - upto < CHAT_SUMMARY_BATCH) return; // aún no toca recompactar

    // Lote acotado por caracteres SIN descartar mensajes: si el presupuesto se
    // llena, el resto queda para la próxima compactación (upto avanza solo
    // hasta `consumed`). Un mensaje individual más largo que el presupuesto se
    // recorta (entra truncado, pero entra) para que el puntero nunca se trabe.
    const lines: string[] = [];
    let consumed = upto;
    let chars = 0;
    for (const m of (msgs ?? []).slice(upto, cutoff)) {
      const line = m.role === 'system' ? '' : `${m.role === 'vendor' ? 'VENDEDOR' : 'ASISTENTE'}: ${m.content}`;
      if (line && chars + line.length > CHAT_CHUNK_MAX_CHARS && chars > 0) break;
      if (line) {
        lines.push(line.slice(0, CHAT_CHUNK_MAX_CHARS));
        chars += line.length;
      }
      consumed++;
    }
    const chunk = lines.join('\n');
    if (!chunk.trim()) {
      // Tramo de puros mensajes `system` (cesiones/reclamos): no hay nada que
      // resumir, pero el puntero avanza igual — si no, quedaría trabado acá.
      if (consumed > upto) {
        await this.supabase.from(OPPORTUNITIES_TABLE).update({ chat_summary_upto: consumed }).eq('id', id);
      }
      return;
    }

    const raw = await this.gemini.generateRaw({
      prompt: buildCompactPrompt((row.chat_summary as string | null) ?? '', chunk),
      temperature: 0.2,
      maxOutputTokens: 700,
      cascade: { preferGroq: true, attemptTimeoutMs: 10_000, primaryAttempts: 1, useProFallback: false },
    });
    // Si el modelo se pasó del tope, cortar en el último salto de línea (el
    // resumen es en viñetas) — un corte a mitad de frase deja un hecho roto.
    const trimmed = raw.trim();
    const lastBreak = trimmed.lastIndexOf('\n', CHAT_SUMMARY_MAX_CHARS);
    const summary =
      trimmed.length <= CHAT_SUMMARY_MAX_CHARS
        ? trimmed
        : trimmed.slice(0, lastBreak > 0 ? lastBreak : CHAT_SUMMARY_MAX_CHARS);
    if (!summary) return;

    await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .update({ chat_summary: summary, chat_summary_upto: consumed })
      .eq('id', id);
    this.logger.log(`Chat de ${id} compactado hasta el mensaje ${consumed}/${total}.`);
  }

  /** Metodología de ventas (rules/13) del monorepo, acotada y cacheada. Se
   *  inyecta SIEMPRE en el prompt para que la IA respete las reglas/fases
   *  reales que define el PM. Best-effort: si no se puede leer, el chat sigue
   *  sin ella (devuelve ''). Los cambios en rules/13 se ven en ≤10 min (TTL). */
  private async getMethodologyText(): Promise<string> {
    if (this.methodologyCache && Date.now() - this.methodologyCache.ts < METHODOLOGY_TTL_MS) {
      return this.methodologyCache.text;
    }
    const file = await this.readFileFromRepo(METHODOLOGY_PATH).catch(() => null);
    const text = file ? distillMethodology(file.content) : '';
    this.methodologyCache = { ts: Date.now(), text };
    return text;
  }

  async syncBrief(id: string, requesterLogin: string | null): Promise<SalesSyncResult> {
    const { opp } = await this.loadOpportunity(id);
    this.assertCanEdit(opp, requesterLogin);

    // Gate de seguridad — caso real que pasó: una oportunidad DESCUBIERTA del
    // monorepo (nunca se chateó en la plataforma) tiene draft={} por defecto.
    // Sincronizar eso pisó un brief.md real con contenido genuino del
    // cliente (corona/pantalla-interactiva) con la plantilla vacía. Si el
    // draft está completamente vacío, no hay nada nuevo que aportar — negarse
    // en vez de arriesgar sobrescribir contenido real que ya existía.
    if (isDraftEmpty(opp.draft)) {
      throw new BadRequestException(
        'El draft está vacío — no hay nada que sincronizar. Si el brief.md ya tiene contenido (de antes de usar la plataforma), completá el draft chateando acá antes de sincronizar, para no arriesgarte a perder lo que ya existe.',
      );
    }

    const briefMd = renderBriefMd(opp.draft);
    const path = `sales/${opp.cliente}/${opp.oportunidad}/brief.md`;
    await this.writeFileToRepo(path, briefMd, `sales(${opp.cliente}): actualiza brief de ${opp.oportunidad} desde la plataforma`);

    const syncedAt = new Date().toISOString();
    await this.supabase.from(OPPORTUNITIES_TABLE).update({ synced_at: syncedAt, updated_at: syncedAt }).eq('id', id);

    return { url: `https://github.com/${OWNER}/${REPO}/blob/main/${path}`, syncedAt };
  }

  async handoff(id: string, requesterLogin: string | null, tlLogin?: string): Promise<SalesSyncResult> {
    // rules/13 §Cerrar el brief: al pasar a propuesta-en-armado, EL VENDEDOR
    // asigna el Owner TL en status.md. Validamos contra los TL reales de
    // team.json — no se puede asignar a alguien que no es TL.
    if (tlLogin) {
      const tls = await this.roles.listTls().catch(() => [] as { login: string; name: string | null }[]);
      if (!tls.some((t) => t.login.toLowerCase() === tlLogin.toLowerCase())) {
        throw new BadRequestException(`@${tlLogin} no es un TL activo de team.json — elige uno de la lista.`);
      }
    }

    const result = await this.syncBrief(id, requesterLogin); // ya verifica dueño
    const { opp } = await this.loadOpportunity(id);

    // Errores del monorepo con mensaje REAL: sin esto un Error genérico se
    // volvía "Internal server error" opaco en el botón (caso real).
    try {
      const statusPath = `sales/${opp.cliente}/${opp.oportunidad}/status.md`;
      const current = await this.readFileFromRepo(statusPath);
      if (current) {
        let updated = current.content.replace(
          /\*\*Etapa actual:\*\*\s*\S+/,
          '**Etapa actual:** propuesta-en-armado',
        );
        if (tlLogin) {
          updated = /\*\*Owner TL:\*\*/.test(updated)
            ? updated.replace(/\*\*Owner TL:\*\*.*/, `**Owner TL:** @${tlLogin}`)
            : updated.replace(/(\*\*Owner vendedor:\*\*.*)/, `$1\n**Owner TL:** @${tlLogin}`);
        }
        // Contrato de status.md (rules/13): toda transición = línea Etapa
        // actual + fila en la bitácora, SIEMPRE juntas. Antes solo cambiábamos
        // la línea — el mismo pecado (en espejo) que dejó muda una notificación
        // cuando el TL solo escribió la bitácora.
        const hoy = new Date().toISOString().slice(0, 10);
        const fila = `| ${hoy} | propuesta-en-armado | @${requesterLogin ?? 'plataforma'} | Handoff desde la plataforma QA${tlLogin ? ` — Owner TL @${tlLogin}` : ''}. |`;
        updated = updated.replace(/(\n\|[^\n]*\|)(?![\s\S]*\n\|)/, `$1\n${fila}`);
        await this.writeFileToRepo(
          statusPath,
          updated,
          `sales(${opp.cliente}): ${opp.oportunidad} pasa a propuesta-en-armado${tlLogin ? ` (Owner TL @${tlLogin})` : ''}`,
          current.sha,
        );
      }
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`handoff(${id}) falló escribiendo status.md: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        `El brief se sincronizó pero no se pudo actualizar status.md (${(err as Error).message.slice(0, 120)}). Reintenta "Pasar a TL" en un momento.`,
      );
    }

    await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .update({ status: 'propuesta-en-armado', updated_at: new Date().toISOString() })
      .eq('id', id);

    return result;
  }

  /** Acceso a la propuesta ya generada (link + contraseña), si existe.
   *  `access.json` lo crea `proposal:password`/`proposal:deploy` (rules/13).
   *
   *  Caso real encontrado (corona/pantalla-interactiva): el deploy existe y
   *  está en vivo, pero `access.json` nunca se commiteó al monorepo — el
   *  manifest de contraseñas de `proposal:deploy` quedó sin esa entrada, y
   *  el worker cae a su fallback público (rules/13 exige contraseña
   *  SIEMPRE — esto es un hueco real de seguridad, no solo cosmético). Por
   *  eso, si no hay `access.json`, chequeamos en vivo si la URL sirve
   *  contenido real (no el placeholder genérico de Cloudflare Pages) para
   *  poder avisar del hueco en vez de decir "no generada" sin más. */
  async getProposalAccess(id: string, requesterLogin: string | null): Promise<SalesProposalAccess> {
    const { opp } = await this.loadOpportunity(id);
    this.assertCanView(opp, requesterLogin); // la contraseña es sensible → no a procesos ajenos
    const url = `https://qa-proposals.pages.dev/${opp.cliente}/${opp.oportunidad}/`;
    const accessPath = `sales/${opp.cliente}/${opp.oportunidad}/access.json`;
    const file = await this.readFileFromRepo(accessPath);

    if (file) {
      try {
        const parsed = JSON.parse(file.content) as { password?: string; createdAt?: string; createdBy?: string | null };
        if (parsed.password) {
          return { generated: true, url, password: parsed.password, createdAt: parsed.createdAt, createdBy: parsed.createdBy ?? null };
        }
      } catch { /* JSON corrupto — cae al chequeo en vivo de abajo */ }
    }

    const isLive = await this.isProposalLive(url);
    return isLive ? { generated: true, url, password: null } : { generated: false };
  }

  /** ¿La URL sirve contenido real de propuesta, o el fallback genérico de
   *  Cloudflare Pages ("imaginamos.co" a secas) para una ruta sin build? */
  private async isProposalLive(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return false;
      const text = await res.text();
      return !text.includes('imaginamos.co</body>') && !text.includes('<title>Imaginamos</title>');
    } catch {
      return false;
    }
  }

  /** Total de aperturas + última fecha (sales_proposal_views, alimentada
   *  por el worker de qa-proposals vía POST /ingest/proposal-view). */
  async getProposalMetrics(id: string, requesterLogin: string | null): Promise<SalesProposalMetrics> {
    const { opp } = await this.loadOpportunity(id);
    this.assertCanView(opp, requesterLogin);
    const { data, error } = await this.supabase
      .from('sales_proposal_views')
      .select('viewed_at')
      .eq('cliente', opp.cliente)
      .eq('oportunidad', opp.oportunidad)
      .order('viewed_at', { ascending: false });
    if (error) throw new Error(error.message);

    return {
      totalViews: data?.length ?? 0,
      lastViewedAt: data?.[0]?.viewed_at ?? null,
    };
  }

  /** Dispara `proposal-deploy.yml` en el monorepo — regenera la contraseña
   *  (invalida la anterior) y vuelve a publicar en Cloudflare Pages. Es
   *  ASÍNCRONO: no devuelve la contraseña nueva al toque, tarda ~1-2 min en
   *  CI. El frontend re-consulta `getProposalAccess` hasta verla cambiar.
   *
   *  Gate de concurrencia: si el vendedor recarga la página y vuelve a
   *  apretar "Regenerar" mientras el primer dispatch todavía está corriendo
   *  en CI, dos regeneraciones en carrera podrían invalidar una contraseña
   *  que el vendedor ya compartió con el cliente. Se rechaza un segundo
   *  dispatch dentro de la ventana de cooldown. */
  async regenerateProposalPassword(id: string, requesterLogin: string | null): Promise<SalesRegenerateProposalResult> {
    const { opp } = await this.loadOpportunity(id);
    this.assertCanEdit(opp, requesterLogin);
    if (!this.writeToken) throw new Error('GITHUB_WRITE_TOKEN no configurado en el servidor.');

    const { data: row } = await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .select('password_regenerate_requested_at')
      .eq('id', id)
      .maybeSingle();
    const requestedAt = row?.password_regenerate_requested_at as string | null | undefined;
    if (requestedAt && Date.now() - new Date(requestedAt).getTime() < REGENERATE_COOLDOWN_MS) {
      throw new BadRequestException(
        'Ya hay una regeneración en curso para esta propuesta — esperá un par de minutos antes de volver a intentar, para no invalidar una contraseña que todavía está terminando de publicarse.',
      );
    }

    const res = await fetch(
      `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/proposal-deploy.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.writeToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'qa-portal-sales',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { cliente: opp.cliente, oportunidad: opp.oportunidad, regenerate: 'true' },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.status !== 204) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `GitHub Actions rechazó el dispatch (HTTP ${res.status}): ${text.slice(0, 300)}. ` +
          'Verificá que existe .github/workflows/proposal-deploy.yml en main y que GITHUB_WRITE_TOKEN tiene scope Actions:write.',
      );
    }

    await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .update({ password_regenerate_requested_at: new Date().toISOString() })
      .eq('id', id);

    return { dispatched: true };
  }

  // ─── GitHub Contents API — helpers de lectura/escritura ──────────────────

  private async readFileFromRepo(path: string): Promise<{ content: string; sha: string } | null> {
    if (!this.writeToken) throw new Error('GITHUB_WRITE_TOKEN no configurado en el servidor.');
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      headers: {
        Authorization: `Bearer ${this.writeToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'qa-portal-sales',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub contents GET ${path} → HTTP ${res.status}`);
    const json = (await res.json()) as { content: string; sha: string; encoding: string };
    const content = Buffer.from(json.content, json.encoding as BufferEncoding).toString('utf8');
    return { content, sha: json.sha };
  }

  /** Crea/actualiza un archivo de texto en el monorepo vía Contents API.
   *  Si no se pasa `sha`, lo busca (GET); 404 → archivo nuevo, sin sha.
   *  Con REINTENTO en 409/422: el afterTurn (auto-sync de brief.md) commitea
   *  en segundo plano y deja el sha viejo justo cuando el vendedor toca
   *  "Sincronizar"/"Pasar a TL" — se relee el sha fresco y se reintenta
   *  (caso real: el handoff moría con "Internal server error"). */
  private async writeFileToRepo(path: string, content: string, message: string, sha?: string): Promise<void> {
    if (!this.writeToken) throw new Error('GITHUB_WRITE_TOKEN no configurado en el servidor.');
    let resolvedSha = sha;
    if (resolvedSha === undefined) {
      const existing = await this.readFileFromRepo(path);
      resolvedSha = existing?.sha;
    }

    const attempt = async (useSha?: string): Promise<Response> =>
      fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.writeToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'qa-portal-sales',
        },
        body: JSON.stringify({
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
          branch: 'main',
          ...(useSha ? { sha: useSha } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });

    let res = await attempt(resolvedSha);
    if (res.status === 409 || res.status === 422) {
      const fresh = await this.readFileFromRepo(path).catch(() => null);
      res = await attempt(fresh?.sha);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `GitHub contents PUT ${path} → HTTP ${res.status}: ${text.slice(0, 300)}. ` +
          'Verificá que GITHUB_WRITE_TOKEN tenga el permiso "Contents: Read and write" sobre el repo.',
      );
    }
  }

  /** Replica `scripts/sales-new.mjs`: copia sales/templates/* al monorepo con
   *  sustitución de placeholders, vía Contents API en vez de fs local. */
  private async scaffoldOpportunityFolder(
    cliente: string,
    oportunidad: string,
    vendedorLogin: string,
    today: string,
  ): Promise<void> {
    // status.md NO vive en sales/templates/ — lo genera `sales:new` aparte
    // (rules/13). La plataforma tenía ese mismo hueco: sus oportunidades
    // quedaban SIN status.md → handoff lo saltaba en silencio y el discovery/
    // notificaciones quedaban ciegos a ellas. Se escribe PRIMERO y con el
    // mismo formato que scripts/sales-new.mjs del monorepo.
    await this.writeFileToRepo(
      `sales/${cliente}/${oportunidad}/status.md`,
      `# Estado — ${cliente} · ${oportunidad}

- **Etapa actual:** brief
- **Cliente:** ${cliente}
- **Oportunidad:** ${oportunidad}
- **Owner vendedor:** @${vendedorLogin}
- **Owner TL:** _(asignar al pasar a propuesta-en-armado)_
- **Última actualización:** ${today}

## Bitácora de estados

Append-only. Cada transición se anota con fecha + responsable.

| Fecha | Estado nuevo | Responsable | Notas |
|---|---|---|---|
| ${today} | brief | @${vendedorLogin} | Oportunidad creada desde la plataforma QA. |
`,
      `sales(${cliente}): status.md inicial de ${oportunidad}`,
    );

    const templateFiles = await this.listRepoDir('sales/templates', true);
    // LECTURAS de templates en paralelo (no commitean — sin carrera), pero
    // ESCRITURAS SECUENCIALES: cada PUT de la Contents API es un commit que
    // mueve el head de la rama — en paralelo chocan los SHAs (409/422) y el
    // scaffold quedaba PARCIAL (caso real: carpetas con 1 de ~11 archivos).
    // La función tiene maxDuration=60s (vercel.json) — la secuencia (~10-15s)
    // entra sobrada.
    const prepared = await Promise.all(
      templateFiles.map(async ({ path: file }) => {
        const existing = await this.readFileFromRepoRaw(file);
        const destPath = file.replace(/^sales\/templates\//, `sales/${cliente}/${oportunidad}/`);
        const substituted = existing.isText
          ? substitutePlaceholders(existing.text!, { cliente, oportunidad, vendedorLogin, today })
          : null;
        return { destPath, existing, substituted };
      }),
    );
    for (const { destPath, existing, substituted } of prepared) {
      try {
        await this.writeBinaryOrTextToRepo(destPath, existing, substituted);
      } catch {
        // Un reintento: pudo chocar con un commit concurrente de otro flujo.
        await this.writeBinaryOrTextToRepo(destPath, existing, substituted);
      }
    }
  }

  /** Borra la oportunidad de forma completa: los archivos reales en el
   *  monorepo (sales/<cliente>/<oportunidad>/**) Y la fila de Supabase (los
   *  mensajes caen solos por ON DELETE CASCADE). No es "ocultar de la lista"
   *  — es sacarla del pipeline de verdad, como pidió el vendedor. */
  async deleteOpportunity(id: string, requesterLogin: string | null): Promise<{ deleted: true; filesDeleted: number }> {
    const { opp } = await this.loadOpportunity(id);
    this.assertCanEdit(opp, requesterLogin);
    const basePath = `sales/${opp.cliente}/${opp.oportunidad}`;

    const files = await this.listRepoDir(basePath, true);
    // SECUENCIAL a propósito: cada DELETE de la Contents API es un commit que
    // mueve el head de la rama — en paralelo (Promise.all) chocan los SHAs y
    // GitHub devuelve 409/422 intermitente cuando la carpeta tiene varios
    // archivos (caso real: la limpieza fallaba con 500 y dejaba restos).
    // Y con REINTENTO por archivo: el afterTurn (auto-sync de brief.md) puede
    // estar commiteando EN PARALELO al borrado (es fire-and-forget) — si el
    // SHA quedó viejo (409/422) se relee y se reintenta; 404 = ya no existe.
    const message = `sales(${opp.cliente}): elimina ${opp.oportunidad} del pipeline`;
    for (const { path, sha } of files) {
      try {
        await this.deleteFileFromRepo(path, sha, message);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('HTTP 404')) continue; // otro proceso ya lo borró
        const fresh = await this.readFileFromRepo(path).catch(() => null);
        if (!fresh) continue; // ya no existe → objetivo cumplido
        await this.deleteFileFromRepo(path, fresh.sha, message);
      }
    }

    const { error } = await this.supabase.from(OPPORTUNITIES_TABLE).delete().eq('id', id);
    if (error) throw new Error(`Se borraron los archivos del monorepo pero no la fila de Supabase: ${error.message}`);

    // La memoria RAG de este proceso ya no aplica → la sacamos.
    await this.rag.forgetOpportunity(id).catch(() => undefined);

    return { deleted: true, filesDeleted: files.length };
  }

  /** Reconstruye la base de conocimiento del RAG: metodología (rules/13 +
   *  plantilla) + los negocios GANADOS (brief + propuestas.yml) como ejemplos.
   *  Idempotente — se puede re-correr sin duplicar. Lo dispara un vendedor
   *  desde el módulo cuando quiere refrescar los ejemplos/metodología. */
  async reindexKnowledge(): Promise<{ methodology: number; wonDeals: number }> {
    const meth = await this.rag.indexMethodology();

    const { data } = await this.supabase.from(OPPORTUNITIES_TABLE).select('*');
    const ganadas = (data ?? [])
      .map((r) => toOpportunity(r as DbOpportunity))
      .filter((o) => o.status.toLowerCase() === 'ganada');

    let wonDeals = 0;
    for (const opp of ganadas) {
      const base = `sales/${opp.cliente}/${opp.oportunidad}`;
      const brief = await this.readFileFromRepo(`${base}/brief.md`).catch(() => null);
      const propuestas = await this.readFileFromRepo(`${base}/propuestas.yml`).catch(() => null);
      if (!brief && !propuestas) continue;
      await this.rag.indexWonDeal(opp, brief?.content ?? '', propuestas?.content ?? null);
      wonDeals++;
    }
    return { methodology: meth.indexed, wonDeals };
  }

  private async listRepoDir(path: string, recursive: boolean): Promise<{ path: string; sha: string }[]> {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      headers: {
        Authorization: `Bearer ${this.writeToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'qa-portal-sales',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitHub contents GET (dir) ${path} → HTTP ${res.status}`);
    const entries = (await res.json()) as Array<{ path: string; sha: string; type: 'file' | 'dir' }>;
    const files: { path: string; sha: string }[] = [];
    for (const e of entries) {
      if (e.type === 'file') files.push({ path: e.path, sha: e.sha });
      else if (e.type === 'dir' && recursive) files.push(...(await this.listRepoDir(e.path, true)));
    }
    return files;
  }

  /** Borra un archivo del monorepo vía Contents API (necesita su sha actual). */
  private async deleteFileFromRepo(path: string, sha: string, message: string): Promise<void> {
    if (!this.writeToken) throw new Error('GITHUB_WRITE_TOKEN no configurado en el servidor.');
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.writeToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'qa-portal-sales',
      },
      body: JSON.stringify({ message, sha, branch: 'main' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub contents DELETE ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  private async readFileFromRepoRaw(path: string): Promise<{ isText: boolean; text?: string; base64: string }> {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      headers: {
        Authorization: `Bearer ${this.writeToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'qa-portal-sales',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub contents GET ${path} → HTTP ${res.status}`);
    const json = (await res.json()) as { content: string; encoding: string };
    const isText = /\.(md|yml|yaml|html|txt|json)$/i.test(path);
    return {
      isText,
      text: isText ? Buffer.from(json.content, json.encoding as BufferEncoding).toString('utf8') : undefined,
      base64: json.content,
    };
  }

  private async writeBinaryOrTextToRepo(
    path: string,
    original: { isText: boolean; base64: string },
    substitutedText: string | null,
  ): Promise<void> {
    const content = substitutedText !== null
      ? Buffer.from(substitutedText, 'utf8').toString('base64')
      : original.base64;
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.writeToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'qa-portal-sales',
      },
      body: JSON.stringify({
        message: `sales: scaffold ${path}`,
        content,
        branch: 'main',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub contents PUT ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
  }
}

/** Corre una promesa con deadline: si no resuelve en `ms`, rechaza con
 *  `message`. La promesa perdedora sigue en segundo plano pero se ignora
 *  (Promise.race maneja ambas → sin unhandledRejection). Clave para que la
 *  respuesta del chat NUNCA se cuelgue indefinidamente. */
/** Extrae un DIGEST de reglas de rules/13: encabezados, fases numeradas y toda
 *  línea que sea una regla dura (❌/✅/NUNCA/SIEMPRE) o hable de precios/costos —
 *  sin importar EN QUÉ PARTE del doc estén. Reemplaza al corte posicional viejo
 *  (que dejaba afuera la parte de precios). Basado en patrones → se adapta si
 *  el PM reordena/edita rules/13, y garantiza que reglas críticas como "NUNCA
 *  inventar valores" y "los precios se calculan en la propuesta" SIEMPRE lleguen
 *  al prompt. */
function distillMethodology(md: string): string {
  // Este chat es la herramienta del VENDEDOR (etapa 1 — brief). Cortamos antes
  // del workflow del TL (etapa 2 — propuestas/estimación/precios): el vendedor
  // no lo necesita y ahorra ~70% de tokens del LLM gratuito. La regla dura de
  // "no inventar precios" ya está fija en el prompt, así que el corte no la pierde.
  const lines = md.split('\n');
  const tlIdx = lines.findIndex((l) => /Workflow del TL|etapa 2/i.test(l));
  const scoped = tlIdx > 0 ? lines.slice(0, tlIdx) : lines;
  const keepRe = /^#{1,4}\s|❌|✅|\bNUNCA\b|\bSIEMPRE\b|precio|costo|presupuesto|tarifa|estimaci|se calcula|^\s*\d+\.\s+\*\*/i;
  const kept = scoped.filter((line) => keepRe.test(line)).map((line) => line.trimEnd());
  const digest = kept.join('\n');
  return digest.length > METHODOLOGY_MAX_CHARS ? digest.slice(0, METHODOLOGY_MAX_CHARS) : digest;
}

function withTimeout<T>(p: Promise<T>, ms: number, message = 'La operación tardó demasiado.'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // clearTimeout al resolver/rechazar: sin esto, el setTimeout pendiente mantiene
  // vivo el event loop de la función serverless y retrasa el envío de la respuesta.
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ─── Placeholders — mismo orden/criterio que scripts/sales-new.mjs ─────────
// ORDEN IMPORTA: _EMAIL_VENDEDOR_ contiene _VENDEDOR_ como substring.
function substitutePlaceholders(
  text: string,
  vars: { cliente: string; oportunidad: string; vendedorLogin: string; today: string },
): string {
  return text
    .replaceAll('_EMAIL_VENDEDOR_', `${vars.vendedorLogin}@imaginamos.co`)
    .replaceAll('_VENDEDOR_', `@${vars.vendedorLogin}`)
    .replaceAll('_CLIENTE_', vars.cliente)
    .replaceAll('_OPORTUNIDAD_', vars.oportunidad)
    .replaceAll('YYYY-MM-DD', vars.today);
}

// ─── Prompt del LLM ─────────────────────────────────────────────────────────

/** Prompt del compactador de contexto (auto-compact). Fusiona el resumen
 *  anterior con los mensajes nuevos fuera de ventana en UN resumen corto. */
function buildCompactPrompt(previousSummary: string, chunk: string): string {
  return `Eres el compactador de contexto de un chat de pre-venta (agencia de software en Colombia). Fusiona el RESUMEN ANTERIOR y los MENSAJES NUEVOS en UN solo resumen de MÁXIMO 150 palabras, en viñetas, español neutral.

CONSERVA SIEMPRE (si aparecen): hechos del negocio del cliente, funcionalidades/alcance acordado o a validar, integraciones, presupuesto/plazo SOLO si los dijo el cliente (con su moneda), decisiones aceptadas o rechazadas, correcciones ("eso no", "es irreal"), y pendientes.
DESCARTA: saludos, repeticiones, frases de cortesía, redacción del asistente.

RESUMEN ANTERIOR (puede estar vacío):
${previousSummary || '(ninguno)'}

MENSAJES NUEVOS A INCORPORAR:
${chunk}

Devuelve SOLO el texto del resumen (sin títulos, sin markdown extra, sin comentarios).`;
}

function buildBriefPrompt(
  draft: SalesBriefDraft,
  history: Array<{ role: string; content: string }>,
  context: string[] = [],
  methodology = '',
  status = '',
  olderVendorNotes = '',
  chatSummary = '',
  tlOptions: { login: string; name: string | null }[] = [],
): string {
  // Resumen compactado de la conversación vieja (auto-compact) — reemplaza a
  // los mensajes crudos fuera de la ventana. ~1500 chars fijos por prompt.
  const summaryBlock = chatSummary.trim()
    ? `
RESUMEN COMPACTADO DE LA CONVERSACIÓN ANTERIOR (generado por el sistema — hechos y decisiones previos a los últimos mensajes; cuenta como contexto verídico, no lo re-preguntes):
${chatSummary.trim()}
`
    : '';
  const historyText = history.map((m) => `${m.role === 'vendor' ? 'VENDEDOR' : 'ASISTENTE'}: ${m.content}`).join('\n\n');
  // Bloque de contexto recuperado (RAG). Solo entra si hay algo relevante — así
  // el prompt no crece cuando no aporta (economía de cuota del LLM gratuito).
  const contextBlock = context.length
    ? `\nCONTEXTO RECUPERADO (memoria de este proceso + casos ganados — úsalo si aplica, NO lo copies literal):\n${context.map((c) => `— ${c}`).join('\n\n')}\n`
    : '';
  // Metodología de ventas del monorepo (rules/13). Es la FUENTE DE VERDAD del
  // proceso/fases que definió el PM — la IA debe respetarla (la usuaria puede
  // haber recortado fases; esto refleja los cambios en ≤10 min).
  const methodologyBlock = methodology.trim()
    ? `\nMETODOLOGÍA Y REGLAS DE VENTA DEL MONOREPO (rules/13 — ES LA FUENTE DE VERDAD, respétala; si define fases/pasos, seguilos, no inventes otros):\n${methodology.trim()}\n`
    : '';
  const statusBlock = status ? `\nFASE ACTUAL DE ESTA OPORTUNIDAD (status.md): ${status}\n` : '';

  // Estado del brief calculado POR EL SERVIDOR — guía determinística para el
  // modelo (los modelos gratis leen mal el JSON del draft y repetían secciones
  // ya cubiertas o inventaban nombres de sección; caso real). CONFÍA en esto.
  // isFilled tolera drafts "sucios" ya guardados (modelos viejos escribieron
  // objetos/listas en campos de texto → "(v ?? '').trim is not a function").
  const isFilled = (v?: unknown) => (fieldToText(v) ?? '').trim().length > 0;
  const sectionState: [string, boolean][] = [
    ['cliente', isFilled(draft.cliente)],
    ['problema', isFilled(draft.problema)],
    ['outcomes', isFilled(draft.outcomes)],
    ['usuariosYFuncionalidades', isFilled(draft.usuariosYFuncionalidades)],
    ['limites', isFilled(draft.limites)],
    ['integraciones', isFilled(draft.integraciones)],
    ['asunciones', (draft.asunciones ?? []).length > 0],
    ['riesgos', isFilled(draft.riesgos)],
    ['sensacionVendedor', isFilled(draft.sensacionVendedor)],
  ];
  const cubiertas = sectionState.filter(([, f]) => f).map(([k]) => k);
  const vacias = sectionState.filter(([, f]) => !f).map(([k]) => k);

  // Pedido directo del vendedor detectado POR EL SERVIDOR (determinístico,
  // mismo criterio que sectionState: los modelos gratis obedecen mejor una
  // marca explícita del sistema que una regla en prosa — la certificación
  // E2E mostró que sin esto siguen con el cuestionario e ignoran el pedido).
  const lastVendorMsg = [...history].reverse().find((m) => m.role === 'vendor')?.content ?? '';
  const asksHowToReply = /(qu[ée] le (respondo|digo|contesto)|c[óo]mo le (respondo|contesto)|qu[ée] respondo)/i.test(lastVendorMsg);
  const mentionsPrice = /(cu[áa]nto|precio|costo|costar|vale|valor|presupuesto|tarifa)/i.test(lastVendorMsg);
  const asksRecap = /(hazme|dame|haz|necesito|quiero|mu[ée]strame|arma)[^.]{0,40}(recap|resumen)/i.test(lastVendorMsg);
  const asksClose =
    /(cierra|cerremos|cerrar|finaliza|finalicemos|termina)[^.]{0,30}(brief|proceso)|brief\s+(listo|cerrado)|(ci[ée]rralo|cerrarlo|puedes cerrar)/i.test(lastVendorMsg);
  const asksNext = /(qu[ée] (paso )?sigue|siguiente paso|c[óo]mo (sigo|seguimos|continuamos)|pasemos a la (otra|siguiente)|qu[ée] falta)/i.test(lastVendorMsg);
  const saysAlreadyTold = /(ya (te )?lo (dije|di|mencion[eé]|pas[eé])|ya me (lo )?preguntaste|ya lo registraste|registraste antes|varias veces)/i.test(lastVendorMsg);
  const asksWhichTl = /(a (cu[áa]l|qu[ée]) tl|qu[ée] tl|cu[áa]l tl|qui[ée]n (es|ser[áa]|va a ser) el tl|qui[ée]n (contin[úu]a|sigue) (con|el))/i.test(lastVendorMsg);
  const directRequest = asksRecap
    ? 'RECAP'
    : asksHowToReply && mentionsPrice
      ? 'GUION DE PRECIO'
      : asksClose
        ? 'CIERRE DEL BRIEF'
        : asksNext
          ? 'QUÉ SIGUE'
          : asksWhichTl
            ? 'QUIÉN ES EL TL'
            : saysAlreadyTold
              ? 'DATO YA DICHO'
              : null;
  // Instrucción ESPECÍFICA por tipo — la certificación E2E mostró que la regla
  // en prosa genérica no alcanza con los modelos gratis; la marca del sistema sí.
  const directInstruction =
    directRequest === 'CIERRE DEL BRIEF'
      ? vacias.length
        ? `El vendedor quiere CERRAR el brief pero faltan secciones: ${vacias.join(', ')}. En el "reply": dilo sin rodeos, y PROPONE en ESTE MISMO turno un valor concreto y razonable para CADA sección faltante (una línea por sección), pidiendo UN solo OK para registrarlas todas juntas. Nada de preguntarlas de a una.`
        : 'El brief ya está COMPLETO. En el "reply": confírmalo y da la acción exacta — pestaña "Resumen" → botón "Pasar a TL". NO digas "procederemos" ni "avanzamos a la siguiente fase": tú NO puedes avanzar fases, esa acción la hace el vendedor con ese botón.'
      : directRequest === 'QUÉ SIGUE'
        ? vacias.length
          ? `El vendedor pregunta QUÉ SIGUE. Respuesta EXACTA (no lo adornes con más preguntas): falta(n) ${vacias.join(', ')} (${cubiertas.length}/${sectionState.length} cubiertas). Propón un valor concreto para cada faltante y pide UN OK para registrarlos. PROHIBIDO decir que el brief está completo o cerrado mientras esta lista no esté vacía.`
          : 'El vendedor pregunta QUÉ SIGUE y el brief está COMPLETO. Respuesta exacta: revisar la pestaña "Resumen" y tocar el botón "Pasar a TL" — el cierre lo hace ÉL con ese botón; tú NO puedes avanzar de fase ni "pasar a la propuesta". No hagas más preguntas.'
        : directRequest === 'DATO YA DICHO'
        ? 'El vendedor reclama que ese dato YA lo dio. BÚSCALO en el DRAFT y en el RESUMEN COMPACTADO y CONFÍRMALO citándolo textual ("Tienes razón: quedó registrado X en Y"). PROHIBIDO volver a pedirlo. Solo si de verdad no aparece en ninguno de los dos, discúlpate y pide únicamente lo que falta.'
        : directRequest === 'QUIÉN ES EL TL'
          ? `Según la metodología (rules/13 §Cerrar el brief), el TL lo asigna EL VENDEDOR al pasar el brief — en esta plataforma se elige junto al botón "Pasar a TL" en la pestaña "Resumen". TLs disponibles del equipo (datos REALES de team.json): ${tlOptions.map((t) => `@${t.login}${t.name ? ` (${t.name})` : ''}`).join(', ') || '(no se pudo leer team.json en este momento)'}. Responde exactamente eso. PROHIBIDO inventar mecanismos que no existen ("tablero de asignaciones", "coordinador de proyectos", "según disponibilidad").`
          : `Aplica la regla correspondiente de PEDIDOS DIRECTOS DEL VENDEDOR.`;
  const directRequestBlock = directRequest
    ? `
🚩 DETECTADO POR EL SISTEMA (determinístico — OBEDECE esto por encima del ESTADO DEL BRIEF y del protocolo): el último mensaje del vendedor es un pedido directo de tipo ${directRequest}. ${directInstruction} En este turno NO cierres con pregunta de sección.${directRequest === 'CIERRE DEL BRIEF' && vacias.length ? '' : ' El draft va igual, sin cambios.'}
`
    : '';
  // Solo cuando el draft está flojo Y hay mensajes viejos fuera de la ventana:
  // los hechos que el vendedor ya contó se recuperan de ahí en UN turno, en vez
  // de re-preguntarle todo (economía de tokens: bloque acotado, condicional).
  const recoveryBlock =
    vacias.length >= 5 && olderVendorNotes.trim()
      ? `
HECHOS PREVIOS DEL VENDEDOR (mensajes anteriores de ESTA conversación que quedaron fuera de la ventana — RECUPERA de aquí todo hecho del cliente que falte y ESCRÍBELO en el draft EN ESTA MISMA respuesta; no le vuelvas a preguntar al vendedor lo que ya está acá):
${olderVendorNotes.trim()}
`
      : '';
  // Guía proactiva del cierre (determinística, mismo patrón que sectionState):
  // el agente SIEMPRE dice cuánto va y qué sigue — el vendedor nunca debería
  // tener que preguntar "¿qué falta?" (caso real). Y con el brief completo, la
  // acción concreta es del vendedor (botón "Pasar a TL" en la pestaña Resumen):
  // el modelo no puede cerrar nada, así que debe decir exactamente eso.
  const workLine = directRequest
    ? 'Este turno NO se trabaja ninguna sección: hay un PEDIDO DIRECTO detectado (ver arriba).'
    : vacias.length
      ? 'Trabaja SOLO sobre la PRIMERA sección vacía.'
      : 'El brief está COMPLETO: NO abras temas nuevos ni hagas más preguntas de sección. Dile claro y directo que revise la pestaña "Resumen" y toque el botón "Pasar a TL" — el cierre lo hace EL VENDEDOR con ese botón, tú no puedes cerrarlo. Si responde "sí, cerremos" o parecido, repítele exactamente esa acción (Resumen → Pasar a TL).';
  const progressLine =
    !directRequest && vacias.length
      ? `\n- GUÍA EL CIERRE: termina cada "reply" con UNA línea de avance redactada natural (distinta cada vez, no plantilla) que diga cuántas secciones van (${cubiertas.length}/${sectionState.length}), cuál sigue y qué necesitas del vendedor para cubrirla.`
      : '';
  const briefStateBlock = `${recoveryBlock}${directRequestBlock}
ESTADO DEL BRIEF (calculado por el sistema — CONFÍA en esto, no lo re-derives del JSON):
- Secciones ya cubiertas: ${cubiertas.join(', ') || '(ninguna)'}
- Secciones VACÍAS, en orden de trabajo: ${vacias.join(', ') || '(ninguna — el brief está COMPLETO)'}
- PROHIBIDO preguntar por una sección ya cubierta (incluida "asunciones" si ya tiene al menos una) — solo se toca si el vendedor la corrige explícitamente. Antes de pedir un dato, revisa el DRAFT: si ya está, confírmalo en vez de pedirlo.
- ${workLine} Los nombres de sección válidos son EXACTAMENTE los de esta lista — no inventes otros (p. ej. "funcionalidadesEsperadas" NO existe).${progressLine}
`;

  return `Eres un CONSULTOR PRE-VENTA experto (software a medida, e-commerce, apps, web) que ayuda a un vendedor a armar el brief de una oportunidad. No eres un formulario: PROPONES, das ejemplos y recomiendas. El vendedor muchas veces no es técnico y necesita que le sugieras opciones para llevarle al cliente.

CONTEXTO LOCAL: Imaginamos es una agencia en COLOMBIA. La moneda de los clientes es el peso colombiano (COP) salvo que digan otra — cualquier monto que registre el CLIENTE va con su moneda explícita (ej. "COP $80.000.000"). Recuerda: tú NUNCA propones montos ni plazos (eso lo calcula el TL en la propuesta); si en la conversación previa llegaste a sugerir algún monto, corrígelo: los montos solo los da el cliente.

Basá TODO (proceso, fases, qué pedir, cómo estructurar el brief y la propuesta) en la METODOLOGÍA DEL MONOREPO de más abajo — es la fuente de verdad de las reglas del negocio, por encima de tu conocimiento genérico.

El DRAFT es la memoria acumulada del proceso: contiene lo ya confirmado en sesiones previas. Continúa desde ahí — no vuelvas a preguntar lo que ya está cargado.
${methodologyBlock}${statusBlock}${summaryBlock}${briefStateBlock}
DRAFT ACTUAL (JSON, puede estar vacío o parcial):
${JSON.stringify(draft, null, 2)}
${contextBlock}
CONVERSACIÓN RECIENTE:
${historyText}

PEDIDOS DIRECTOS DEL VENDEDOR (van PRIMERO — por encima del protocolo y del cuestionario del brief):
- Si el vendedor pide un RECAP/resumen de lo que se sabe: dáselo COMPLETO en el "reply", armado desde el DRAFT + el RESUMEN COMPACTADO (el draft va igual, sin cambios). En ese turno NO sigas con el cuestionario ni cierres con pregunta de sección.
- Si pregunta CÓMO RESPONDER algo que le preguntó el cliente (típico: "me pregunta cuánto cuesta, ¿qué le respondo?"): tu "reply" es un GUION listo para que el vendedor se lo diga al cliente — no una pregunta de brief. Para precio/costo el guion es de este estilo (adáptalo, sin cifras): "El valor exacto sale de la propuesta que arma nuestro equipo técnico a partir del alcance — preferimos validar bien el alcance antes de dar un número, para no inflarlo. En cuanto cerremos el brief te llevamos la propuesta con valores." NUNCA incluyas cifras tuyas; si el cliente ya dijo su presupuesto, puedes reconocerlo. En ese turno NO hagas la siguiente pregunta del cuestionario.
- Solo si el mensaje NO es un pedido directo, aplica el protocolo normal de abajo.

PROTOCOLO DE CONFIRMACIÓN (CRÍTICO — aplícalo antes que el cuestionario, después de los PEDIDOS DIRECTOS):
Si el último mensaje del vendedor es una aceptación ("sí", "continúa", "dale", "me parece", "adelante", "ok"):
1. TOMA tu propuesta del turno ANTERIOR y ESCRÍBELA en el draft, en la sección que corresponda, con el prefijo "A validar con el cliente: …". Esto es OBLIGATORIO — una aceptación que no queda escrita en el draft es un turno perdido.
2. En el "reply": UNA sola línea confirmando qué quedó registrado (no repitas la propuesta completa).
3. Sigue con la PRIMERA sección vacía del ESTADO DEL BRIEF de arriba, con una propuesta NUEVA y ESPECÍFICA de ese tema.

CÓMO RESPONDER (campo "reply") — SÉ PROPOSITIVO Y HAZ AVANZAR:
- PROHIBIDO responder con plantillas: NO reutilices la estructura ni las frases de tus mensajes anteriores (p. ej. NO repitas "Considerando que…" ni "¿Te parece adecuado presentar estas opciones al cliente y evaluar cuál se adapta mejor?"). Cada respuesta debe estar redactada distinto — mira tus turnos anteriores en la conversación y evita parecerte a ellos.
- Cuando el vendedor pide ejemplos o dice "no sé"/"no especificó": DA 3-5 opciones CONCRETAS y típicas para ese tipo de proyecto. NUNCA repitas la misma pregunta.
- Recomienda lo estándar del dominio y explica en una línea por qué. Ante ambigüedad, propone una interpretación por defecto en vez de solo preguntar.
- PROPONE SOLO CUALITATIVO (funcionalidades, alcance, tecnología, integraciones, referentes). NUNCA inventes NÚMEROS: precios, costos, presupuestos, tarifas ni plazos (rules/13: "NUNCA inventar valores"). Los precios se calculan en la etapa de PROPUESTA (TL + estimate.mjs); en el brief solo se registra el presupuesto SI EL CLIENTE lo mencionó.
- En la sección "limites": PREGUNTA al vendedor qué presupuesto y plazo mencionó el cliente (en COP salvo que digan otra moneda) y si están abiertos a fases (MVP primero). NO propongas tú un monto ni una cantidad de semanas — ni siquiera "para asumir": si el cliente no lo dijo, se registra "sin definir".
- Cierra con UNA pregunta útil sobre la sección en la que estás trabajando (no re-preguntes lo ya acordado).

CÓMO LLENAR EL DRAFT (campo "draft") — SÉ FIEL A LOS HECHOS, pero REGISTRÁ EL AVANCE:
1. Los HECHOS del cliente van tal cual. Tus propuestas sueltas (que nadie aceptó todavía) NO van al draft. PERO si el VENDEDOR acepta una dirección ("sí, me parece"), registrala en la sección que corresponda MARCADA como pendiente de confirmación del cliente (ej. en integraciones: "A validar con el cliente: Shopify / WooCommerce / desarrollo a medida con integración al ERP"). Eso hace que la sección quede cubierta y NO la vuelvas a proponer — clave para no repetirte.
2. Fusiona lo nuevo con lo que ya había (no borres campos salvo corrección explícita). Si viene una transcripción larga, extrae todo lo explícito, sección por sección.
3. Cada asunción en "asunciones" necesita su "impactoSiFalla"; si no se dijo, proponé un valor razonable en el "reply" para que el vendedor lo confirme, pero no lo des por hecho en el draft. Si el vendedor dice EXPLÍCITAMENTE que no hay asunciones ("no hay suposiciones", "sin asunciones", "ninguna"), registra UNA asunción literal: { "texto": "Sin asunciones relevantes (confirmado por el vendedor)", "impactoSiFalla": "N/A" } — eso deja la sección CUBIERTA y el brief puede cerrar; no insistas pidiendo asunciones.
4. El draft tiene SOLO estas secciones (no inventes otras — NO hay sección de "costos" ni "precios"): cliente, problema, outcomes, usuariosYFuncionalidades, limites, integraciones, asunciones, riesgos, sensacionVendedor. El presupuesto va dentro de "limites" y SOLO si el cliente lo mencionó (nunca un número inventado por vos).
5. Escribe en español neutral, sin modismos ni regionalismos (nada de voseo: "tú", no "vos").

Devuelve SOLO este JSON (sin markdown, sin texto fuera del JSON):
{
  "reply": "tu respuesta propositiva al vendedor (con ejemplos/opciones concretas cuando aplique)",
  "draft": { /* draft completo actualizado — solo hechos confirmados del cliente, mismo shape que el de arriba */ }
}`;
}

/** Convierte CUALQUIER valor que el LLM haya puesto en un campo de texto del
 *  draft a string legible. Los modelos gratis a veces escriben listas u objetos
 *  en campos de texto ("usuariosYFuncionalidades": ["admin", "comprador"]) —
 *  eso rompía isFilled/isDraftEmpty/renderBriefMd ("trim is not a function",
 *  error real en producción) y ensuciaba el brief.md con [object Object]. */
function fieldToText(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.map((x) => fieldToText(x) ?? JSON.stringify(x)).join('; ');
  }
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}: ${fieldToText(val) ?? JSON.stringify(val)}`)
      .join('; ');
  }
  return String(v);
}

const DRAFT_TEXT_KEYS = [
  'cliente', 'problema', 'outcomes', 'usuariosYFuncionalidades',
  'limites', 'integraciones', 'riesgos', 'sensacionVendedor',
] as const;

/** Normaliza el draft que devuelve el LLM al shape EXACTO de SalesBriefDraft:
 *  todo campo de texto a string, asunciones al shape {texto, impactoSiFalla},
 *  y descarta claves inventadas (ej. "funcionalidadesEsperadas"). Saneo
 *  DETERMINÍSTICO en el borde — no dependemos de que el modelo obedezca. */
function sanitizeDraft(raw: unknown): SalesBriefDraft {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: SalesBriefDraft = {};
  for (const k of DRAFT_TEXT_KEYS) {
    const t = fieldToText(r[k]);
    if (t && t.trim()) out[k] = t;
  }
  if (Array.isArray(r.asunciones)) {
    const asunciones = r.asunciones
      .map((a) => {
        if (typeof a === 'string') return { texto: a, impactoSiFalla: '' };
        if (typeof a === 'object' && a !== null) {
          const o = a as Record<string, unknown>;
          return {
            texto: fieldToText(o.texto) ?? '',
            impactoSiFalla: fieldToText(o.impactoSiFalla) ?? '',
          };
        }
        return { texto: '', impactoSiFalla: '' };
      })
      .filter((a) => a.texto.trim().length > 0);
    if (asunciones.length) out.asunciones = asunciones;
  }
  return out;
}

/** Fusión DEFENSIVA del draft: el modelo devuelve el draft completo cada turno
 *  y los modelos gratis a veces devuelven uno PARCIAL — el update lo pisaba
 *  entero y borraba secciones ya registradas (caso real: el presupuesto se
 *  volvió a preguntar varias veces porque "limites" se vació en un turno malo).
 *  Regla: la memoria solo crece o se corrige — un campo lleno solo cambia si
 *  llega contenido nuevo NO vacío; las asunciones se unen por texto (nunca se
 *  pierden). ponytail: borrar un campo a propósito no se puede desde el chat —
 *  si algún día hace falta, va como acción explícita de UI, no vía LLM. */
function mergeDrafts(prev: SalesBriefDraft, next: SalesBriefDraft): SalesBriefDraft {
  const merged: SalesBriefDraft = { ...prev };
  for (const k of DRAFT_TEXT_KEYS) {
    const val = fieldToText(next[k])?.trim();
    if (val) merged[k] = val;
  }
  const prevAs = Array.isArray(prev.asunciones) ? prev.asunciones : [];
  const nextAs = Array.isArray(next.asunciones) ? next.asunciones : [];
  const seen = new Set(prevAs.map((a) => fieldToText(a?.texto)?.trim().toLowerCase()).filter(Boolean));
  const nuevas = nextAs.filter((a) => {
    const t = fieldToText(a?.texto)?.trim().toLowerCase();
    return t && !seen.has(t);
  });
  if (prevAs.length || nuevas.length) merged.asunciones = [...prevAs, ...nuevas];
  return merged;
}

/** Parseo ROBUSTO de la respuesta del LLM. Los modelos gratis (Llama/Qwen/
 *  DeepSeek vía Groq/OpenRouter) muchas veces envuelven el JSON en fences
 *  \`\`\`json ... \`\`\` o le agregan texto antes/después aunque se les pida JSON
 *  puro — eso rompía el chat con "shape esperado" (errores reales reportados).
 *  Estrategia: JSON directo → sin fences → primer bloque {...} balanceado. */
function parseAssistantResponse(raw: string): SalesSendMessageResult {
  const candidates: string[] = [raw.trim()];

  // Sin fences markdown (```json ... ``` o ``` ... ```).
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  // Primer objeto {...} balanceado (por si hay texto alrededor).
  const start = raw.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { candidates.push(raw.slice(start, i + 1)); break; }
      }
    }
  }

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (typeof parsed.reply === 'string' && typeof parsed.draft === 'object' && parsed.draft !== null) {
        // Saneo determinístico: el draft SIEMPRE sale con el shape correcto,
        // devuelva lo que devuelva el modelo (listas/objetos → texto, claves
        // inventadas → descartadas).
        return { reply: parsed.reply, draft: sanitizeDraft(parsed.draft) };
      }
    } catch {
      // probar el siguiente candidato
    }
  }
  throw new Error(`Respuesta del LLM no tiene el shape esperado: ${raw.slice(0, 200)}`);
}

/** ¿El draft no tiene NADA cargado? (ninguna sección de texto, sin
 *  asunciones). Ver el gate en syncBrief() — esto es lo que evita pisar un
 *  brief.md real con la plantilla vacía. */
function isDraftEmpty(draft: SalesBriefDraft): boolean {
  // fieldToText: tolera drafts "sucios" ya guardados en la base (objetos/listas
  // en campos de texto, escritos por modelos viejos) sin explotar.
  const hasText = DRAFT_TEXT_KEYS.some((k) => (fieldToText(draft[k]) ?? '').trim().length > 0);
  const hasAsunciones = Array.isArray(draft.asunciones) && draft.asunciones.length > 0;
  return !hasText && !hasAsunciones;
}

// ─── Render de brief.md desde el draft ─────────────────────────────────────

function renderBriefMd(draft: SalesBriefDraft): string {
  // fieldToText en cada campo: los drafts viejos de la base pueden traer
  // objetos/listas en campos de texto — sin esto salía "[object Object]".
  const t = (v: unknown) => (fieldToText(v) ?? '').trim() || '_(pendiente)_';
  const asunciones = (Array.isArray(draft.asunciones) ? draft.asunciones : [])
    .map((a) => `- ${fieldToText(a?.texto) ?? ''} — **Impacto si falla:** ${(fieldToText(a?.impactoSiFalla) ?? '').trim() || '_(pendiente)_'}`)
    .join('\n') || '_(sin asunciones registradas)_';

  return `# Brief — generado desde la plataforma (módulo Ventas)

## 1-2. Cliente y problema

${t(draft.cliente)}

${t(draft.problema)}

## 3. Outcomes esperados

${t(draft.outcomes)}

## 4. Usuarios y funcionalidades

${t(draft.usuariosYFuncionalidades)}

## 5. Límites del proyecto

${t(draft.limites)}

## 6. Integraciones necesarias

${t(draft.integraciones)}

## 7. Asunciones que tomamos para estimar

${asunciones}

## 8. Riesgos visibles desde la conversación

${t(draft.riesgos)}

## 9. Sensación del vendedor (gut)

${t(draft.sensacionVendedor)}
`;
}
