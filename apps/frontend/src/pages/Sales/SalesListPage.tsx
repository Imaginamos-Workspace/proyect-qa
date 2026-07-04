import { useState } from 'react';
import { Link } from 'react-router';
import { Plus, Handshake, Sparkles, KanbanSquare, Briefcase, LayoutDashboard, Trash2 } from 'lucide-react';
import { useCreateOpportunity, useSalesOpportunities, useDeleteOpportunity } from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { salesStatusMeta } from '@/lib/sales-status';
import { ProspectsKanban } from './ProspectsKanban';
import { SalesDashboard } from './SalesDashboard';

function ManagedProjects() {
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');
  const { data: opportunities, isLoading } = useSalesOpportunities();
  const createOpportunity = useCreateOpportunity();
  const deleteOpportunity = useDeleteOpportunity();

  const [showForm, setShowForm] = useState(false);
  const [cliente, setCliente] = useState('');
  const [oportunidad, setOportunidad] = useState('');

  const quickDelete = (e: React.MouseEvent, id: string, cliente: string, oportunidad: string) => {
    e.preventDefault(); // no navegar al detalle
    e.stopPropagation();
    const ok = window.confirm(
      `¿Eliminar "${cliente}/${oportunidad}" del pipeline? Esto borra los archivos del monorepo y no se puede deshacer.`,
    );
    if (ok) deleteOpportunity.mutate(id);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    createOpportunity.mutate(
      { cliente, oportunidad },
      { onSuccess: () => { setShowForm(false); setCliente(''); setOportunidad(''); } },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        {isVendedor && (
          <Button onClick={() => setShowForm((v) => !v)}>
            <Plus className="mr-2 h-4 w-4" /> Nueva oportunidad
          </Button>
        )}
      </div>

      {showForm && (
        <Card>
          <CardContent className="p-6">
            <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
              <div className="min-w-[180px] flex-1">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Cliente (kebab-case)</label>
                <Input value={cliente} onChange={(e) => setCliente(e.target.value)} placeholder="acme-corp" required />
              </div>
              <div className="min-w-[180px] flex-1">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Oportunidad (kebab-case)</label>
                <Input value={oportunidad} onChange={(e) => setOportunidad(e.target.value)} placeholder="sitio-institucional" required />
              </div>
              <Button type="submit" disabled={createOpportunity.isPending}>
                {createOpportunity.isPending ? 'Creando…' : 'Crear'}
              </Button>
            </form>
            {createOpportunity.isError && (
              <p className="mt-2 text-sm text-destructive">{(createOpportunity.error as Error).message}</p>
            )}
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : !opportunities?.length ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Sparkles className="h-6 w-6 text-primary" />
            </div>
            <p className="text-sm text-muted-foreground">Sin oportunidades todavía.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {opportunities.map((o) => {
            const statusMeta = salesStatusMeta(o.status);
            return (
              <Link key={o.id} to={`/ventas/${o.id}`} className="relative block">
                <Card className="h-full transition-all hover:-translate-y-0.5 hover:shadow-md">
                  <CardContent className="p-5">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Handshake className="h-4 w-4" />
                        <span className="text-xs">{o.cliente}</span>
                      </div>
                      {isVendedor && (
                        <button
                          type="button"
                          title="Eliminar del pipeline"
                          onClick={(e) => quickDelete(e, o.id, o.cliente, o.oportunidad)}
                          className="rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <p className="mb-3 font-medium text-foreground">{o.oportunidad}</p>
                    <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SalesListPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
          <Handshake className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">Ventas</h1>
          <p className="text-sm text-muted-foreground">
            Prospección y oportunidades comerciales, sin salir de la plataforma.
          </p>
        </div>
      </div>

      <Tabs defaultValue="dashboard">
        <TabsList className="grid h-auto w-full grid-cols-3 gap-1 py-1 sm:inline-grid sm:h-10 sm:w-auto sm:gap-0 sm:py-1">
          <TabsTrigger value="dashboard" className="h-auto whitespace-normal py-2 text-center text-xs leading-tight sm:text-sm">
            <LayoutDashboard className="mr-1.5 h-4 w-4 shrink-0 sm:mr-2" /> Dashboard
          </TabsTrigger>
          <TabsTrigger value="prospectos" className="h-auto whitespace-normal py-2 text-center text-xs leading-tight sm:text-sm">
            <KanbanSquare className="mr-1.5 h-4 w-4 shrink-0 sm:mr-2" /> Gestión de prospectos
          </TabsTrigger>
          <TabsTrigger value="proyectos" className="h-auto whitespace-normal py-2 text-center text-xs leading-tight sm:text-sm">
            <Briefcase className="mr-1.5 h-4 w-4 shrink-0 sm:mr-2" /> Proyectos gestionados
          </TabsTrigger>
        </TabsList>
        <TabsContent value="dashboard">
          <SalesDashboard />
        </TabsContent>
        <TabsContent value="prospectos">
          <ProspectsKanban />
        </TabsContent>
        <TabsContent value="proyectos">
          <ManagedProjects />
        </TabsContent>
      </Tabs>
    </div>
  );
}
