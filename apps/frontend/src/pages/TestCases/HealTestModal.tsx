import { useState } from 'react';
import { X, Sparkles, Copy, Check, Terminal, AlertCircle, Wand2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useHealToken } from '@/hooks/use-ai';
import {
  buildHealMacCommand,
  buildHealWindowsCommand,
} from '@/lib/heal-command-builder';
import type { TestCase } from '@qa/shared-types';

interface Props {
  testCase: TestCase;
  /** Project base URL — required for the heal Playwright config. */
  projectBaseUrl?: string;
  onClose: () => void;
}

/**
 * "Probar y auto-arreglar" — shows a copy-paste command that runs the test
 * locally via Playwright. On each failure it captures the live DOM, calls
 * /ai/heal-iterate (with a scoped HMAC token), retrieves healed code, and
 * retries up to 3 times. The user watches the heal happen in real time.
 */
export function HealTestModal({ testCase, projectBaseUrl, onClose }: Props) {
  // /api suffix is part of the api client baseURL; heal-loop.mjs will append it.
  const backendUrlRaw = (
    import.meta.env.VITE_API_URL || 'https://qa-backend-theta.vercel.app/api'
  ).trim();
  const backendUrl = backendUrlRaw.replace(/\/api\/?$/, '');

  const [os, setOs] = useState<'mac' | 'windows'>(() =>
    /Win/i.test(navigator.platform) ? 'windows' : 'mac',
  );
  const [copied, setCopied] = useState(false);

  const canHeal = !!projectBaseUrl;

  const { data: tokenData, isLoading: tokenLoading, isError: tokenError, error } =
    useHealToken(canHeal ? testCase.id : null);

  const command =
    canHeal && tokenData
      ? os === 'mac'
        ? buildHealMacCommand({
            testCaseId: testCase.id,
            healToken: tokenData.token,
            backendUrl,
            projectBaseUrl: projectBaseUrl!,
          })
        : buildHealWindowsCommand({
            testCaseId: testCase.id,
            healToken: tokenData.token,
            backendUrl,
            projectBaseUrl: projectBaseUrl!,
          })
      : '';

  const expiresInMinutes = tokenData
    ? Math.max(0, Math.round((tokenData.expires_at * 1000 - Date.now()) / 60000))
    : 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl rounded-xl bg-white shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Wand2 className="h-5 w-5 text-[#7c3aed]" />
            <h2 className="text-lg font-semibold text-[#1e1b4b]">
              Probar y auto-arreglar
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
              Caso de prueba
            </p>
            <p className="text-sm font-medium text-[#1e1b4b]">{testCase.title}</p>
          </div>

          {/* Explanation */}
          <div className="rounded-md border border-[#e9d5ff] bg-[#faf5ff] p-3 text-xs text-[#5b21b6] space-y-1.5">
            <div className="flex items-start gap-2">
              <Sparkles className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Cómo funciona el auto-arreglo</p>
                <p className="mt-1">
                  El comando descarga el test, lo corre con Playwright en tu máquina,
                  y si <strong>falla</strong>:
                </p>
                <ol className="mt-1 ml-4 list-decimal space-y-0.5">
                  <li>Captura el <strong>DOM real estructurado</strong> de la página al momento del fallo (inputs, botones, links, mensajes).</li>
                  <li>Lo envía a la IA junto con el error y los selectores que ya fallaron.</li>
                  <li>La IA regenera el test usando solo selectores presentes en el DOM.</li>
                  <li>Backend valida que ningún selector haya sido inventado; si los hay, regenera.</li>
                  <li>Reintenta — hasta 3 iteraciones, con abort temprano si el mismo selector falla 2 veces.</li>
                </ol>
                <p className="mt-1.5">
                  La diferencia clave: el motor que escanea = el motor que ejecuta. No hay
                  más selectores inventados.
                </p>
              </div>
            </div>
          </div>

          {!canHeal && (
            <div className="flex items-start gap-2 rounded-md p-3 text-xs bg-amber-50 border border-amber-200 text-amber-800">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">Falta URL base del proyecto</p>
                <p className="mt-0.5">
                  Edita el proyecto y agrega la URL base para activar este modo.
                </p>
              </div>
            </div>
          )}

          {canHeal && tokenLoading && (
            <div className="flex items-center gap-2 rounded-md p-3 text-xs bg-blue-50 border border-blue-200 text-blue-800">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Generando token de seguridad…</span>
            </div>
          )}

          {canHeal && tokenError && (
            <div className="flex items-start gap-2 rounded-md p-3 text-xs bg-red-50 border border-red-200 text-red-800">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">No se pudo emitir el token</p>
                <p className="mt-0.5">{(error as Error)?.message || 'Reintenta cerrando y abriendo el modal.'}</p>
              </div>
            </div>
          )}

          {/* OS toggle */}
          {canHeal && tokenData && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Sistema:
                </span>
                <div className="inline-flex rounded-md border border-input overflow-hidden">
                  <button
                    onClick={() => setOs('mac')}
                    className={`px-3 py-1 text-xs font-medium transition-colors ${
                      os === 'mac'
                        ? 'bg-[#7c3aed] text-white'
                        : 'bg-white text-[#1e1b4b] hover:bg-muted'
                    }`}
                  >
                    Mac / Linux
                  </button>
                  <button
                    onClick={() => setOs('windows')}
                    className={`px-3 py-1 text-xs font-medium transition-colors ${
                      os === 'windows'
                        ? 'bg-[#7c3aed] text-white'
                        : 'bg-white text-[#1e1b4b] hover:bg-muted'
                    }`}
                  >
                    Windows
                  </button>
                </div>
              </div>
              <span className="text-[11px] text-muted-foreground">
                Token válido por {expiresInMinutes} min
              </span>
            </div>
          )}

          {/* Command */}
          {canHeal && tokenData && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                  <Terminal className="h-3.5 w-3.5" />
                  Pega esto en tu terminal
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={copy}
                  className="h-7 gap-1.5 text-xs"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      Copiado
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copiar
                    </>
                  )}
                </Button>
              </div>
              <pre className="rounded-md bg-[#1e1b4b] p-3 text-xs text-green-400 font-mono overflow-x-auto max-h-64 leading-relaxed whitespace-pre-wrap break-all">
                {command}
              </pre>
              <p className="text-[11px] text-muted-foreground">
                Antes de pegar: asegúrate de que <code className="bg-muted px-1 rounded">generated-tests.spec.ts</code> está
                en tu carpeta <strong>~/Downloads</strong> (descárgalo desde la lista de tests).
              </p>
            </div>
          )}

          {/* Footer note */}
          {canHeal && tokenData && (
            <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1">
              <p className="font-medium">Lo que verás en la terminal:</p>
              <ul className="list-disc ml-4 space-y-0.5 text-muted-foreground">
                <li>▶️  Ejecutando test...</li>
                <li>📸 DOM estructurado: N input(s), M botón(es), K form(s)</li>
                <li>🎯 Selector que falló: input[name="..."]</li>
                <li>📡 Pidiendo a la IA que regenere...</li>
                <li>✏️  Iteración X: regeneré con el DOM real capturado</li>
                <li>🔄 Reintentando con código auto-arreglado...</li>
                <li>✅ Test pasó tras N iteración(es)</li>
              </ul>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t shrink-0">
          <Button variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
      </div>
    </div>
  );
}
