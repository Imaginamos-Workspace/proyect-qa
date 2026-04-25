import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useProjects, useDeleteProject } from '@/hooks/use-projects';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Plus,
  Search,
  ExternalLink,
  Trash2,
  Globe,
  Eye,
  Layers,
  Play,
  Settings2,
} from 'lucide-react';
import { EditProjectModal } from './EditProjectModal';
import type { Project } from '@qa/shared-types';

const envBorderColor: Record<string, string> = {
  development: '#8b5cf6',
  staging: '#f59e0b',
  production: '#10b981',
};

const envBadgeVariant: Record<string, 'info' | 'warning' | 'success'> = {
  development: 'info',
  staging: 'warning',
  production: 'success',
};

export function ProjectsPage() {
  const { t } = useTranslation();
  const { data: projects, isLoading } = useProjects();
  const deleteProject = useDeleteProject();
  const [search, setSearch] = useState('');
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  const filtered = projects?.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.base_url.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-[#1e1b4b]">{t('projects.title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('projects.subtitle')}
          </p>
        </div>
        <Link to="/projects/new">
          <Button className="bg-[#7c3aed] hover:bg-[#7c3aed]/90">
            <Plus className="mr-2 h-4 w-4" />
            {t('projects.newProject')}
          </Button>
        </Link>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t('projects.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10 bg-white focus:bg-[#f5f3ff]"
        />
      </div>

      {/* Content */}
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t('projects.loading')}</p>
      ) : filtered?.length === 0 ? (
        <div className="py-12 text-center">
          <Globe className="mx-auto mb-4 h-12 w-12 text-muted-foreground/50" />
          <p className="text-muted-foreground">
            {search ? t('projects.noProjectsMatch') : t('projects.noProjectsYet')}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filtered?.map((project) => {
            const borderColor = envBorderColor[project.environment] || '#878a99';
            const badgeVariant = envBadgeVariant[project.environment] || 'secondary';

            return (
              <Card
                key={project.id}
                className="overflow-hidden transition-shadow hover:shadow-md"
                style={{ borderLeft: `4px solid ${borderColor}` }}
              >
                <CardContent className="p-5">
                  {/* Title + badge */}
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <Link
                      to={`/projects/${project.id}`}
                      className="text-base font-semibold text-[#1e1b4b] hover:text-[#7c3aed]"
                    >
                      {project.name}
                    </Link>
                    <Badge variant={badgeVariant} className="shrink-0 capitalize">
                      {project.environment}
                    </Badge>
                  </div>

                  {/* URL */}
                  <a
                    href={project.base_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-[#7c3aed]"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="truncate">{project.base_url}</span>
                  </a>

                  {/* Mini stats */}
                  <div className="mb-4 flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Layers className="h-3 w-3" />
                      {t('projects.suites')}
                    </span>
                    <span className="flex items-center gap-1">
                      <Play className="h-3 w-3" />
                      {t('projects.runs')}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-between border-t pt-3">
                    <div className="flex items-center gap-1">
                      <Link to={`/projects/${project.id}`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 gap-1.5 text-xs font-medium text-[#7c3aed] hover:bg-[rgba(124,58,237,0.1)]"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          {t('projects.view')}
                        </Button>
                      </Link>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 gap-1.5 text-xs text-muted-foreground hover:bg-[rgba(124,58,237,0.08)] hover:text-[#7c3aed]"
                        onClick={() => setEditingProject(project)}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                        {t('editProject.editBtn')}
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 gap-1.5 text-xs text-muted-foreground hover:bg-[rgba(239,68,68,0.1)] hover:text-[#ef4444]"
                      onClick={() => {
                        if (confirm(t('projects.deleteConfirm'))) {
                          deleteProject.mutate(project.id);
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('projects.delete')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Edit modal */}
      {editingProject && (
        <EditProjectModal
          project={editingProject}
          onClose={() => setEditingProject(null)}
        />
      )}
    </div>
  );
}
