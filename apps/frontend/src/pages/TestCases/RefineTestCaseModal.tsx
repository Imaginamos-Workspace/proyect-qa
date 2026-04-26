import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Sparkles, Loader2, AlertCircle, Check, Search, Globe, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useRefineTest } from '@/hooks/use-ai';
import type { TestCase, AIRefineResponse } from '@qa/shared-types';

/** Extract every distinct page.goto() URL from a test, in order. */
function extractAllGotoPaths(code: string): string[] {
  if (!code) return [];
  const re = /page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/g;
  const seen = new Set<string>();
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const raw = m[1].trim();
    let path: string | null = null;
    if (/^https?:\/\//i.test(raw)) {
      try {
        const u = new URL(raw);
        path = u.pathname + u.search + u.hash;
      } catch {
        path = null;
      }
    } else {
      path = raw.startsWith('/') ? raw : '/' + raw;
    }
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/** Resolve a path or URL against a base URL, returning a clean absolute URL. */
function resolveUrl(pathOrUrl: string, baseUrl: string): string | null {
  try {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      // Absolute → swap host to project base
      const u = new URL(pathOrUrl);
      return new URL(u.pathname + u.search, baseUrl).toString();
    }
    return new URL(pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

interface Props {
  testCase: TestCase;
  /** Project base URL — enables live DOM scan for smarter refine. */
  projectBaseUrl?: string;
  onClose: () => void;
}

const QUICK_SUGGESTIONS = [
  'quickFixSyntax',
  'quickMakeRobust',
  'quickAddAssertions',
  'quickBetterSelectors',
];

export function RefineTestCaseModal({ testCase, projectBaseUrl, onClose }: Props) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState('');
  const [refinedCode, setRefinedCode] = useState('');
  const [scanResult, setScanResult] = useState<Pick<
    AIRefineResponse,
    'changes_summary' | 'scan_status' | 'scan_url' | 'scan_elements'
  > | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const refine = useRefineTest();

  // All distinct goto paths in the test — the user can pick any of them or
  // type a custom path. This makes the scanner truly project-agnostic.
  const detectedPaths = useMemo(
    () => extractAllGotoPaths(testCase.playwright_code || ''),
    [testCase.playwright_code],
  );

  // Selected path for scan: defaults to the first detected goto. The user
  // can pick another from the chip list or type a custom one.
  const [selectedPath, setSelectedPath] = useState<string>(detectedPaths[0] ?? '');
  const [customPath, setCustomPath] = useState<string>('');
  const [showPicker, setShowPicker] = useState<boolean>(false);

  // The effective path that will actually be scanned (custom > selected).
  const effectivePath = customPath.trim() || selectedPath;

  // Predicted full URL — what we'll show in the banner before clicking Refine.
  const predictedScanUrl = useMemo(() => {
    if (!projectBaseUrl || !effectivePath) return null;
    return resolveUrl(effectivePath, projectBaseUrl);
  }, [projectBaseUrl, effectivePath]);

  const handleRefine = async () => {
    if (!feedback.trim()) return;
    setError('');
    setDone(false);
    setScanResult(null);
    try {
      const res = await refine.mutateAsync({
        test_case_id: testCase.id,
        current_code: testCase.playwright_code,
        feedback: feedback.trim(),
        project_base_url: projectBaseUrl,
        // Send the user's choice. If empty, backend falls back to auto-detect.
        scan_url_override: effectivePath || undefined,
      });
      setRefinedCode(res.refined_code);
      setScanResult({
        changes_summary: res.changes_summary || '',
        scan_status: res.scan_status,
        scan_url: res.scan_url,
        scan_elements: res.scan_elements,
      });
      setDone(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || t('refineModal.error'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl rounded-xl bg-white shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-[#7c3aed]" />
            <h2 className="text-lg font-semibold text-[#1e1b4b]">
              {t('refineModal.title')}
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
              {t('refineModal.testCaseLabel')}
            </p>
            <p className="text-sm font-medium text-[#1e1b4b]">{testCase.title}</p>
          </div>

          {/* Current code preview */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('refineModal.currentCode')}</label>
            <pre className="rounded-md bg-[#1e1b4b] p-3 text-xs text-green-400 font-mono overflow-x-auto max-h-48 leading-relaxed">
              {testCase.playwright_code}
            </pre>
          </div>

          {/* Feedback */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('refineModal.feedbackLabel')} *
            </label>
            <Textarea
              placeholder={t('refineModal.feedbackPlaceholder')}
              value={feedback}
              onChange={(e) => { setFeedback(e.target.value); setError(''); setDone(false); }}
              rows={3}
              autoFocus
            />
            {/* Quick suggestions */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {QUICK_SUGGESTIONS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFeedback(t(`refineModal.${key}`))}
                  className="rounded-full border border-[#7c3aed]/30 bg-[#f5f3ff] px-3 py-1 text-xs text-[#7c3aed] hover:bg-[#7c3aed] hover:text-white transition-colors"
                >
                  {t(`refineModal.${key}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Live scan picker — agnostic URL chooser */}
          {!done && projectBaseUrl && (
            <div className="rounded-md border border-[#bfdbfe] bg-[#eff6ff] p-3 text-xs text-[#1e40af] space-y-2">
              <div className="flex items-start gap-2">
                <Search className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-medium">Escaneo en vivo</p>
                  <p className="mt-0.5">
                    Antes de mejorar, leeré el DOM real de la URL elegida para que el AI use selectores verdaderos.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPicker((s) => !s)}
                  className="shrink-0 inline-flex items-center gap-1 rounded-md border border-[#bfdbfe] bg-white px-2 py-1 text-[11px] font-medium text-[#1e40af] hover:bg-[#dbeafe] transition-colors"
                >
                  <Pencil className="h-3 w-3" />
                  {showPicker ? 'Ocultar' : 'Cambiar URL'}
                </button>
              </div>

              {predictedScanUrl ? (
                <p className="ml-6 break-all">
                  <span className="font-medium">URL a escanear:</span>{' '}
                  <span className="font-mono text-[#1e3a8a]">{predictedScanUrl}</span>
                </p>
              ) : (
                <p className="ml-6 text-amber-800">
                  Selecciona o escribe una URL/path para escanear ↓
                </p>
              )}

              {/* Picker: chips of detected paths + custom input */}
              {(showPicker || !predictedScanUrl) && (
                <div className="ml-6 space-y-2 pt-1 border-t border-[#bfdbfe]/60">
                  {detectedPaths.length > 0 && (
                    <div>
                      <p className="font-medium mb-1.5 mt-1.5">URLs detectadas en el test:</p>
                      <div className="flex flex-wrap gap-1.5">
                        {detectedPaths.map((p) => {
                          const active = !customPath && selectedPath === p;
                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => { setSelectedPath(p); setCustomPath(''); }}
                              className={`rounded-full px-2.5 py-1 text-[11px] font-mono transition-colors ${
                                active
                                  ? 'bg-[#1e40af] text-white'
                                  : 'bg-white border border-[#bfdbfe] text-[#1e40af] hover:bg-[#dbeafe]'
                              }`}
                            >
                              {p}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="block font-medium mb-1">
                      O escribe un path o URL personalizada:
                    </label>
                    <Input
                      value={customPath}
                      onChange={(e) => setCustomPath(e.target.value)}
                      placeholder="/checkout o https://example.com/checkout"
                      className="text-xs h-8 font-mono bg-white"
                    />
                    <p className="mt-1 opacity-70">
                      Útil si el módulo se renderiza tras login o en otra ruta. Se resuelve contra la URL base del proyecto.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Banner when scan is impossible (no base URL) */}
          {!done && !projectBaseUrl && (
            <div className="flex items-start gap-2 rounded-md p-3 text-xs bg-amber-50 border border-amber-200 text-amber-800">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium">Escaneo no disponible</p>
                <p className="mt-0.5">
                  Este proyecto no tiene URL base. Edita el proyecto para activar el escaneo en vivo. El AI mejorará solo con tu feedback.
                </p>
              </div>
            </div>
          )}

          {/* Generate button */}
          <Button
            onClick={handleRefine}
            disabled={!feedback.trim() || refine.isPending}
            className="w-full gap-2 bg-[#7c3aed] hover:bg-[#6d28d9]"
          >
            {refine.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {predictedScanUrl ? 'Escaneando sitio + refinando...' : t('refineModal.refining')}
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                {t('refineModal.refineBtn')}
              </>
            )}
          </Button>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Success preview */}
          {done && refinedCode && (
            <div className="space-y-2 rounded-lg border border-[#10b981]/30 bg-[#f0fdf4] p-4">
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-[#10b981]" />
                <p className="text-sm font-semibold text-[#065f46]">
                  {t('refineModal.success')}
                </p>
              </div>
              <p className="text-xs text-[#047857]">
                {t('refineModal.successHint')}
              </p>

              {/* Scan result detail card */}
              {scanResult && (
                <div className={`rounded-md border p-3 text-xs ${
                  scanResult.scan_status === 'scanned'
                    ? 'border-[#10b981]/40 bg-white'
                    : 'border-amber-200 bg-amber-50'
                }`}>
                  <div className="flex items-start gap-2">
                    {scanResult.scan_status === 'scanned' ? (
                      <Globe className="h-4 w-4 mt-0.5 shrink-0 text-[#10b981]" />
                    ) : (
                      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
                    )}
                    <div className="flex-1 min-w-0">
                      {scanResult.scan_status === 'scanned' && scanResult.scan_url && (
                        <>
                          <p className="font-medium text-[#065f46]">
                            ✓ Escaneo completado
                          </p>
                          <p className="mt-0.5 break-all font-mono text-[#047857]">
                            {scanResult.scan_url}
                          </p>
                          {scanResult.scan_elements && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              <span className="rounded-full bg-[#dcfce7] px-2 py-0.5 text-[#065f46]">
                                {scanResult.scan_elements.forms} forms
                              </span>
                              <span className="rounded-full bg-[#dcfce7] px-2 py-0.5 text-[#065f46]">
                                {scanResult.scan_elements.inputs} inputs
                              </span>
                              <span className="rounded-full bg-[#dcfce7] px-2 py-0.5 text-[#065f46]">
                                {scanResult.scan_elements.buttons} buttons
                              </span>
                              <span className="rounded-full bg-[#dcfce7] px-2 py-0.5 text-[#065f46]">
                                {scanResult.scan_elements.links} links
                              </span>
                            </div>
                          )}
                        </>
                      )}
                      {scanResult.scan_status !== 'scanned' && (
                        <p className="text-amber-800">{scanResult.changes_summary}</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <pre className="rounded-md bg-[#1e1b4b] p-3 text-xs text-green-400 font-mono overflow-x-auto max-h-64 leading-relaxed">
                {refinedCode}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4 shrink-0">
          <Button variant="outline" onClick={onClose}>
            {done ? t('refineModal.close') : t('refineModal.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
