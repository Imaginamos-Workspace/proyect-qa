import { useState } from 'react';
import { Loader2, Mail, MessageCircle, Phone, Plus, UserPlus, Users } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAddProspectContact, useProspectContacts } from '@/hooks/use-sales';

/** Etiqueta legible del cargo normalizado. */
const ROLE_LABEL: Record<string, string> = {
  ceo: 'CEO / Gerencia General',
  direccion: 'Dirección',
  rrhh: 'Recursos Humanos',
  tecnologia: 'Tecnología',
  compras: 'Compras',
  comercial: 'Comercial',
  finanzas: 'Finanzas',
  otro: 'Otro',
};

/**
 * Contactos de un prospecto — el panel donde el vendedor lo trabaja.
 *
 * Es el ÚNICO punto del flujo que puede consumir créditos de Apollo, y solo
 * la primera vez que se abre: después el dato sale de nuestra base. Por eso
 * este panel se monta al seleccionar el prospecto, no en la búsqueda.
 */
export function ProspectContacts({ prospectId }: { prospectId: string }) {
  const { data, isLoading } = useProspectContacts(prospectId);
  const add = useAddProspectContact(prospectId);
  const [abierto, setAbierto] = useState(false);
  const [form, setForm] = useState({ name: '', title: '', email: '', phone: '' });

  const guardar = () => {
    if (!form.name.trim()) return;
    add.mutate(
      {
        name: form.name.trim(),
        title: form.title.trim() || undefined,
        email: form.email.trim() || undefined,
        phone: form.phone.trim() || undefined,
      },
      { onSuccess: () => { setForm({ name: '', title: '', email: '', phone: '' }); setAbierto(false); } },
    );
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Buscando contactos…
        </CardContent>
      </Card>
    );
  }

  const contacts = data?.contacts ?? [];

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Users className="h-4 w-4" /> Contactos
            {contacts.length > 0 && <Badge variant="secondary">{contacts.length}</Badge>}
          </p>
          <Button size="sm" variant="outline" onClick={() => setAbierto((v) => !v)}>
            <Plus className="mr-1.5 h-3.5 w-3.5" /> Agregar
          </Button>
        </div>

        {/* Por qué no hay contactos automáticos, dicho sin jerga. */}
        {data?.status === 'plan-no-permite' && (
          <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            Tu plan de Apollo no incluye la búsqueda de personas, así que los contactos se cargan a mano.
            El resto del prospecto ya está completo.
          </p>
        )}
        {data?.status === 'sin-dominio' && (
          <p className="text-xs text-muted-foreground">
            La empresa no tiene sitio web registrado, así que no hay por dónde buscar contactos automáticamente.
          </p>
        )}
        {data?.status === 'sin-resultados' && (
          <p className="text-xs text-muted-foreground">
            No se encontraron contactos públicos para esta empresa.
          </p>
        )}
        {data?.fromCache && contacts.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Datos ya guardados — no se consumieron créditos al abrir esta ficha.
          </p>
        )}

        {abierto && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Input placeholder="Nombre *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Input placeholder="Cargo (ej. Gerente de Compras)" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              <Input placeholder="Correo" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <Input placeholder="Teléfono (+57…)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={guardar} disabled={!form.name.trim() || add.isPending}>
                {add.isPending
                  ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> Guardando…</>
                  : <><UserPlus className="mr-1.5 h-3.5 w-3.5" /> Guardar contacto</>}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAbierto(false)}>Cancelar</Button>
            </div>
            {add.isError && <p className="text-xs text-destructive">{(add.error as Error).message}</p>}
          </div>
        )}

        {contacts.length === 0 && !abierto && (
          <p className="text-sm text-muted-foreground">
            Todavía no hay contactos. Cuando consigas el nombre de alguien, agregalo acá para
            registrar los intentos contra esa persona.
          </p>
        )}

        {contacts.map((c) => (
          <div key={c.id} className="space-y-1 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{c.name}</span>
              <Badge variant="outline" className="text-xs">{ROLE_LABEL[c.roleTag] ?? c.roleTag}</Badge>
              {c.source === 'manual' && <Badge variant="secondary" className="text-xs">manual</Badge>}
            </div>
            {c.title && <p className="text-xs text-muted-foreground">{c.title}</p>}
            <div className="flex flex-wrap gap-3 pt-1 text-xs">
              {c.email && (
                <a href={`mailto:${c.email}`} className="flex items-center gap-1 hover:underline">
                  <Mail className="h-3 w-3" /> {c.email}
                </a>
              )}
              {c.phone && (
                <a href={`tel:${c.phone}`} className="flex items-center gap-1 hover:underline">
                  <Phone className="h-3 w-3" /> {c.phone}
                </a>
              )}
              {c.whatsapp && (
                <a href={c.whatsapp} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-green-700 hover:underline dark:text-green-400">
                  <MessageCircle className="h-3 w-3" /> WhatsApp
                </a>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
