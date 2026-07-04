// Estado real completo de una oportunidad (rules/13 §status.md, state machine
// del monorepo): brief → propuesta-en-armado → propuesta-enviada → negociacion
// → ganada/perdida/congelada. Un solo mapa compartido — evitar que la lista y
// el chat divergan en cómo pintan el mismo estado.
export const SALES_STATUS_META: Record<
  string,
  { label: string; variant: 'secondary' | 'success' | 'warning' | 'destructive' | 'info' }
> = {
  brief: { label: 'Brief en armado', variant: 'secondary' },
  'propuesta-en-armado': { label: 'Con el TL', variant: 'info' },
  'propuesta-enviada': { label: 'Propuesta enviada', variant: 'warning' },
  negociacion: { label: 'En negociación', variant: 'warning' },
  ganada: { label: 'Ganada', variant: 'success' },
  perdida: { label: 'Perdida', variant: 'destructive' },
  congelada: { label: 'Congelada', variant: 'secondary' },
};

export function salesStatusMeta(status: string) {
  return SALES_STATUS_META[status] ?? { label: status, variant: 'secondary' as const };
}
