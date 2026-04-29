-- Test Suggestions: AI-proposed test scenarios that the user can review,
-- convert into real test cases, or dismiss. Suggestions are organized by
-- detected site section (login, checkout, products, etc.) and persist
-- everything the AI inferred (module URL, what/how to test, etc.) so the
-- conversion step can reuse the existing live-DOM scan + complete-test-case
-- flow without re-asking the AI from scratch.

CREATE TABLE public.test_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- Section the AI detected the page/feature belongs to. Free text but
  -- in practice maps to common conventions: "Login", "Checkout",
  -- "Productos", "Contacto", "Perfil", etc. Used for UI grouping.
  section TEXT NOT NULL,

  -- The path on the configured base_url where this scenario lives.
  -- Used as scan_url_override when the user converts to a real case.
  scan_url TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT NOT NULL,
  what_to_test TEXT NOT NULL,
  how_to_test TEXT NOT NULL,

  test_type TEXT NOT NULL DEFAULT 'e2e' CHECK (test_type IN (
    'e2e', 'regression', 'visual', 'accessibility',
    'performance', 'api', 'cross_browser', 'responsive'
  )),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN (
    'low', 'medium', 'high', 'critical'
  )),

  -- Lifecycle:
  --   pending   → fresh, awaiting user action
  --   converted → user clicked "Convertir en escenario", FK populated
  --   dismissed → user clicked "Descartar"
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'converted', 'dismissed'
  )),
  dismissed_at TIMESTAMPTZ,
  converted_test_case_id UUID REFERENCES public.test_cases(id) ON DELETE SET NULL,

  -- Free-form metadata captured during exploration that the conversion
  -- step may want (detected element counts, button labels, hints, etc.).
  ai_metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_test_suggestions_project_id ON public.test_suggestions(project_id);
CREATE INDEX idx_test_suggestions_status ON public.test_suggestions(status);
CREATE INDEX idx_test_suggestions_section ON public.test_suggestions(section);

CREATE TRIGGER test_suggestions_updated_at
  BEFORE UPDATE ON public.test_suggestions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: same pattern as test_cases — owner of the project can do anything.
ALTER TABLE public.test_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own test_suggestions"
  ON public.test_suggestions FOR SELECT
  USING (public.user_owns_project(project_id));
CREATE POLICY "Users can insert own test_suggestions"
  ON public.test_suggestions FOR INSERT
  WITH CHECK (public.user_owns_project(project_id));
CREATE POLICY "Users can update own test_suggestions"
  ON public.test_suggestions FOR UPDATE
  USING (public.user_owns_project(project_id));
CREATE POLICY "Users can delete own test_suggestions"
  ON public.test_suggestions FOR DELETE
  USING (public.user_owns_project(project_id));
