/**
 * Generación asistida de la NARRATIVA de la propuesta (proposal.html) desde el
 * brief + los tiers. El template deja el contenido narrativo como instrucciones
 * entre paréntesis —"(Funcionalidad 1)", "(Qué obtiene el cliente…)"— que
 * alguien debía reemplazar a mano leyendo el brief. Ese paso no ocurría y la
 * propuesta se publicaba con los placeholders a la vista del cliente (caso
 * colsaisa). Acá el backend (donde vive GEMINI_API_KEY) genera ese contenido y
 * lo inyecta; el vendedor lo revisa antes de enviarlo al cliente (rules/13).
 *
 * Este módulo es PURO (sin red ni FS) para poder testear el prompt y la
 * inyección sin Gemini: la llamada al modelo y el commit viven en el service.
 */

/** Forma del JSON que pedimos al modelo. Campos client-facing, español neutro. */
export interface ProposalNarrative {
  heroSub: string;
  problema: { callout: string; bullets: [string, string, string] };
  objetivos: [ObjetivoItem, ObjetivoItem, ObjetivoItem, ObjetivoItem];
  solucion: {
    callout: string;
    mvp: { entrega: string; sirve: string };
    crecimiento: { entrega: string; sirve: string };
  };
  vistaPrevia: { uno: string; dos: string };
  incluye: [string, string];
  noIncluye: [string, string];
  tiers: {
    economica: { for: string; ideal: string };
    media: { for: string; diff: string };
    solida: { for: string; diff: string };
  };
  asunciones: [string, string, string, string];
  riesgos: [string, string];
}

interface ObjetivoItem {
  titulo: string;
  detalle: string;
}

/** Placeholder EXACTO del template → función que saca su valor del JSON. El
 *  match es por string literal (replaceAll), así que estos deben coincidir
 *  carácter por carácter con sales/templates/proposal.html. */
const PLACEHOLDER_MAP: { ph: string; get: (n: ProposalNarrative) => string }[] = [
  { ph: '(Una frase: qué construimos para resolver el problema, en lenguaje cliente.)', get: (n) => n.heroSub },
  { ph: '(Una frase: qué le duele al cliente, a quién, cuánto.)', get: (n) => n.problema.callout },
  { ph: '(Dato concreto que cuantifica el dolor)', get: (n) => n.problema.bullets[0] },
  { ph: '(Consecuencia de no resolverlo en 6-12 meses)', get: (n) => n.problema.bullets[1] },
  { ph: '(Lo que el cliente ya intentó y por qué no funcionó)', get: (n) => n.problema.bullets[2] },
  { ph: '(Objetivo 1 · título)', get: (n) => n.objetivos[0].titulo },
  { ph: '(Objetivo 1 · qué gana el cliente)', get: (n) => n.objetivos[0].detalle },
  { ph: '(Objetivo 2 · título)', get: (n) => n.objetivos[1].titulo },
  { ph: '(Objetivo 2 · qué gana el cliente)', get: (n) => n.objetivos[1].detalle },
  { ph: '(Objetivo 3 · título)', get: (n) => n.objetivos[2].titulo },
  { ph: '(Objetivo 3 · qué gana el cliente)', get: (n) => n.objetivos[2].detalle },
  { ph: '(Objetivo 4 · título)', get: (n) => n.objetivos[3].titulo },
  { ph: '(Objetivo 4 · qué gana el cliente)', get: (n) => n.objetivos[3].detalle },
  { ph: '(Una frase: qué construimos para resolver ese problema.)', get: (n) => n.solucion.callout },
  { ph: '(Producto mínimo funcional)', get: (n) => n.solucion.mvp.entrega },
  { ph: '(Resultado concreto en su día a día)', get: (n) => n.solucion.mvp.sirve },
  { ph: '(Funcionalidades + escala)', get: (n) => n.solucion.crecimiento.entrega },
  { ph: '(Resultado adicional medible)', get: (n) => n.solucion.crecimiento.sirve },
  { ph: '(Un párrafo corto: qué hace el cliente en esta pantalla/app concretamente, y qué gana con eso.)', get: (n) => n.vistaPrevia.uno },
  { ph: '(Un párrafo corto: qué resuelve la app móvil/segunda pieza del sistema, en lenguaje cliente.)', get: (n) => n.vistaPrevia.dos },
  { ph: '(Funcionalidad 1)', get: (n) => n.incluye[0] },
  { ph: '(Funcionalidad 2)', get: (n) => n.incluye[1] },
  { ph: '(Cosa que el cliente podría suponer incluida)', get: (n) => n.noIncluye[0] },
  { ph: '(Otra cosa)', get: (n) => n.noIncluye[1] },
  { ph: '(Qué obtiene el cliente concretamente, en su lenguaje.)', get: (n) => n.tiers.economica.for },
  { ph: '(tipo de cliente para el que es la mejor)', get: (n) => n.tiers.economica.ideal },
  { ph: '(Qué obtiene — más rico que la económica.)', get: (n) => n.tiers.media.for },
  { ph: '(2-3 capacidades adicionales)', get: (n) => n.tiers.media.diff },
  { ph: '(Qué obtiene — la versión completa.)', get: (n) => n.tiers.solida.for },
  { ph: '(las capacidades premium)', get: (n) => n.tiers.solida.diff },
  { ph: '(Asunción 1)', get: (n) => n.asunciones[0] },
  { ph: '(Asunción 2)', get: (n) => n.asunciones[1] },
  { ph: '(Asunción 3)', get: (n) => n.asunciones[2] },
  { ph: '(Asunción 4)', get: (n) => n.asunciones[3] },
  { ph: '(Riesgo 1 y cómo lo manejamos)', get: (n) => n.riesgos[0] },
  { ph: '(Riesgo 2 y cómo lo manejamos)', get: (n) => n.riesgos[1] },
];

