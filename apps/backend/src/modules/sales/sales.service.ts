import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import { GeminiProvider } from '../ai/providers/gemini.provider';
import { SalesRagService } from './sales-rag.service';
import type {
  SalesBriefDraft,
  SalesMessage,
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
// Últimos N turnos que entran al prompt — suficiente contexto conversacional
// sin inflar tokens en cada mensaje (una sesión de brief son ~10-20 turnos).
const HISTORY_WINDOW = 12;
// Directorios de sales/ que NO son oportunidades reales — se saltan al descubrir.
const NON_OPPORTUNITY_DIRS = new Set(['templates', '_stock']);
// Throttle del descubrimiento — evita listar todo `sales/` en cada carga de la
// lista (mismo criterio que los TTL de caché de scrum.service.ts).
const DISCOVERY_TTL_MS = 60_000;
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
const LLM_DEADLINE_MS = 38_000;
// El RAG es un extra: si su embedding se cuelga, no puede demorar la respuesta.
const RAG_RETRIEVE_DEADLINE_MS = 6_000;

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

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gemini: GeminiProvider,
    private readonly rag: SalesRagService,
    config: ConfigService,
  ) {
    this.writeToken = process.env.GITHUB_WRITE_TOKEN || config.get<string>('GITHUB_TOKEN');
  }

  async listOpportunities(): Promise<SalesOpportunity[]> {
    await this.discoverOpportunitiesFromMonorepo();

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
      const clientes = await this.listRepoSubdirs('sales');
      const found: { cliente: string; oportunidad: string }[] = [];
      for (const cliente of clientes) {
        if (NON_OPPORTUNITY_DIRS.has(cliente) || cliente.startsWith('_')) continue;
        const oportunidades = await this.listRepoSubdirs(`sales/${cliente}`);
        for (const oportunidad of oportunidades) found.push({ cliente, oportunidad });
      }
      if (!found.length) return;

      const { data: existing } = await this.supabase.from(OPPORTUNITIES_TABLE).select('cliente, oportunidad');
      const existingSet = new Set((existing ?? []).map((r) => `${r.cliente}/${r.oportunidad}`));
      const missing = found.filter((f) => !existingSet.has(`${f.cliente}/${f.oportunidad}`));

      for (const m of missing) {
        const statusFile = await this
          .readFileFromRepo(`sales/${m.cliente}/${m.oportunidad}/status.md`)
          .catch(() => null);
        if (!statusFile) continue; // sin status.md → no es una oportunidad real generada por sales:new

        const status = statusFile.content.match(/\*\*Etapa actual:\*\*\s*(\S+)/)?.[1] ?? 'brief';
        const vendedorLogin = statusFile.content.match(/\*\*Owner vendedor:\*\*\s*@?([\w-]+)/)?.[1] ?? 'desconocido';
        const now = new Date().toISOString();
        await this.supabase.from(OPPORTUNITIES_TABLE).insert({
          cliente: m.cliente,
          oportunidad: m.oportunidad,
          vendedor_login: vendedorLogin,
          status,
          draft: {},
          created_at: now,
          updated_at: now,
        });
      }
    } catch (err) {
      this.logger.error(`Descubrimiento de oportunidades del monorepo falló: ${(err as Error).message}`);
    }
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
  private async loadOpportunity(id: string): Promise<{ opp: SalesOpportunity; messages: SalesMessage[] }> {
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

    return { opp: toOpportunity(oppRow as DbOpportunity), messages };
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
    const { opp, messages } = await this.loadOpportunity(id);
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
      const context = await withTimeout(this.rag.retrieve(content, opp.cliente), RAG_RETRIEVE_DEADLINE_MS)
        .catch(() => [] as string[]);

      // 3. Llamar al LLM CON DEADLINE DURO: si tarda más de LLM_DEADLINE_MS,
      //    cortamos con un error accionable en vez de dejar la request colgada
      //    indefinidamente (el usuario veía "Pensando… (200s)" sin fin).
      const history = [...messages, { role: 'vendor' as const, content, id: '', opportunityId: id, createdAt: now }]
        .slice(-HISTORY_WINDOW);
      const prompt = buildBriefPrompt(opp.draft, history, context);

      const raw = await withTimeout(
        this.gemini.generateRaw({
          prompt,
          temperature: 0.3,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        }),
        LLM_DEADLINE_MS,
        'El asistente tardó demasiado en responder (el modelo gratuito puede estar saturado). Volvé a intentar en un momento.',
      );

      const parsed = parseAssistantResponse(raw);

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
        .update({ draft: parsed.draft, updated_at: nowReply })
        .eq('id', id);

      // 5. Post-turno (indexar RAG + auto-sync de brief.md) FUERA del camino de
      //    respuesta: no demora ni un segundo la respuesta al vendedor. Best-
      //    effort (en serverless puede no completar; el brief igual se sincroniza
      //    con "Sincronizar"/handoff, y el RAG se reindexa después).
      void this.afterTurn(id, opp, content, parsed).catch((err) =>
        this.logger.warn(`Post-turno de ${opp.cliente}/${opp.oportunidad} degradó: ${(err as Error).message}`),
      );

      return parsed;
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
      throw err;
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

  async handoff(id: string, requesterLogin: string | null): Promise<SalesSyncResult> {
    const result = await this.syncBrief(id, requesterLogin); // ya verifica dueño
    const { opp } = await this.loadOpportunity(id);

    const statusPath = `sales/${opp.cliente}/${opp.oportunidad}/status.md`;
    const current = await this.readFileFromRepo(statusPath);
    if (current) {
      const updated = current.content.replace(
        /\*\*Etapa actual:\*\*\s*\S+/,
        '**Etapa actual:** propuesta-en-armado',
      );
      await this.writeFileToRepo(
        statusPath,
        updated,
        `sales(${opp.cliente}): ${opp.oportunidad} pasa a propuesta-en-armado`,
        current.sha,
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
   *  Si no se pasa `sha`, lo busca (GET); 404 → archivo nuevo, sin sha. */
  private async writeFileToRepo(path: string, content: string, message: string, sha?: string): Promise<void> {
    if (!this.writeToken) throw new Error('GITHUB_WRITE_TOKEN no configurado en el servidor.');
    let resolvedSha = sha;
    if (resolvedSha === undefined) {
      const existing = await this.readFileFromRepo(path);
      resolvedSha = existing?.sha;
    }

    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
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
        ...(resolvedSha ? { sha: resolvedSha } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
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
    const templateFiles = await this.listRepoDir('sales/templates', true);
    // En paralelo: son ~11 archivos independientes entre sí (2 llamadas a
    // GitHub cada uno). Secuencial se acerca/supera el timeout de la función
    // serverless (Vercel Hobby); en paralelo el wall-clock es el del archivo
    // más lento, no la suma de todos.
    await Promise.all(
      templateFiles.map(async ({ path: file }) => {
        const existing = await this.readFileFromRepoRaw(file);
        const destPath = file.replace(/^sales\/templates\//, `sales/${cliente}/${oportunidad}/`);
        const substituted = existing.isText
          ? substitutePlaceholders(existing.text!, { cliente, oportunidad, vendedorLogin, today })
          : null;
        await this.writeBinaryOrTextToRepo(destPath, existing, substituted);
      }),
    );
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
    await Promise.all(
      files.map(({ path, sha }) =>
        this.deleteFileFromRepo(path, sha, `sales(${opp.cliente}): elimina ${opp.oportunidad} del pipeline`),
      ),
    );

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
function withTimeout<T>(p: Promise<T>, ms: number, message = 'La operación tardó demasiado.'): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
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

function buildBriefPrompt(
  draft: SalesBriefDraft,
  history: Array<{ role: string; content: string }>,
  context: string[] = [],
): string {
  const historyText = history.map((m) => `${m.role === 'vendor' ? 'VENDEDOR' : 'ASISTENTE'}: ${m.content}`).join('\n\n');
  // Bloque de contexto recuperado (RAG). Solo entra si hay algo relevante — así
  // el prompt no crece cuando no aporta (economía de cuota del LLM gratuito).
  const contextBlock = context.length
    ? `\nCONTEXTO RECUPERADO (memoria de este proceso + metodología + casos ganados — úsalo si aplica, NO lo copies literal):\n${context.map((c) => `— ${c}`).join('\n\n')}\n`
    : '';

  return `Eres el asistente que ayuda a un vendedor a llenar el brief de una oportunidad comercial (rules/13 del monorepo).

El DRAFT es la memoria acumulada del proceso: contiene todo lo que ya se extrajo en sesiones previas. Continúa desde ahí — no vuelvas a preguntar lo que ya está cargado.

DRAFT ACTUAL (JSON, puede estar vacío o parcial):
${JSON.stringify(draft, null, 2)}
${contextBlock}
CONVERSACIÓN RECIENTE:
${historyText}

INSTRUCCIONES:
1. Extrae del último mensaje del vendedor SOLO lo que dijo explícitamente — NUNCA inventes outcomes, prioridades, asunciones o riesgos que no se mencionaron.
2. Actualiza el draft fusionando lo nuevo con lo que ya había (no borres campos previos salvo que el vendedor los corrija explícitamente).
3. Si el mensaje trae una transcripción larga de reunión, trátala igual: extrae todo lo explícito, sección por sección.
4. Cada asunción en "asunciones" necesita su "impactoSiFalla" (qué cambia en tiempo/costo/alcance si la asunción resulta falsa) — si el vendedor no lo dijo, pregúntaselo en tu respuesta en vez de inventarlo.
5. En tu respuesta ("reply"), dile al vendedor qué extrajiste y haz UNA pregunta puntual por lo que falta o quedó ambiguo — no repitas preguntas ya respondidas.
6. Nunca inventes valores. Si falta algo no obligatorio, déjalo vacío y sigue.
7. Escribe en español neutral, sin modismos ni regionalismos (nada de voseo: "tú", no "vos"; "puedes", no "podés").

Devuelve SOLO este JSON (sin markdown, sin texto fuera del JSON):
{
  "reply": "tu respuesta conversacional al vendedor",
  "draft": { /* draft completo actualizado, mismo shape que el de arriba */ }
}`;
}

function parseAssistantResponse(raw: string): SalesSendMessageResult {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.reply === 'string' && typeof parsed.draft === 'object' && parsed.draft !== null) {
      return { reply: parsed.reply, draft: parsed.draft };
    }
  } catch {
    // cae al fallback de abajo
  }
  throw new Error(`Respuesta del LLM no tiene el shape esperado: ${raw.slice(0, 200)}`);
}

/** ¿El draft no tiene NADA cargado? (ninguna sección de texto, sin
 *  asunciones). Ver el gate en syncBrief() — esto es lo que evita pisar un
 *  brief.md real con la plantilla vacía. */
function isDraftEmpty(draft: SalesBriefDraft): boolean {
  const textFields: (string | undefined)[] = [
    draft.cliente, draft.problema, draft.outcomes, draft.usuariosYFuncionalidades,
    draft.limites, draft.integraciones, draft.riesgos, draft.sensacionVendedor,
  ];
  const hasText = textFields.some((v) => (v ?? '').trim().length > 0);
  const hasAsunciones = (draft.asunciones ?? []).length > 0;
  return !hasText && !hasAsunciones;
}

// ─── Render de brief.md desde el draft ─────────────────────────────────────

function renderBriefMd(draft: SalesBriefDraft): string {
  const asunciones = (draft.asunciones ?? [])
    .map((a) => `- ${a.texto} — **Impacto si falla:** ${a.impactoSiFalla || '_(pendiente)_'}`)
    .join('\n') || '_(sin asunciones registradas)_';

  return `# Brief — generado desde la plataforma (módulo Ventas)

## 1-2. Cliente y problema

${draft.cliente || '_(pendiente)_'}

${draft.problema || '_(pendiente)_'}

## 3. Outcomes esperados

${draft.outcomes || '_(pendiente)_'}

## 4. Usuarios y funcionalidades

${draft.usuariosYFuncionalidades || '_(pendiente)_'}

## 5. Límites del proyecto

${draft.limites || '_(pendiente)_'}

## 6. Integraciones necesarias

${draft.integraciones || '_(pendiente)_'}

## 7. Asunciones que tomamos para estimar

${asunciones}

## 8. Riesgos visibles desde la conversación

${draft.riesgos || '_(pendiente)_'}

## 9. Sensación del vendedor (gut)

${draft.sensacionVendedor || '_(pendiente)_'}
`;
}
