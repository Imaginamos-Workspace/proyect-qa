import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import { GeminiProvider } from '../ai/providers/gemini.provider';
import type { SalesOpportunity } from '../../shared-types';

const OWNER = 'imaginamos';
const REPO = 'qa-automation-monorepo';
const KNOWLEDGE_TABLE = 'sales_knowledge';
// Corte de fragmentos: ~1200 chars por chunk mantiene cada embedding enfocado
// (mejor recall) sin fragmentar de más.
const MAX_CHUNK_CHARS = 1200;
const RETRIEVE_K = 6;
// Por debajo de esta similitud coseno, el fragmento no aporta — se descarta
// (evita meter ruido al prompt del LLM gratuito).
const MIN_SIMILARITY = 0.45;
// Tope DURO del bloque de contexto que entra al prompt. Es la clave de la
// economía de tokens: por más memoria indexada que haya, al LLM solo le llega
// esto — recall alto, contexto acotado.
const MAX_CONTEXT_CHARS = 2000;

// Fuentes de metodología en el monorepo (rules/13 + plantilla del brief).
const METHODOLOGY_SOURCES = [
  { ref: 'method:rules-13', path: 'rules/13-ventas-y-propuestas.md' },
  { ref: 'method:brief-template', path: 'sales/templates/brief.md' },
];

/**
 * RAG del agente de ventas. Tres tipos de conocimiento:
 *  - 'opportunity': memoria del propio proceso (brief + turnos de la charla),
 *    acotada a su cliente por privacidad.
 *  - 'won_deal': briefs/propuestas de negocios ganados, como ejemplos
 *    compartidos del equipo.
 *  - 'methodology': rules/13 + plantilla del brief.
 *
 * Diseño pensado para NO saturar el LLM gratuito: en vez de mandar toda la
 * conversación en cada mensaje, indexamos cada turno y recuperamos solo los
 * top-K fragmentos relevantes al mensaje actual, con tope duro de chars.
 */
