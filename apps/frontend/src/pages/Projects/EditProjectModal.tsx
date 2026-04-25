import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Save, Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useUpdateProject } from '@/hooks/use-projects';
import type { Project } from '@qa/shared-types';

// Styled native select that matches the Input component look
function StyledSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {children}
    </select>
  );
}

interface Props {
  project: Project;
  onClose: () => void;
}

export function EditProjectModal({ project, onClose }: Props) {
  const { t } = useTranslation();
  const update = useUpdateProject();

  const [name, setName] = useState(project.name);
  const [baseUrl, setBaseUrl] = useState(project.base_url ?? '');
  const [environment, setEnvironment] = useState<'development' | 'staging' | 'production'>(
    project.environment ?? 'production',
  );
  const [projectType, setProjectType] = useState<string>(project.project_type ?? '');
  const [description, setDescription] = useState(project.description ?? '');
  const [error, setError] = useState('');

  // Reset form if project changes
  useEffect(() => {
    setName(project.name);
    setBaseUrl(project.base_url ?? '');
    setEnvironment(project.environment ?? 'production');
    setProjectType(project.project_type ?? '');
    setDescription(project.description ?? '');
    setError('');
  }, [project]);

  const handleSave = async () => {
    if (!name.trim()) { setError(t('editProject.nameRequired')); return; }
    if (!baseUrl.trim()) { setError(t('editProject.baseUrlRequired')); return; }

    setError('');
    try {
      await update.mutateAsync({
        id: project.id,
        dto: {
          name: name.trim(),
          base_url: baseUrl.trim(),
          environment,
          project_type: (projectType as Project['project_type']) || undefined,
          description: description.trim() || undefined,
        },
      });
      onClose();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || t('editProject.saveError'));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
          <h2 className="text-lg font-semibold text-[#1e1b4b]">{t('editProject.title')}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">

          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('editProject.nameLabel')} <span className="text-destructive">*</span>
            </label>
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder={t('editProject.namePlaceholder')}
              autoFocus
            />
          </div>

          {/* Base URL */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('editProject.baseUrlLabel')} <span className="text-destructive">*</span>
            </label>
            <Input
              value={baseUrl}
              onChange={(e) => { setBaseUrl(e.target.value); setError(''); }}
              placeholder="https://miapp.com"
              type="url"
            />
            <p className="text-xs text-muted-foreground">{t('editProject.baseUrlHint')}</p>
          </div>

          {/* Environment */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('editProject.environmentLabel')}</label>
            <StyledSelect
              value={environment}
              onChange={(v: string) => setEnvironment(v as typeof environment)}
            >
              <option value="development">{t('wizard.step1.envDevelopment')}</option>
              <option value="staging">{t('wizard.step1.envStaging')}</option>
              <option value="production">{t('wizard.step1.envProduction')}</option>
            </StyledSelect>
          </div>

          {/* Project type */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('editProject.projectTypeLabel')}</label>
            <StyledSelect
              value={projectType || ''}
              onChange={(v: string) => setProjectType(v)}
            >
              <option value="">{t('editProject.noType')}</option>
              <option value="web_app">{t('wizard.step1.typeWebApp')}</option>
              <option value="ecommerce">{t('wizard.step1.typeEcommerce')}</option>
              <option value="saas">{t('wizard.step1.typeSaas')}</option>
              <option value="landing_page">{t('wizard.step1.typeLandingPage')}</option>
              <option value="mobile_web">{t('wizard.step1.typeMobileWeb')}</option>
              <option value="api">{t('wizard.step1.typeApi')}</option>
              <option value="custom">{t('wizard.step1.typeCustom')}</option>
            </StyledSelect>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{t('editProject.descriptionLabel')}</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('wizard.step1.descriptionPlaceholder')}
              rows={3}
            />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4 shrink-0">
          <Button variant="outline" onClick={onClose} disabled={update.isPending}>
            {t('editProject.cancel')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={update.isPending || !name.trim() || !baseUrl.trim()}
            className="gap-2 bg-[#7c3aed] hover:bg-[#6d28d9]"
          >
            {update.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('editProject.saving')}
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                {t('editProject.save')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
