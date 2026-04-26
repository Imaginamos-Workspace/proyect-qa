import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Sparkles, Loader2, AlertCircle, Search, Pencil, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useCreateTestCase } from '@/hooks/use-test-cases';
import { useCompleteTestCase } from '@/hooks/use-ai';
import type {
  TestType,
  TestPriority,
  CreateTestCaseDto,
  AICompleteTestResponse,
} from '@qa/shared-types';

/** Resolve a path or URL against a base URL → absolute URL string. */
function resolveUrl(pathOrUrl: string, baseUrl: string): string | null {
  try {
    if (/^https?:\/\//i.test(pathOrUrl)) {
      const u = new URL(pathOrUrl);
      return new URL(u.pathname + u.search, baseUrl).toString();
    }
    return new URL(pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

const TEST_TYPES: TestType[] = [
  'e2e', 'regression', 'visual', 'accessibility',
  'performance', 'api', 'cross_browser', 'responsive',
];

const PRIORITIES: TestPriority[] = ['low', 'medium', 'high', 'critical'];

const DEFAULT_CODE = `import { test, expect } from '@playwright/test';

test('new test', async ({ page }) => {
  await page.goto('/');
});`;

interface Props {
  suiteId: string;
  projectId: string;
  /** Project base URL — enables live DOM scan during AI generation. */
  projectBaseUrl?: string;
  onClose: () => void;
}

type Tab = 'manual' | 'ai';

export function AddTestCaseModal({ suiteId, projectId, projectBaseUrl, onClose }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('manual');

  // ── Manual tab state ────────────────────────────────────────────
  const [manualTitle, setManualTitle] = useState('');
  const [manualDesc, setManualDesc] = useState('');
  const [manualType, setManualType] = useState<TestType>('e2e');
  const [manualPriority, setManualPriority] = useState<TestPriority>('medium');
  const [manualCode, setManualCode] = useState(DEFAULT_CODE);
  const [manualTags, setManualTags] = useState('');

  // ── AI tab state ─────────────────────────────────────────────────
  const [aiSpec, setAiSpec] = useState('');
  const [aiType, setAiType] = useState<TestType>('e2e');
  const [aiPriority, setAiPriority] = useState<TestPriority>('medium');
  const [aiTitle, setAiTitle] = useState('');
  const [aiCode, setAiCode] = useState('');
  const [aiTags, setAiTags] = useState('');
  const [aiError, setAiError] = useState('');
  const [aiGenerated, setAiGenerated] = useState(false);
  const [saveError, setSaveError] = useState('');

  // ── Live scan picker state (mirrors RefineTestCaseModal) ─────────
  const [scanPath, setScanPath] = useState<string>('/');
  const [showPicker, setShowPicker] = useState<boolean>(false);
  const [scanResult, setScanResult] = useState<Pick<
    AICompleteTestResponse,
    'scan_status' | 'scan_url' | 'scan_elements'
  > | null>(null);

  const predictedScanUrl = useMemo(() => {
    if (!projectBaseUrl) return null;
    return resolveUrl(scanPath || '/', projectBaseUrl);
  }, [projectBaseUrl, scanPath]);

  const createTestCase = useCreateTestCase(projectId);
  const completeTestCase = useCompleteTestCase();

  // ── Handlers ─────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!aiSpec.trim()) return;
    setAiError('');
    setAiGenerated(false);
    setScanResult(null);
    try {
      const res = await completeTestCase.mutateAsync({
        project_id: projectId,
        suite_id: suiteId,
        description: aiSpec.trim(),
        test_type: aiType,
        priority: aiPriority,
        base_url: projectBaseUrl,
        scan_url_override: scanPath?.trim() || undefined,
      });
      const tc = res.test_case;
      setAiTitle(tc.title || '');
      setAiCode(tc.playwright_code || '');
      setAiTags((tc.tags || []).join(', '));
      setScanResult({
        scan_status: res.scan_status,
        scan_url: res.scan_url,
        scan_elements: res.scan_elements,
      });
      setAiGenerated(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setAiError(message || t('addTestCaseModal.generationError'));
    }
  };

  const handleSave = () => {
    let dto: CreateTestCaseDto;

    if (tab === 'manual') {
      if (!manualTitle.trim()) return;
      dto = {
        suite_id: suiteId,
        title: manualTitle.trim(),
        description: manualDesc.trim() || undefined,
        test_type: manualType,
        priority: manualPriority,
        playwright_code: manualCode,
        tags: manualTags.split(',').map((s) => s.trim()).filter(Boolean),
      };
    } else {
      if (!aiGenerated || !aiTitle.trim()) return;
      dto = {
        suite_id: suiteId,
        title: aiTitle.trim(),
        description: aiSpec.trim() || undefined,
        test_type: aiType,
        priority: aiPriority,
        playwright_code: aiCode,
        tags: aiTags.split(',').map((s) => s.trim()).filter(Boolean),
      };
    }

    setSaveError('');
    createTestCase.mutate(dto, {
      onSuccess: onClose,
      onError: (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setSaveError(message || t('addTestCaseModal.saveError'));
      },
    });
  };

  const canSave =
    tab === 'manual'
      ? !!manualTitle.trim() && !createTestCase.isPending
      : aiGenerated && !!aiTitle.trim() && !createTestCase.isPending;

  // ── UI ────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-lg font-semibold text-[#1e1b4b]">
            {t('addTestCaseModal.title')}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b shrink-0">
          <button
            onClick={() => setTab('manual')}
            className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'manual'
                ? 'border-[#7c3aed] text-[#7c3aed]'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t('addTestCaseModal.tabManual')}
          </button>
          <button
            onClick={() => setTab('ai')}
            className={`flex items-center gap-1.5 px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'ai'
                ? 'border-[#7c3aed] text-[#7c3aed]'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('addTestCaseModal.tabAI')}
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">

          {tab === 'manual' && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('addTestCaseModal.titleLabel')} *</label>
                <Input
                  placeholder={t('addTestCaseModal.titlePlaceholder')}
                  value={manualTitle}
                  onChange={(e) => setManualTitle(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('addTestCaseModal.descriptionLabel')}</label>
                <Textarea
                  placeholder={t('testCasesPage.descriptionPlaceholder')}
                  value={manualDesc}
                  onChange={(e) => setManualDesc(e.target.value)}
                  rows={2}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('testCasesPage.type')}</label>
                  <select
                    value={manualType}
                    onChange={(e) => setManualType(e.target.value as TestType)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {TEST_TYPES.map((tt) => (
                      <option key={tt} value={tt}>{tt.replace('_', ' ').toUpperCase()}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('testCasesPage.priority')}</label>
                  <select
                    value={manualPriority}
                    onChange={(e) => setManualPriority(e.target.value as TestPriority)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>{p.toUpperCase()}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t('testCasesPage.playwrightCode')}</label>
                <Textarea
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value)}
                  rows={8}
                  className="font-mono text-xs"
                />
              </div>
              <Input
                placeholder={t('addTestCaseModal.tagsPlaceholder')}
                value={manualTags}
                onChange={(e) => setManualTags(e.target.value)}
              />
            </>
          )}

          {tab === 'ai' && (
            <>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t('addTestCaseModal.aiDescriptionLabel')} *
                </label>
                <Textarea
                  placeholder={t('addTestCaseModal.aiDescriptionPlaceholder')}
                  value={aiSpec}
                  onChange={(e) => { setAiSpec(e.target.value); setAiError(''); }}
                  rows={3}
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('testCasesPage.type')}</label>
                  <select
                    value={aiType}
                    onChange={(e) => setAiType(e.target.value as TestType)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {TEST_TYPES.map((tt) => (
                      <option key={tt} value={tt}>{tt.replace('_', ' ').toUpperCase()}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">{t('testCasesPage.priority')}</label>
                  <select
                    value={aiPriority}
                    onChange={(e) => setAiPriority(e.target.value as TestPriority)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>{p.toUpperCase()}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Live scan picker — same UX as RefineTestCaseModal */}
              {projectBaseUrl ? (
                <div className="rounded-md border border-[#bfdbfe] bg-[#eff6ff] p-3 text-xs text-[#1e40af] space-y-2">
                  <div className="flex items-start gap-2">
                    <Search className="h-4 w-4 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium">Escaneo en vivo</p>
                      <p className="mt-0.5">
                        Antes de generar, leeré el DOM real del módulo elegido para que el AI use selectores verdaderos (placeholders, names, ids).
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
                  {predictedScanUrl && (
                    <p className="ml-6 break-all">
                      <span className="font-medium">URL a escanear:</span>{' '}
                      <span className="font-mono text-[#1e3a8a]">{predictedScanUrl}</span>
                    </p>
                  )}
                  {showPicker && (
                    <div className="ml-6 space-y-2 pt-1 border-t border-[#bfdbfe]/60">
                      <div>
                        <p className="font-medium mb-1.5 mt-1.5">Rutas comunes:</p>
                        <div className="flex flex-wrap gap-1.5">
                          {['/', '/login', '/signup', '/dashboard', '/checkout', '/cart', '/profile'].map((p) => {
                            const active = scanPath === p;
                            return (
                              <button
                                key={p}
                                type="button"
                                onClick={() => setScanPath(p)}
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
                      <div>
                        <label className="block font-medium mb-1">
                          O escribe un path o URL personalizada:
                        </label>
                        <Input
                          value={scanPath}
                          onChange={(e) => setScanPath(e.target.value)}
                          placeholder="/checkout"
                          className="text-xs h-8 font-mono bg-white"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-md p-3 text-xs bg-amber-50 border border-amber-200 text-amber-800">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">Escaneo no disponible</p>
                    <p className="mt-0.5">
                      Este proyecto no tiene URL base. Edita el proyecto para activar el escaneo en vivo. El AI generará solo desde tu descripción.
                    </p>
                  </div>
                </div>
              )}

              <Button
                onClick={handleGenerate}
                disabled={!aiSpec.trim() || completeTestCase.isPending}
                className="w-full gap-2 bg-[#7c3aed] hover:bg-[#6d28d9]"
              >
                {completeTestCase.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {projectBaseUrl ? 'Escaneando + generando...' : t('addTestCaseModal.generating')}
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    {t('addTestCaseModal.generateBtn')}
                  </>
                )}
              </Button>

              {aiError && (
                <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{aiError}</span>
                </div>
              )}

              {aiGenerated && (
                <div className="space-y-3 rounded-lg border border-[#7c3aed]/30 bg-[#f5f3ff] p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[#7c3aed]">
                    {t('addTestCaseModal.generatedCodeLabel')}
                  </p>

                  {/* Scan result detail */}
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
                          {scanResult.scan_status === 'scanned' && scanResult.scan_url ? (
                            <>
                              <p className="font-medium text-[#065f46]">✓ Escaneo completado</p>
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
                          ) : (
                            <p className="text-amber-800">
                              {scanResult.scan_status === 'no_base_url'
                                ? 'No se escaneó: el proyecto no tiene URL base.'
                                : 'No se pudo escanear el sitio (timeout, sitio caído, o bloqueo). El AI generó solo desde tu descripción — revisa los selectores antes de guardar.'}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{t('addTestCaseModal.titleLabel')}</label>
                    <Input
                      value={aiTitle}
                      onChange={(e) => setAiTitle(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">{t('testCasesPage.playwrightCode')}</label>
                    <Textarea
                      value={aiCode}
                      onChange={(e) => setAiCode(e.target.value)}
                      rows={10}
                      className="font-mono text-xs bg-white"
                    />
                  </div>
                  <Input
                    placeholder={t('addTestCaseModal.tagsPlaceholder')}
                    value={aiTags}
                    onChange={(e) => setAiTags(e.target.value)}
                    className="bg-white"
                  />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-6 py-4 shrink-0 space-y-3">
          {saveError && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{saveError}</span>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('addTestCaseModal.cancel')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSave}
            className="gap-1.5 bg-[#7c3aed] hover:bg-[#6d28d9]"
          >
            {createTestCase.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('addTestCaseModal.saving')}
              </>
            ) : (
              <>
                <Plus className="h-4 w-4" />
                {t('addTestCaseModal.save')}
              </>
            )}
          </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
