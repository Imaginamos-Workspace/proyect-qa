import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Building2, ExternalLink, KeyRound, Linkedin, Loader2, Mail, MapPin, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useCreateOpportunity, useProspectsStatus, useSearchProspects } from '@/hooks/use-sales';
import { useScrumMe } from '@/hooks/use-scrum';
import { api } from '@/lib/api';
import type { SalesProspect } from '@qa/shared-types';

// Mismo criterio kebab-case que exige CreateOpportunityDto en el backend.
function slugify(text: string): string {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // saca acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// "CEO, Gerente de operaciones" → ['CEO', 'Gerente de operaciones']
function splitList(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Guía cuando falta la API key — el flujo queda listo y esto es lo único
 *  pendiente de configuración manual. */
function ApolloSetupCard() {
  return (
    <Card className="border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20">
      <CardContent className="space-y-3 p-6">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <KeyRound className="h-4 w-4 text-amber-600" /> Falta la API key de Apollo.io
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Copia tu key desde Apollo.io → Settings → Integrations → API.</li>
          <li>
            En Vercel, proyecto del <span className="font-medium">backend</span> → Settings → Environment
            Variables → agrega <code className="rounded bg-muted px-1">APOLLO_API_KEY</code> y redeploya.
          </li>
          <li>
            En local va en <code className="rounded bg-muted px-1">apps/backend/.env</code>.
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          La key vive solo en el backend — nunca llega al navegador. Apenas esté configurada, este tab
          muestra el buscador automáticamente.
        </p>
      </CardContent>
    </Card>
  );
}

export function ProspectsSearch() {
  const navigate = useNavigate();
  const { data: me } = useScrumMe();
  const isVendedor = !!me?.roles.includes('vendedor');
  const { data: status, isLoading: statusLoading } = useProspectsStatus();
  const search = useSearchProspects();
  const createOpportunity = useCreateOpportunity();

  const [keywords, setKeywords] = useState('');
  const [titles, setTitles] = useState('');
  const [locations, setLocations] = useState('');
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const runSearch = (page = 1) => {
    setErrorMsg(null);
    search.mutate({
      keywords: keywords.trim() || undefined,
      titles: splitList(titles),
      locations: splitList(locations),
      page,
    });
  };

  // Convierte un prospecto real de Apollo en una oportunidad y arranca el chat
  // con lo que ya sabemos — el vendedor no repite a mano lo que Apollo trae.
  // Reusa el mismo endpoint de mensajes del chat normal (el LLM extrae esto al
  // draft igual que cualquier otro texto).
  const onProspectClick = async (p: SalesProspect) => {
    if (!isVendedor || loadingKey) return;
    setErrorMsg(null);
    setLoadingKey(p.id);
    try {
      const cliente = slugify(p.company ?? p.name);
      const oportunidad = 'contacto-inicial';
      const opp = await createOpportunity.mutateAsync({ cliente, oportunidad });
      const seedMessage =
        `Prospecto detectado vía Apollo.io — ${p.company ?? 'empresa por confirmar'}` +
        `${p.industry ? ` (${p.industry})` : ''}. ` +
        `Contacto: ${p.name}${p.title ? `, ${p.title}` : ''}.` +
        `${p.location ? ` Ubicación: ${p.location}.` : ''}` +
        `${p.email ? ` Email: ${p.email}.` : ''}` +
        `${p.companyWebsite ? ` Sitio: ${p.companyWebsite}.` : ''}` +
        ` Ayúdame a armar el brief con esto como punto de partida.`;
      // Timeout largo (55s), igual que el chat normal: este primer mensaje
      // dispara la cascada del LLM y puede tardar más que el default de 20s.
      await api.post(`/sales/opportunities/${opp.id}/messages`, { content: seedMessage }, 55_000);
      navigate(`/ventas/${opp.id}`);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `No se pudo iniciar la conversación con ${p.company ?? p.name}: ${err.message}`
          : `No se pudo iniciar la conversación con ${p.company ?? p.name}.`,
      );
    } finally {
      setLoadingKey(null);
    }
  };

  if (statusLoading) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (!status?.configured) {
    return <ApolloSetupCard />;
  }

  const result = search.data;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="p-6">
          <form
            onSubmit={(e) => { e.preventDefault(); runSearch(1); }}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="min-w-[200px] flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Texto libre</label>
              <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="ecommerce, logística, retail…" />
            </div>
            <div className="min-w-[200px] flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Cargos (separados por coma)</label>
              <Input value={titles} onChange={(e) => setTitles(e.target.value)} placeholder="CEO, Gerente de operaciones" />
            </div>
            <div className="min-w-[200px] flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Ubicación (separadas por coma)</label>
              <Input value={locations} onChange={(e) => setLocations(e.target.value)} placeholder="Bogotá, Colombia" />
            </div>
            <Button type="submit" disabled={!isVendedor || search.isPending}>
              {search.isPending
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Buscando…</>
                : <><Search className="mr-2 h-4 w-4" /> Buscar</>}
            </Button>
          </form>
          {!isVendedor && (
            <p className="mt-2 text-xs text-muted-foreground">Solo el rol vendedor puede buscar (consume cuota de Apollo).</p>
          )}
          {search.isError && (
            <p className="mt-2 text-sm text-destructive">{(search.error as Error).message}</p>
          )}
          {errorMsg && <p className="mt-2 text-sm text-destructive">{errorMsg}</p>}
        </CardContent>
      </Card>

      {search.isPending && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36 w-full" />)}
        </div>
      )}

      {result && !search.isPending && (
        <>
          <p className="text-xs text-muted-foreground">
            {result.totalEntries.toLocaleString()} prospectos — página {result.page} de {result.totalPages}
            {isVendedor ? '. Toca uno para crear la oportunidad y arrancar el chat con sus datos precargados.' : '.'}
          </p>
          {result.prospects.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center text-sm text-muted-foreground">
                Sin resultados con esos filtros — prueba con menos criterios.
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {result.prospects.map((p) => {
                const isLoading = loadingKey === p.id;
                return (
                  <Card
                    key={p.id}
                    role={isVendedor ? 'button' : undefined}
                    tabIndex={isVendedor ? 0 : undefined}
                    onClick={() => onProspectClick(p)}
                    onKeyDown={(e) => { if (e.key === 'Enter') onProspectClick(p); }}
                    className={`transition-colors ${
                      !isVendedor ? '' : loadingKey ? 'cursor-default opacity-70' : 'cursor-pointer hover:border-primary hover:bg-primary/5'
                    }`}
                  >
                    <CardContent className="space-y-2 p-4">
                      <div className="flex items-center justify-between gap-2 text-muted-foreground">
                        <span className="flex items-center gap-2 text-xs">
                          <Building2 className="h-3.5 w-3.5" /> {p.industry ?? 'Sin industria'}
                        </span>
                        {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                      </div>
                      <p className="font-medium text-foreground">{p.company ?? p.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {p.name}{p.title ? ` — ${p.title}` : ''}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {p.location && (
                          <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {p.location}</span>
                        )}
                        {p.email && (
                          <span className="flex items-center gap-1"><Mail className="h-3 w-3" /> {p.email}</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                        {p.linkedinUrl && (
                          <a href={p.linkedinUrl} target="_blank" rel="noreferrer">
                            <Badge variant="secondary" className="gap-1"><Linkedin className="h-3 w-3" /> LinkedIn</Badge>
                          </a>
                        )}
                        {p.companyWebsite && (
                          <a href={p.companyWebsite} target="_blank" rel="noreferrer">
                            <Badge variant="secondary" className="gap-1"><ExternalLink className="h-3 w-3" /> Sitio</Badge>
                          </a>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
          {result.totalPages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button variant="outline" size="sm" disabled={result.page <= 1 || search.isPending} onClick={() => runSearch(result.page - 1)}>
                Anterior
              </Button>
              <span className="text-xs text-muted-foreground">{result.page} / {result.totalPages}</span>
              <Button variant="outline" size="sm" disabled={result.page >= result.totalPages || search.isPending} onClick={() => runSearch(result.page + 1)}>
                Siguiente
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
