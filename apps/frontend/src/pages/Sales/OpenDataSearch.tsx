import { useState } from 'react';
import { Bookmark, BookmarkCheck, Building2, CalendarClock, Globe, Loader2, Mail, MapPin, Phone, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCreateSavedSearch, useOpenDataSearch, useSaveOpenDataCompany } from '@/hooks/use-sales';
import type { OpenDataCompany } from '@qa/shared-types';

/**
 * Búsqueda de empresas colombianas en el REGISTRO PÚBLICO (Datos Abiertos,
 * SECOP II). A diferencia de Apollo: no consume créditos, no tiene cuota
 * diaria y no necesita API key, y las empresas vienen con NIT.
 *
 * La contrapartida: devuelve la EMPRESA, no una persona con cargo. El
 * vendedor consigue el contacto llamando, y lo nutre desde el pipeline.
 */
export function OpenDataSearch({ isVendedor }: { isVendedor: boolean }) {
  const [keywords, setKeywords] = useState('');
  const [city, setCity] = useState('Bogotá');
  const [guardadas, setGuardadas] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState<string | null>(null);

  const search = useOpenDataSearch();
  const save = useSaveOpenDataCompany();
  const guardarSemanal = useCreateSavedSearch();

  const claveDe = (c: OpenDataCompany) => c.nit ?? c.domain ?? c.name;

  const buscar = () => {
    if (!keywords.trim()) return;
    search.mutate({ keywords: keywords.trim(), city: city.trim() || undefined, limit: 25 });
  };

  const guardar = (c: OpenDataCompany) => {
    const clave = claveDe(c);
    setGuardando(clave);
    save.mutate(c, {
      onSuccess: (r) => {
        // `saved:false` con motivo "ya estaba" también cuenta como guardada:
        // el vendedor no tiene por qué distinguirlo.
        setGuardadas((prev) => new Set(prev).add(clave));
        if (!r.saved && r.reason && !/ya estaba/i.test(r.reason)) {
          // Motivo real (sin NIT ni sitio) — se muestra en la tarjeta.
          setGuardadas((prev) => {
            const s = new Set(prev);
            s.delete(clave);
            return s;
          });
        }
      },
      onSettled: () => setGuardando(null),
    });
  };

  const resultados = search.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_220px_auto]">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="od-kw">
                Qué buscás
              </label>
              <Input
                id="od-kw"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && buscar()}
                placeholder="logistica, software, construccion…"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground" htmlFor="od-city">
                Ciudad
              </label>
              <Input
                id="od-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && buscar()}
                placeholder="Bogotá, Medellín, Cali…"
              />
            </div>
            <div className="flex items-end">
              <div className="flex gap-2">
                <Button onClick={buscar} disabled={!keywords.trim() || search.isPending}>
                  {search.isPending
                    ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Buscando…</>
                    : <><Search className="mr-2 h-4 w-4" /> Buscar</>}
                </Button>
                <Button
                  variant="outline"
                  disabled={!isVendedor || !keywords.trim() || guardarSemanal.isPending}
                  onClick={() => guardarSemanal.mutate({
                    keywords: keywords.trim(),
                    city: city.trim() || undefined,
                    source: 'web',
                  })}
                  title="El cron la ejecuta cada lunes y suma las empresas nuevas a tu pipeline, sin duplicar"
                >
                  <CalendarClock className="mr-2 h-4 w-4" /> Semanal
                </Button>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Registro público de empresas de Colombia (SECOP II). Gratis y sin límite de
            búsquedas — no consume créditos. Solo empresas activas: las personas
            naturales quedan excluidas.
          </p>

          {search.isError && (
            <p className="text-sm text-destructive">{(search.error as Error).message}</p>
          )}
          {guardarSemanal.isSuccess && (
            <p className="text-xs text-primary">
              Búsqueda guardada — corre cada lunes y suma las empresas nuevas sin duplicar.
            </p>
          )}
        </CardContent>
      </Card>

      {search.isSuccess && resultados.length === 0 && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Sin resultados para “{keywords}”{city ? ` en ${city}` : ''}. Probá con una
            palabra más general — el registro busca por razón social, así que “transporte”
            suele traer más que “transporte refrigerado”.
          </CardContent>
        </Card>
      )}

      {resultados.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            {resultados.length} empresa{resultados.length === 1 ? '' : 's'} · guardá las que te
            interesen para trabajarlas en tu pipeline.
          </p>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {resultados.map((c) => {
              const clave = claveDe(c);
              const yaEsta = guardadas.has(clave);
              const enCurso = guardando === clave;
              return (
                <Card key={clave}>
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Building2 className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{c.companyType ?? 'Empresa'}</span>
                    </div>

                    <p className="font-medium leading-tight text-foreground">{c.name}</p>

                    {c.nit && (
                      <Badge variant="secondary" className="text-xs">NIT {c.nit}</Badge>
                    )}

                    <div className="space-y-1 text-xs text-muted-foreground">
                      {(c.city || c.department) && (
                        <p className="flex items-center gap-1.5">
                          <MapPin className="h-3 w-3 shrink-0" />
                          <span className="truncate">{[c.city, c.department].filter(Boolean).join(', ')}</span>
                        </p>
                      )}
                      {c.phone && (
                        <p className="flex items-center gap-1.5">
                          <Phone className="h-3 w-3 shrink-0" /> {c.phone}
                        </p>
                      )}
                      {c.email && (
                        <p className="flex items-center gap-1.5">
                          <Mail className="h-3 w-3 shrink-0" />
                          <span className="truncate">{c.email}</span>
                        </p>
                      )}
                      {c.domain && (
                        <p className="flex items-center gap-1.5">
                          <Globe className="h-3 w-3 shrink-0" />
                          <a
                            href={`https://${c.domain}`}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate hover:underline"
                          >
                            {c.domain}
                          </a>
                        </p>
                      )}
                    </div>

                    <Button
                      size="sm"
                      className="w-full"
                      variant={yaEsta ? 'secondary' : 'default'}
                      disabled={!isVendedor || yaEsta || enCurso}
                      onClick={() => guardar(c)}
                    >
                      {enCurso
                        ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Guardando…</>
                        : yaEsta
                          ? <><BookmarkCheck className="mr-1.5 h-3.5 w-3.5" /> Guardada</>
                          : <><Bookmark className="mr-1.5 h-3.5 w-3.5" /> Guardar</>}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {!isVendedor && (
            <p className="text-xs text-muted-foreground">
              Solo el rol vendedor puede guardar empresas en el pipeline.
            </p>
          )}
        </>
      )}
    </div>
  );
}
