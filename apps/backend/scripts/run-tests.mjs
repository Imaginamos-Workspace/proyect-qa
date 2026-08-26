/**
 * Corre los tests compilados del backend.
 *
 * Por qué existe este script en vez de `node --test .test-build`:
 *
 * El runner de Node 20 solo reconoce como test los archivos que matchean
 * `*.test.js`, `*-test.js`, `*_test.js`, `test-*.js`, `test.js` o cualquier
 * cosa dentro de un directorio `test/`. Nuestros archivos se llaman `*.spec.ts`
 * (el patrón `.spec.js` recién se agregó en Node 22), así que el runner no los
 * veía y salía en VERDE con cero pruebas ejecutadas. Peor: sí matcheaba
 * `test-run.types.js` y `test-case.types.js`, que son archivos de tipos sin una
 * sola aserción, y los reportaba como "ok" — de ahí el "# pass 2" que parecía
 * un suite sano cuando en realidad no se estaba probando nada.
 *
 * Acá los descubrimos nosotros y se los pasamos a `node --test` explícitamente.
 *
 * Y si no encuentra ninguno, ESTE SCRIPT FALLA. Un suite vacío que sale en
 * verde es peor que no tener suite: da confianza falsa. Es exactamente el modo
 * de falla que escondió este bug durante meses.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = '.test-build';
/** `.spec.js` es nuestra convención; `.test.js` se acepta por si alguien la usa. */
const ES_TEST = /\.(spec|test)\.js$/;

function buscarTests(dir) {
  let encontrados = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) encontrados = encontrados.concat(buscarTests(ruta));
    else if (ES_TEST.test(entrada.name)) encontrados.push(ruta);
  }
  return encontrados;
}

let tests;
try {
  tests = buscarTests(RAIZ);
} catch (err) {
  console.error(`No pude leer "${RAIZ}": ${err.message}`);
  console.error('¿Corrió antes la compilación (tsc -p tsconfig.test.json)?');
  process.exit(1);
}

if (tests.length === 0) {
  console.error('No se encontró ningún archivo de test en .test-build.');
  console.error('Los tests van en src/**/*.spec.ts. Si acabás de agregar uno y');
  console.error('ves este mensaje, revisá que compile: tsc -p tsconfig.test.json');
  process.exit(1);
}

console.log(`Corriendo ${tests.length} archivo(s) de test:`);
for (const t of tests) console.log(`  · ${t}`);

const { status } = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exit(status ?? 1);