/** ¿El HTML todavía tiene placeholders narrativos del template? Sirve para NO
 *  regenerar (ni pisar) una propuesta que el vendedor ya revisó y llenó. */
export function hasNarrativePlaceholders(html: string): boolean {
  return PLACEHOLDER_MAP.some(({ ph }) => html.includes(ph));
}

/** Escapa lo mínimo para inyectar texto plano en contenido HTML (no atributos).
 *  El modelo devuelve prosa; si trae `<`, `>` o `&` sueltos, se escapan. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Reemplaza en el HTML los placeholders presentes por su valor del JSON.
 *  Devuelve el HTML nuevo y la lista de placeholders que estaban en el archivo
 *  pero NO se pudieron llenar (valor vacío) — el caller decide si abortar. */
export function injectNarrative(html: string, narrative: ProposalNarrative): { html: string; missing: string[] } {
  let out = html;
  const missing: string[] = [];
  for (const { ph, get } of PLACEHOLDER_MAP) {
    if (!out.includes(ph)) continue; // ese placeholder no está en este archivo
    const value = (get(narrative) ?? '').trim();
    if (!value) {
      missing.push(ph);
      continue;
    }
    out = out.split(ph).join(escapeHtml(value));
  }
  return { html: out, missing };
}

/** Valida que el JSON del modelo tenga todos los campos con contenido. Lanza si
 *  falta algo — mejor abortar y dejar que el validador bloquee que publicar a
 *  medias. */
export function assertNarrativeComplete(n: unknown): asserts n is ProposalNarrative {
  const errs: string[] = [];
  const str = (v: unknown, path: string) => {
    if (typeof v !== 'string' || !v.trim()) errs.push(path);
  };
  const o = n as ProposalNarrative;
  if (!o || typeof o !== 'object') throw new Error('narrativa: la respuesta no es un objeto');
  str(o.heroSub, 'heroSub');
  str(o.problema?.callout, 'problema.callout');
  [0, 1, 2].forEach((i) => str(o.problema?.bullets?.[i], `problema.bullets[${i}]`));
  [0, 1, 2, 3].forEach((i) => {
    str(o.objetivos?.[i]?.titulo, `objetivos[${i}].titulo`);
    str(o.objetivos?.[i]?.detalle, `objetivos[${i}].detalle`);
  });
  str(o.solucion?.callout, 'solucion.callout');
  str(o.solucion?.mvp?.entrega, 'solucion.mvp.entrega');
  str(o.solucion?.mvp?.sirve, 'solucion.mvp.sirve');
  str(o.solucion?.crecimiento?.entrega, 'solucion.crecimiento.entrega');
  str(o.solucion?.crecimiento?.sirve, 'solucion.crecimiento.sirve');
  str(o.vistaPrevia?.uno, 'vistaPrevia.uno');
  str(o.vistaPrevia?.dos, 'vistaPrevia.dos');
  [0, 1].forEach((i) => str(o.incluye?.[i], `incluye[${i}]`));
  [0, 1].forEach((i) => str(o.noIncluye?.[i], `noIncluye[${i}]`));
  str(o.tiers?.economica?.for, 'tiers.economica.for');
  str(o.tiers?.economica?.ideal, 'tiers.economica.ideal');
  str(o.tiers?.media?.for, 'tiers.media.for');
  str(o.tiers?.media?.diff, 'tiers.media.diff');
  str(o.tiers?.solida?.for, 'tiers.solida.for');
  str(o.tiers?.solida?.diff, 'tiers.solida.diff');
  [0, 1, 2, 3].forEach((i) => str(o.asunciones?.[i], `asunciones[${i}]`));
  [0, 1].forEach((i) => str(o.riesgos?.[i], `riesgos[${i}]`));
  if (errs.length) throw new Error(`narrativa incompleta, faltan: ${errs.join(', ')}`);
}

