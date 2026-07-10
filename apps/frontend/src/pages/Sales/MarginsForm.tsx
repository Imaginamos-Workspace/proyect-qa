import { useEffect, useState } from 'react';
import { Loader2, Percent, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useFinalizeProposal, useProposalTiers } from '@/hooks/use-sales';

interface Row {
  markup: string;
  coordination: string;
}

/** Formulario de márgenes del VENDEDOR (rules/13: los precios los define él,
 *  no el TL). Prellena con los valores que dejó el TL, y al enviar dispara el
 *  workflow que corre set-margin ×tier → compare → rellena proposal.html. El
 *  padre hace polling del estado de la propuesta hasta que quede finalizada. */
export function MarginsForm({ id, onFinalizeStarted }: { id: string; onFinalizeStarted: () => void }) {
  const { data, isLoading } = useProposalTiers(id, true);
  const finalize = useFinalizeProposal(id);
  const [rows, setRows] = useState<Record<string, Row>>({});

  useEffect(() => {
    if (!data?.tiers) return;
    const next: Record<string, Row> = {};
    for (const t of data.tiers) {
      next[t.key] = {
        markup: t.markupPct != null ? String(t.markupPct) : data.markupDefault != null ? String(data.markupDefault) : '',
        coordination:
          t.coordinationMultiplier != null
            ? String(t.coordinationMultiplier)
            : data.coordinationDefault != null
              ? String(data.coordinationDefault)
              : '',
      };
    }
    setRows(next);
  }, [data]);

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (!data?.tiers.length) return null;

  const set = (key: string, field: keyof Row, value: string) =>
    setRows((r) => ({ ...r, [key]: { ...r[key], [field]: value } }));

  const submit = () => {
    const margins: Record<string, { markup: number; coordination?: number }> = {};
    for (const [key, r] of Object.entries(rows)) {
      const markup = Number(r.markup);
      if (!Number.isFinite(markup)) return;
      margins[key] = { markup };
      const coord = Number(r.coordination);
      if (r.coordination.trim() && Number.isFinite(coord)) margins[key].coordination = coord;
    }
    finalize.mutate(margins, { onSuccess: onFinalizeStarted });
  };

  return (
    <Card className="border-primary/40">
      <CardContent className="space-y-4 p-5">
        <div>
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Percent className="h-4 w-4 text-primary" /> Definir márgenes de la propuesta
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            El TL armó los 3 tiers; tú defines el margen (rules/13). Ajusta el % de cada uno y genera el comparativo —
            con eso la propuesta queda lista para publicar. El multiplicador de coordinación es opcional (default del template).
          </p>
        </div>

        <div className="space-y-3">
          {data.tiers.map((t) => (
            <div key={t.key} className="rounded-lg border border-border p-3">
              <div className="mb-2">
                <p className="text-sm font-semibold capitalize text-foreground">{t.key}</p>
                {t.headline && <p className="text-xs text-muted-foreground">{t.headline}</p>}
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="w-28">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Margen (%)</label>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={rows[t.key]?.markup ?? ''}
                    onChange={(e) => set(t.key, 'markup', e.target.value)}
                  />
                </div>
                <div className="w-36">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Coordinación (×)</label>
                  <Input
                    type="number"
                    min="1"
                    step="0.05"
                    value={rows[t.key]?.coordination ?? ''}
                    onChange={(e) => set(t.key, 'coordination', e.target.value)}
                    placeholder="1.2"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <Button className="w-full" onClick={submit} disabled={finalize.isPending}>
          {finalize.isPending ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generando comparativo…</>
          ) : (
            <><Sparkles className="mr-2 h-4 w-4" /> Generar propuestas con estos márgenes</>
          )}
        </Button>
        {finalize.isError && <p className="text-xs text-destructive">{(finalize.error as Error).message}</p>}
        <p className="text-xs text-muted-foreground">
          Corre en segundo plano (~1-2 min). Cuando el comparativo esté listo, esta pantalla te dejará publicar.
        </p>
      </CardContent>
    </Card>
  );
}
