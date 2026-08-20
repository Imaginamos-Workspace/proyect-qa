import { useState } from 'react';
import { KanbanSquare, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSavedProspects } from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { ProspectsPipeline } from './ProspectsPipeline';
import { OpenDataSearch } from './OpenDataSearch';

/**
 * Prospección del vendedor: buscar empresas y trabajarlas en el pipeline.
 *
 * Una sola búsqueda, no dos. Antes había una pestaña por fuente (registro
 * público y Apollo), lo que obligaba al vendedor a saber de dónde sale cada
 * dato — algo que no le importa ni debería.
 *
 * El filtro por cargo (CEO, RRHH) y los datos de contacto NO están acá a
 * propósito: son lo caro en Apollo. Viven en la ficha del prospecto, así que
 * se piden solo cuando el vendedor eligió una empresa y empezó a trabajarla
 * — y una sola vez, porque después quedan en nuestra base.
 */
export function ProspectsSearch() {
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');
  const { data: saved } = useSavedProspects();

  const [view, setView] = useState<'buscar' | 'pipeline'>('buscar');
  // Cliente a abrir al saltar desde la búsqueda a "Mis clientes".
  const [abrirId, setAbrirId] = useState<string | null>(null);

  const irAlTablero = (prospectId: string) => {
    setAbrirId(prospectId);
    setView('pipeline');
  };

  // Cuenta TODOS: excluir convertidos y descartados hacía que el número no
  // coincidiera con las tarjetas del tablero, y el vendedor creía que se le
  // habían perdido clientes.
  const pipelineCount = (saved ?? []).length;

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button variant={view === 'buscar' ? 'default' : 'outline'} size="sm" onClick={() => setView('buscar')}>
          <Search className="mr-2 h-4 w-4" /> Busca nuevos clientes
        </Button>
        <Button variant={view === 'pipeline' ? 'default' : 'outline'} size="sm" onClick={() => setView('pipeline')}>
          <KanbanSquare className="mr-2 h-4 w-4" /> Mis clientes{pipelineCount ? ` (${pipelineCount})` : ''}
        </Button>
      </div>

      {view === 'buscar'
        ? <OpenDataSearch isVendedor={isVendedor} onAbrirProspecto={irAlTablero} />
        : <ProspectsPipeline abrirId={abrirId} onAbierto={() => setAbrirId(null)} />}
    </div>
  );
}
