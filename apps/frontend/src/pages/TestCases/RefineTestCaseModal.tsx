import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Sparkles, Loader2, AlertCircle, Check, Search, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useRefineTest } from '@/hooks/use-ai';
import type { TestCase, AIRefineResponse } from '@qa/shared-types';

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

  // Predict the URL the backend will scan, so we can show "Escaneando X..."
  // immediately when the user clicks Refine.
  const predictedScanUrl = (() => {
    if (!projectBaseUrl) return null;
    const m = testCase.playwright_code?.match(/page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/);
    if (!m) return null;
    const raw = m[1].trim();
    try {
      // Absolute → use its path with the project's base host
      if (/^https?:\/\//i.test(raw)) {
        const u = new URL(raw);
        return new URL(u.pathname + u.search, projectBaseUrl).toString();
      }
      // Relative
      return new URL(raw.startsWith('/') ? raw : '/' + raw, projectBaseUrl).toString();
    } catch {
      return null;
    }
  })();

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

          {/* Live scan info — pre-flight banner so the user knows what will be scanned */}
          {!done && (
            <div className={`flex items-start gap-2 rounded-md p-3 text-xs ${
              predictedScanUrl
                ? 'bg-[#eff6ff] border border-[#bfdbfe] text-[#1e40af]'
                : 'bg-amber-50 border border-amber-200 text-amber-800'
            }`}>
              {predictedScanUrl ? (
                <>
                  <Search className="h-4 w-4 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">Escaneo en vivo activado</p>
                    <p className="mt-0.5 break-all">
                      Antes de mejorar, leeré el DOM de:{' '}
                      <span className="font-mono text-[#1e3a8a]">{predictedScanUrl}</span>
                    </p>
                    <p className="mt-1 opacity-80">
                      El AI usará los selectores reales del sitio (placeholders, names, ids).
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">Escaneo no disponible</p>
                    <p className="mt-0.5">
                      {!projectBaseUrl
                        ? 'Este proyecto no tiene URL base. Edita el proyecto para activar el escaneo en vivo.'
                        : 'No hay page.goto() en el test — no sé qué URL escanear. El AI mejorará solo con tu feedback.'}
                    </p>
                  </div>
                </>
              )}
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
