import { useState } from 'react';
import { Check, Copy, Globe, KeyRound, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Credentials } from '@/hooks/use-dashboard';

/**
 * Panel de CREDENCIALES Y ENTORNOS del cliente. Muestra, abiertas, las URLs de
 * cada entorno (dev/qa…), las URLs base/API y el catálogo de usuarios de prueba
 * (QA_USERS), con botón de copiar. El portal está tras login de lista blanca, así
 * que se muestran en claro a propósito (decisión de producto). Lo alimenta el
 * monorepo con `qa:creds-sync` (lee projects/<c>/.env + project.meta.json).
 */
export function ClientCredentials({ credentials }: { credentials?: Credentials }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle>Credenciales y entornos</CardTitle></CardHeader>
      <CardContent>
        <CredentialsBody credentials={credentials} />
      </CardContent>
    </Card>
  );
}

/** Cuerpo de credenciales SIN Card, para anidar en el widget de regresión colapsable. */
export function CredentialsBody({ credentials }: { credentials?: Credentials }) {
  const hasEnvs = credentials && credentials.environments && Object.keys(credentials.environments).length > 0;
  const hasUsers = credentials && credentials.qa_users && credentials.qa_users.length > 0;
  const hasBase = credentials && (credentials.base_url || credentials.api_url);

  if (!credentials || (!hasEnvs && !hasUsers && !hasBase)) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no se sincronizaron las credenciales de este cliente. El QA las publica con{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">npm run qa:creds-sync -- &lt;cliente&gt;</code>.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {/* URLs base / API (del .env) */}
        {hasBase && (
          <Section icon={Globe} title="URLs">
            <div className="space-y-1.5">
              {credentials!.base_url && <UrlRow label="App (BASE_URL)" url={credentials!.base_url} />}
              {credentials!.api_url && <UrlRow label="API (API_URL)" url={credentials!.api_url} />}
            </div>
          </Section>
        )}

        {/* Entornos (de project.meta.json) */}
        {hasEnvs && (
          <Section icon={Globe} title="Entornos">
            <div className="space-y-3">
              {Object.entries(credentials!.environments!).map(([env, urls]) => (
                <div key={env}>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{env}</div>
                  <div className="space-y-1.5">
                    {Object.entries(urls).map(([k, v]) => (
                      <UrlRow key={k} label={k} url={v} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* Usuarios de prueba (QA_USERS) — en claro */}
        {hasUsers && (
          <Section icon={Users} title={`Usuarios de prueba (${credentials!.qa_users!.length})`}>
            <div className="space-y-2">
              {credentials!.qa_users!.map((u, i) => (
                <div key={`${u.username}-${i}`} className="rounded-lg border border-border p-2.5">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                      {u.alias || u.username}
                    </span>
                    {u.role && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {u.role}
                      </span>
                    )}
                  </div>
                  <Field label="Usuario" value={u.username} />
                  <Field label="Contraseña" value={u.password} mono />
                </div>
              ))}
            </div>
          </Section>
        )}

        {credentials!.updated_at && (
          <p className="text-[10px] text-muted-foreground">
            Sincronizado {new Date(credentials!.updated_at).toLocaleString()}
          </p>
        )}
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Globe; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </div>
      {children}
    </div>
  );
}

function UrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-28 shrink-0 truncate text-xs text-muted-foreground" title={label}>{label}</span>
      <a href={url} target="_blank" rel="noreferrer" className="flex-1 truncate text-primary hover:underline" title={url}>
        {url}
      </a>
      <CopyButton value={url} />
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-sm">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`flex-1 truncate ${mono ? 'font-mono text-xs' : ''}`} title={value}>{value}</span>
      <CopyButton value={value} />
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard no disponible (http/permiso) — silencioso */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copiar"
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
