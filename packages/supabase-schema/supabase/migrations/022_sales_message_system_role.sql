-- 022_sales_message_system_role.sql
-- Habilita el rol 'system' en sales_messages: notas del propio pipeline que
-- no escribe ni el vendedor ni el LLM (proceso cedido a otro vendedor,
-- proceso reclamado). Se muestran como una línea de sistema en el chat y
-- dejan rastro en el histórico que viaja con el proceso al cederlo.
alter table public.sales_messages
  drop constraint if exists sales_messages_role_check;

alter table public.sales_messages
  add constraint sales_messages_role_check
  check (role in ('vendor', 'assistant', 'system'));
