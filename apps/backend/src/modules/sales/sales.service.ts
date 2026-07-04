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

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gemini: GeminiProvider,
    config: ConfigService,
  ) {
    this.writeToken = process.env.GITHUB_WRITE_TOKEN || config.get<string>('GITHUB_TOKEN');
  }

  async listOpportunities(): Promise<SalesOpportunity[]> {
    const { data, error } = await this.supabase
      .from(OPPORTUNITIES_TABLE)
      .select('*')
      .order('updated_at', { ascending: false });
    if (error) throw new Error(`No se pudieron listar las oportunidades: ${error.message}`);
    return (data ?? []).map(toOpportunity);
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
    for (const file of templateFiles) {
      const existing = await this.readFileFromRepoRaw(file);
      const destPath = file.replace(/^sales\/templates\//, `sales/${cliente}/${oportunidad}/`);
      const substituted = existing.isText
        ? substitutePlaceholders(existing.text!, { cliente, oportunidad, vendedorLogin, today })
        : null;
      await this.writeBinaryOrTextToRepo(destPath, existing, substituted);
    }
  }

  private async listRepoDir(path: string, recursive: boolean): Promise<string[]> {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
      headers: {
        Authorization: `Bearer ${this.writeToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'qa-portal-sales',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub contents GET (dir) ${path} → HTTP ${res.status}`);
    const entries = (await res.json()) as Array<{ path: string; type: 'file' | 'dir' }>;
    const files: string[] = [];
    for (const e of entries) {
      if (e.type === 'file') files.push(e.path);
      else if (e.type === 'dir' && recursive) files.push(...(await this.listRepoDir(e.path, true)));
    }
    return files;
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
