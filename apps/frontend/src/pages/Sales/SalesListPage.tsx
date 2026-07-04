import { useState } from 'react';
import { Link } from 'react-router';
import { Plus, Handshake, Sparkles, KanbanSquare, Briefcase } from 'lucide-react';
import { useCreateOpportunity, useSalesOpportunities } from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { salesStatusMeta } from '@/lib/sales-status';
import { ProspectsKanban } from './ProspectsKanban';

function ManagedProjects() {
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');
  const { data: opportunities, isLoading } = useSalesOpportunities();
  const createOpportunity = useCreateOpportunity();

  const [showForm, setShowForm] = useState(false);
  const [cliente, setCliente] = useState('');
  const [oportunidad, setOportunidad] = useState('');

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
              <Link key={o.id} to={`/ventas/${o.id}`}>
                <Card className="h-full transition-all hover:-translate-y-0.5 hover:shadow-md">
                  <CardContent className="p-5">
                    <div className="mb-2 flex items-center gap-2 text-muted-foreground">
                      <Handshake className="h-4 w-4" />
                      <span className="text-xs">{o.cliente}</span>
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

      <Tabs defaultValue="proyectos">
        <TabsList>
          <TabsTrigger value="prospectos">
            <KanbanSquare className="mr-2 h-4 w-4" /> Gestión de prospectos
          </TabsTrigger>
          <TabsTrigger value="proyectos">
            <Briefcase className="mr-2 h-4 w-4" /> Proyectos gestionados
          </TabsTrigger>
        </TabsList>
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
