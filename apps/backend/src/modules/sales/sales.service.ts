import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import { GeminiProvider } from '../ai/providers/gemini.provider';
import type {
  SalesBriefDraft,
  SalesMessage,
  SalesOpportunity,
  SalesOpportunityDetail,
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

  async getOpportunity(id: string): Promise<SalesOpportunityDetail> {
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

    return { ...toOpportunity(oppRow as DbOpportunity), messages };
  }

  async sendMessage(id: string, content: string): Promise<SalesSendMessageResult> {
    const detail = await this.getOpportunity(id);
    const now = new Date().toISOString();

    // 1. Persistir el mensaje del vendedor primero — si el LLM falla, no se pierde.
    await this.supabase.from(MESSAGES_TABLE).insert({
      opportunity_id: id,
      role: 'vendor',
      content,
      created_at: now,
    });

    // 2. Llamar al LLM (cascada Gemini flash→pro→Groq→DeepSeek ya incluida en
    //    GeminiProvider — nada nuevo que construir acá).
    const history = [...detail.messages, { role: 'vendor' as const, content, id: '', opportunityId: id, createdAt: now }]
      .slice(-HISTORY_WINDOW);
    const prompt = buildBriefPrompt(detail.draft, history);

    const raw = await this.gemini.generateRaw({
      prompt,
      temperature: 0.3,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    });

    const parsed = parseAssistantResponse(raw);

    // 3. Persistir la respuesta + draft actualizado.
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

    return parsed;
  }

  async syncBrief(id: string): Promise<SalesSyncResult> {
    const opp = await this.getOpportunity(id);
    const briefMd = renderBriefMd(opp.draft);
    const path = `sales/${opp.cliente}/${opp.oportunidad}/brief.md`;
    await this.writeFileToRepo(path, briefMd, `sales(${opp.cliente}): actualiza brief de ${opp.oportunidad} desde la plataforma`);

    const syncedAt = new Date().toISOString();
    await this.supabase.from(OPPORTUNITIES_TABLE).update({ synced_at: syncedAt, updated_at: syncedAt }).eq('id', id);

    return { url: `https://github.com/${OWNER}/${REPO}/blob/main/${path}`, syncedAt };
  }

  async handoff(id: string): Promise<SalesSyncResult> {
    const result = await this.syncBrief(id);
    const opp = await this.getOpportunity(id);

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
  async deleteOpportunity(id: string): Promise<{ deleted: true; filesDeleted: number }> {
    const opp = await this.getOpportunity(id);
    const basePath = `sales/${opp.cliente}/${opp.oportunidad}`;

    const files = await this.listRepoDir(basePath, true);
    await Promise.all(
      files.map(({ path, sha }) =>
        this.deleteFileFromRepo(path, sha, `sales(${opp.cliente}): elimina ${opp.oportunidad} del pipeline`),
      ),
    );

    const { error } = await this.supabase.from(OPPORTUNITIES_TABLE).delete().eq('id', id);
    if (error) throw new Error(`Se borraron los archivos del monorepo pero no la fila de Supabase: ${error.message}`);

    return { deleted: true, filesDeleted: files.length };
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
): string {
  const historyText = history.map((m) => `${m.role === 'vendor' ? 'VENDEDOR' : 'ASISTENTE'}: ${m.content}`).join('\n\n');

  return `Sos el asistente que ayuda a un vendedor a llenar el brief de una oportunidad comercial (rules/13 del monorepo).

DRAFT ACTUAL (JSON, puede estar vacío o parcial):
${JSON.stringify(draft, null, 2)}

CONVERSACIÓN RECIENTE:
${historyText}

INSTRUCCIONES:
1. Extraé del último mensaje del vendedor SOLO lo que dijo explícitamente — NUNCA inventes outcomes, prioridades, asunciones o riesgos que no se mencionaron.
2. Actualizá el draft fusionando lo nuevo con lo que ya había (no borres campos previos salvo que el vendedor los corrija explícitamente).
3. Si el mensaje trae una transcripción larga de reunión, tratala igual: extraé todo lo explícito, sección por sección.
4. Cada asunción en "asunciones" necesita su "impactoSiFalla" (qué cambia en tiempo/costo/alcance si la asunción resulta falsa) — si el vendedor no lo dijo, preguntaselo en tu respuesta en vez de inventarlo.
5. En tu respuesta ("reply"), decile al vendedor qué extrajiste y hacé UNA pregunta puntual por lo que falta o quedó ambiguo — no repitas preguntas ya respondidas.
6. Nunca inventes valores. Si falta algo no obligatorio, dejalo vacío y seguí.

Devolvé SOLO este JSON (sin markdown, sin texto fuera del JSON):
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
