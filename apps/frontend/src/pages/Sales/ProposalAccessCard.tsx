import { Link } from 'react-router';
import { FileText, Info, ShieldAlert, Settings, Eye } from 'lucide-react';
import { useProposalAccess, useProposalMetrics } from '@/hooks/use-sales';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/** Resumen compacto en el chat — el detalle (link, contraseña, regenerar,
 *  métricas, compartir) vive en /ventas/:id/propuesta (ProposalConfigPage). */
export function ProposalAccessCard({ id }: { id: string; cliente: string; oportunidad: string }) {
  const { data, isLoading } = useProposalAccess(id);
  const { data: metrics } = useProposalMetrics(data?.generated ? id : null);

  if (isLoading || !data) return null;

  if (!data.generated) {
    // El TL dejó la propuesta a medias → decir QUÉ falta, no invitar a publicar.
    if (data.pendingReason) {
      return (
        <Card className="border-warning/40">
          <CardContent className="flex items-start gap-3 p-4">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <p className="text-sm font-medium text-foreground">Falta un paso antes de publicar</p>
              <p className="mt-0.5 text-sm text-muted-foreground">{data.pendingReason}</p>
            </div>
          </CardContent>
        </Card>
      );
    }
    // El TL ya dejó los tiers → el vendedor puede publicarla desde acá mismo.
    if (data.tiersReady) {
      return (
        <Card className="border-primary/40">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-start gap-2">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">El TL ya armó las 3 propuestas.</span>{' '}
                Publícala para obtener el link y la contraseña, revisarla y enviársela al cliente.
              </p>
            </div>
            <Button size="sm" asChild>
              <Link to={`/ventas/${id}/propuesta`}>
                <Settings className="mr-2 h-3.5 w-3.5" /> Publicar y configurar
              </Link>
            </Button>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            La propuesta todavía no fue generada. El TL la arma con <code className="rounded bg-muted px-1">proposals:build</code>{' '}
            y la publica con <code className="rounded bg-muted px-1">proposal:deploy</code> — mientras tanto podés seguir completando el brief más abajo.
          </p>
        </CardContent>
      </Card>
    );
  }

  const ungated = data.password === null;

  return (
    <Card className={ungated ? 'border-destructive/40' : undefined}>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-2">
          {ungated ? (
            <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
          ) : (
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div>
            <p className={`text-sm font-medium ${ungated ? 'text-destructive' : 'text-foreground'}`}>
              {ungated ? 'Propuesta publicada sin contraseña' : 'Propuesta generada'}
            </p>
            {!ungated && metrics && (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Eye className="h-3 w-3" /> {metrics.totalViews} apertura{metrics.totalViews === 1 ? '' : 's'}
              </p>
            )}
          </div>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to={`/ventas/${id}/propuesta`}>
            <Settings className="mr-2 h-3.5 w-3.5" /> Configurar propuesta
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