/** Prompt para el modelo. Recibe el brief crudo y un resumen de los tiers.
 *  Reglas duras: SOLO hechos del brief (no inventar cifras), español neutro
 *  sin voseo, lenguaje de cliente (qué GANA, no qué stack usamos). */
export function buildNarrativePrompt(brief: string, tiersSummary: string, cliente: string): string {
  return `Sos redactor comercial de una agencia de software. Escribí el contenido de una propuesta para el cliente "${cliente}" a partir de la información recopilada. Devolvé SOLO un JSON válido (sin markdown, sin \`\`\`), con esta forma exacta:

{
  "heroSub": "una frase: qué construimos para resolver su problema, en lenguaje cliente",
  "problema": {
    "callout": "una frase: qué le duele al cliente, a quién y por qué importa",
    "bullets": ["dato/consecuencia concreta del problema", "otra consecuencia o costo de no resolverlo", "tercer ángulo del problema, apoyado en el brief"]
  },
  "objetivos": [
    { "titulo": "objetivo 1 en 3-5 palabras", "detalle": "qué gana el cliente con ese objetivo, una frase" },
    { "titulo": "objetivo 2 en 3-5 palabras", "detalle": "qué gana el cliente" },
    { "titulo": "objetivo 3 en 3-5 palabras", "detalle": "qué gana el cliente" },
    { "titulo": "objetivo 4 en 3-5 palabras", "detalle": "qué gana el cliente" }
  ],
  "solucion": {
    "callout": "una frase: qué construimos para resolverlo",
    "mvp": { "entrega": "qué entregamos en la primera fase", "sirve": "para qué le sirve, resultado concreto" },
    "crecimiento": { "entrega": "qué sumamos en la fase de crecimiento", "sirve": "resultado adicional" }
  },
  "vistaPrevia": { "uno": "un párrafo corto sobre una capacidad clave del sistema, en lenguaje cliente", "dos": "un párrafo corto sobre otra capacidad clave" },
  "incluye": ["funcionalidad incluida 1", "funcionalidad incluida 2"],
  "noIncluye": ["algo que el cliente podría suponer incluido pero se cotiza aparte", "otra cosa fuera de alcance"],
  "tiers": {
    "economica": { "for": "qué obtiene concretamente en la opción económica", "ideal": "para qué tipo de cliente es la mejor" },
    "media": { "for": "qué obtiene en la opción media", "diff": "2-3 capacidades que la diferencian de la económica" },
    "solida": { "for": "qué obtiene en la opción sólida", "diff": "las capacidades premium que la diferencian" }
  },
  "asunciones": ["asunción de la que depende el plazo/precio (del brief: integraciones, accesos, documentación, responsable del cliente, contenidos)", "asunción 2", "asunción 3", "asunción 4"],
  "riesgos": ["riesgo principal del proyecto y cómo lo manejamos (una frase)", "segundo riesgo o cómo se gestionan cambios de alcance"]
}

REGLAS DURAS:
- Usá SOLO hechos presentes en la información de abajo. NO inventes cifras, nombres, fechas ni logros. Si un ángulo no está soportado por el brief, escribí algo genérico pero verdadero en vez de inventar.
- Español NEUTRO (nada de voseo: usá "usted"/"su"). Tono profesional y cálido.
- Lenguaje de CLIENTE: qué GANA el cliente, nunca el stack técnico (no menciones AWS, NestJS, Supabase, SAP-por-dentro; "integración con su sistema" está bien).
- Frases cortas y concretas. Sin jerga interna (PRD, ADR, E2E, MVP a secas, sprint).
- Cada string es texto plano (sin HTML, sin comillas sin cerrar).

=== BRIEF (lo que recopiló el vendedor) ===
${brief}

=== OPCIONES / TIERS (lo que armó el equipo técnico) ===
${tiersSummary}`;
}
