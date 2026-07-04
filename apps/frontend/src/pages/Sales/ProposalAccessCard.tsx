import { useState } from 'react';
import { Copy, Check, ExternalLink, MessageCircle, Mail, FileText, Info } from 'lucide-react';
import { useProposalAccess } from '@/hooks/use-sales';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button variant="outline" size="sm" onClick={copy} title={`Copiar ${label}`}>
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

export function ProposalAccessCard({ id, cliente, oportunidad }: { id: string; cliente: string; oportunidad: string }) {
  const { data, isLoading } = useProposalAccess(id);

  if (isLoading || !data) return null;

  if (!data.generated) {
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

  const shareText = `Propuesta de ${cliente} — ${oportunidad}\n${data.url}\nContraseña: ${data.password}`;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <FileText className="h-3.5 w-3.5" /> Propuesta generada
        </p>

        <div className="flex items-center gap-2">
          <a
            href={data.url}
            target="_blank"
            rel="noreferrer"
            className="flex-1 truncate rounded-md border border-input bg-background px-3 py-2 text-sm text-primary hover:underline"
          >
            {data.url}
          </a>
          <CopyButton value={data.url} label="link" />
          <Button variant="outline" size="icon" asChild title="Abrir propuesta">
            <a href={data.url} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /></a>
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="flex-1 rounded-md border border-input bg-background px-3 py-2 font-mono text-sm">
            {data.password}
          </span>
          <CopyButton value={data.password} label="contraseña" />
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" className="flex-1" asChild>
            <a href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer">
              <MessageCircle className="mr-2 h-4 w-4" /> WhatsApp
            </a>
          </Button>
          <Button variant="outline" size="sm" className="flex-1" asChild>
            <a href={`mailto:?subject=${encodeURIComponent(`Propuesta — ${cliente}`)}&body=${encodeURIComponent(shareText)}`}>
              <Mail className="mr-2 h-4 w-4" /> Correo
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
