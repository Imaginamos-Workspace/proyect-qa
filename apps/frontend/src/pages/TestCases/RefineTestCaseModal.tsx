import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Sparkles, Loader2, AlertCircle, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useRefineTest } from '@/hooks/use-ai';
import type { TestCase } from '@qa/shared-types';

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
  const [changesSummary, setChangesSummary] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const refine = useRefineTest();

  const handleRefine = async () => {
    if (!feedback.trim()) return;
    setError('');
    setDone(false);
    try {
      const res = await refine.mutateAsync({
        test_case_id: testCase.id,
        current_code: testCase.playwright_code,
        feedback: feedback.trim(),
        project_base_url: projectBaseUrl,
      });
      setRefinedCode(res.refined_code);
      setChangesSummary(res.changes_summary || '');
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

          {/* Generate button */}
          <Button
            onClick={handleRefine}
            disabled={!feedback.trim() || refine.isPending}
            className="w-full gap-2 bg-[#7c3aed] hover:bg-[#6d28d9]"
          >
            {refine.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('refineModal.refining')}
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
              {changesSummary && (
                <p className="text-xs italic text-[#065f46]">
                  {changesSummary}
                </p>
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
