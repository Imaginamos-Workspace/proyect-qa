-- 023_sales_rag.sql
-- RAG del agente de ventas: memoria del propio proceso (brief + conversación),
-- metodología (rules/13 + plantilla del brief) y propuestas de negocios ganados
-- como ejemplos. Se indexa con embeddings de Gemini (text-embedding-004, 768
-- dims, capa gratuita) y se recupera por similitud coseno.
--
-- Clave del diseño (economía de contexto del LLM gratuito): en vez de mandarle
-- TODA la conversación en cada mensaje, indexamos cada turno y recuperamos solo
-- los top-K fragmentos relevantes al mensaje actual — recall alto, contexto
-- acotado. El draft (JSONB en sales_opportunities) sigue siendo la memoria
-- estructurada; esto es la memoria "recuperable" para el detalle fino.
create extension if not exists vector;

create table if not exists public.sales_knowledge (
  id uuid primary key default gen_random_uuid(),
  -- 'methodology' (rules/13, plantilla) | 'opportunity' (brief+chat de un
  -- proceso) | 'won_deal' (brief+propuesta de un negocio ganado, ejemplos).
  source text not null check (source in ('methodology', 'opportunity', 'won_deal')),
  ref text not null,               -- id estable para reindexar idempotente (opp:<id>, won:<cliente>/<op>, method:<slug>)
  cliente text,                    -- para acotar la memoria del proceso a su cliente (privacidad)
  vendedor_login text,
  chunk text not null,
  embedding vector(768) not null,
  metadata jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists idx_sales_knowledge_ref on public.sales_knowledge(ref);
-- HNSW: buen recall sin entrenamiento previo, ideal para datasets chicos/medianos.
create index if not exists idx_sales_knowledge_embedding
  on public.sales_knowledge using hnsw (embedding vector_cosine_ops);

alter table public.sales_knowledge enable row level security;

-- Búsqueda por similitud (coseno). SECURITY DEFINER: solo la llama el backend
-- con service-role; RLS deny-all para anon/authenticated (igual que el resto
-- de las tablas de ventas).
--
-- Filtro: la memoria del PROCESO ('opportunity') solo sale para su propio
-- cliente (no filtramos conversaciones ajenas). La metodología y los negocios
-- ganados salen siempre (son conocimiento/ejemplos compartidos del equipo).
create or replace function public.match_sales_knowledge(
  query_embedding vector(768),
  match_count int default 6,
  filter_cliente text default null
)
returns table (id uuid, source text, ref text, cliente text, chunk text, similarity float)
language sql stable security definer set search_path = public as $$
  select k.id, k.source, k.ref, k.cliente, k.chunk,
         1 - (k.embedding <=> query_embedding) as similarity
  from public.sales_knowledge k
  where
    filter_cliente is null
    or k.source in ('methodology', 'won_deal')
    or (k.source = 'opportunity' and k.cliente = filter_cliente)
  order by k.embedding <=> query_embedding
  limit match_count;
$$;