@Injectable()
export class SalesRagService {
  private readonly logger = new Logger(SalesRagService.name);
  private readonly token: string | undefined;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gemini: GeminiProvider,
    config: ConfigService,
  ) {
    this.token = process.env.GITHUB_WRITE_TOKEN || config.get<string>('GITHUB_TOKEN');
  }

  /** Recupera los top-K fragmentos relevantes al mensaje, acotado por cliente.
   *  Best-effort: si el RAG falla (sin extensión, sin datos, cuota agotada),
   *  devuelve [] y el chat sigue funcionando igual. */
  async retrieve(query: string, cliente: string | null): Promise<string[]> {
    if (!query.trim()) return [];
    try {
      const [embedding] = await this.gemini.embed([query.slice(0, 2000)]);
      if (!embedding) return [];
      const { data, error } = await this.supabase.rpc('match_sales_knowledge', {
        query_embedding: embedding,
        match_count: RETRIEVE_K,
        filter_cliente: cliente,
      });
      if (error) {
        this.logger.warn(`match_sales_knowledge falló: ${error.message}`);
        return [];
      }
      const rows = (data ?? []) as { chunk: string; similarity: number }[];
      const picked: string[] = [];
      let total = 0;
      for (const r of rows) {
        if (r.similarity < MIN_SIMILARITY) continue;
        if (total + r.chunk.length > MAX_CONTEXT_CHARS) break;
        picked.push(r.chunk);
        total += r.chunk.length;
      }
      return picked;
    } catch (err) {
      this.logger.warn(`RAG retrieve degradó: ${(err as Error).message}`);
      return [];
    }
  }

  /** Indexa INCREMENTALMENTE el turno nuevo (mensaje del vendedor + respuesta
   *  del asistente) — append, sin re-embeder toda la conversación. Clave para
   *  no gastar cuota gratuita: 1 sola llamada de embeddings de 2 textos cortos
   *  por turno, en vez de re-embeder O(n) mensajes cada vez. */
  async indexTurn(opp: SalesOpportunity, vendorContent: string, assistantContent: string): Promise<void> {
    const chunks = [`Vendedor: ${vendorContent}`, `Asistente: ${assistantContent}`].filter(
      (c) => c.trim().length > 25,
    );
    if (!chunks.length) return;
    const embeddings = await this.gemini.embed(chunks);
    const now = new Date().toISOString();
    const rows = chunks.map((chunk, i) => ({
      source: 'opportunity' as const,
      ref: `opp:${opp.id}`, // mismo ref para toda la memoria del proceso (append)
      cliente: opp.cliente,
      vendedor_login: opp.vendedorLogin,
      chunk,
      embedding: embeddings[i],
      updated_at: now,
    }));
    const { error } = await this.supabase.from(KNOWLEDGE_TABLE).insert(rows);
    if (error) throw new Error(`No se pudo indexar el turno de opp:${opp.id}: ${error.message}`);
  }

  /** Olvida la memoria RAG de un proceso borrado (por su id). */
  async forgetOpportunity(id: string): Promise<void> {
    await this.supabase.from(KNOWLEDGE_TABLE).delete().eq('ref', `opp:${id}`);
  }

  /** Indexa un negocio ganado (brief + propuesta) como ejemplo del equipo. */
  async indexWonDeal(opp: SalesOpportunity, briefMd: string, proposal: string | null): Promise<void> {
    const chunks = [...this.chunk(briefMd), ...(proposal ? this.chunk(proposal) : [])].filter(
      (c) => c.trim().length > 20,
    );
    await this.upsert('won_deal', `won:${opp.cliente}/${opp.oportunidad}`, opp.cliente, opp.vendedorLogin, chunks);
  }

  /** Indexa la metodología (rules/13 + plantilla del brief) desde el monorepo.
   *  Idempotente — se puede re-correr sin duplicar. */
  async indexMethodology(): Promise<{ indexed: number }> {
    let indexed = 0;
    for (const s of METHODOLOGY_SOURCES) {
      const content = await this.fetchRaw(s.path);
      if (!content) continue;
      await this.upsert('methodology', s.ref, null, null, this.chunk(content));
      indexed++;
    }
    return { indexed };
  }

  /** Reindexa idempotente: borra lo viejo de ese `ref`, mete lo nuevo. Best-
   *  effort en indexación de proceso; que falle no debe romper el chat. */
  private async upsert(
    source: 'methodology' | 'opportunity' | 'won_deal',
    ref: string,
    cliente: string | null,
    vendedorLogin: string | null,
    chunks: string[],
  ): Promise<void> {
    await this.supabase.from(KNOWLEDGE_TABLE).delete().eq('ref', ref);
    if (!chunks.length) return;
    const embeddings = await this.gemini.embed(chunks);
    const now = new Date().toISOString();
    const rows = chunks.map((chunk, i) => ({
      source,
      ref,
      cliente,
      vendedor_login: vendedorLogin,
      chunk,
      embedding: embeddings[i],
      updated_at: now,
    }));
    const { error } = await this.supabase.from(KNOWLEDGE_TABLE).insert(rows);
    if (error) throw new Error(`No se pudo indexar ${ref}: ${error.message}`);
  }

  /** Corte por párrafos respetando MAX_CHUNK_CHARS. */
  private chunk(text: string): string[] {
    const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const out: string[] = [];
    let buf = '';
    for (const p of paras) {
      if (buf && buf.length + p.length > MAX_CHUNK_CHARS) {
        out.push(buf);
        buf = '';
      }
      buf = buf ? `${buf}\n\n${p}` : p;
      if (buf.length >= MAX_CHUNK_CHARS) {
        out.push(buf);
        buf = '';
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  private async fetchRaw(path: string): Promise<string | null> {
    try {
      const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github.raw',
          'User-Agent': 'qa-portal-sales-rag',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
}
