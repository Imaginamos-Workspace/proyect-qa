-- 024_add_sales_chat_summary.sql
-- Auto-compact del chat de ventas (tipo Claude Code): cuando la conversación
-- supera la ventana de turnos que ve el LLM, lo viejo se resume en un bloque
-- compacto que viaja en cada prompt (hechos del cliente, decisiones, pendientes)
-- y solo los últimos turnos van crudos. chat_summary_upto = cuántos mensajes
-- (en orden) ya están cubiertos por el resumen, para compactar incremental.
alter table public.sales_opportunities
  add column if not exists chat_summary text,
  add column if not exists chat_summary_upto integer not null default 0;
