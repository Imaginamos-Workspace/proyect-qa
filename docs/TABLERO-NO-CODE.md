# El Tablero (estilo Jira) para usuarios no-code

Si venís de **Jira**, esta guía te ubica en 2 minutos. La plataforma reemplaza a
Jira con **GitHub Projects** (gratis) y te lo muestra como un **tablero kanban**
dentro del portal, en la sección **Tablero**.

## De Jira a acá: el mismo vocabulario

| En Jira | Acá | Dónde se ve |
|---|---|---|
| Proyecto | **Cliente** (un tablero por cliente) | selector arriba del Tablero |
| Epic | **Épica** 🟣 | tarjeta con ícono de épica |
| Story | **Historia** 🟢 | tarjeta de historia |
| Task / Sub-task | **Tarea** 🔵 | tarjeta de tarea |
| Bug | **Bug** 🔴 | tarjeta de bug |
| Spike | **Spike** 🟠 | tarjeta de spike |
| Columnas del board | **Backlog · To Do · In Progress · In Review · Done** | columnas del kanban |
| Sprint | **Sprint** | filtro de sprints arriba del tablero |
| Priority | **Prioridad** (banderas ↑ = ↓) | esquina de la tarjeta |
| Story points | **Estimación** (S/M/L/XL) | chip redondo en la tarjeta |
| Assignee | **Asignado** | avatar en la tarjeta |
| Issue key (PROJ-123) | **#123** (número del issue) | clave en la tarjeta |

## Cómo usarlo (no-code, sin tocar la terminal)

1. Entrá al portal → barra lateral → **Tablero**.
2. Elegí tu **cliente** en los botones de arriba (cada cliente = un tablero, como
   un proyecto de Jira).
3. Mirás el **kanban**: las tarjetas están en columnas según su estado. Hacé
   clic en una tarjeta para abrir el issue en GitHub (ahí se comenta, se cambia
   estado, se asigna).
4. Para enfocarte en un sprint, tocá el sprint arriba; **Todos los sprints** lo
   limpia.
5. **Abrir en GitHub** (arriba a la derecha) te lleva al tablero completo de
   GitHub Projects, donde podés arrastrar tarjetas entre columnas, editar campos
   y ver la vista **Roadmap** (línea de tiempo, como el timeline de Jira).

> El Tablero del portal es de **lectura** (para mirar el avance sin perderse).
> Para **mover** tarjetas o editar, usás GitHub Projects (el botón «Abrir en
> GitHub»). Es el mismo dato: el portal lo lee en vivo.

## Quién crea las tarjetas

El **PM** arma el plan (épicas → historias → tareas con criterios de aceptación)
y se publica al tablero automáticamente. No se crean tarjetas sueltas a mano: el
plan vive en un archivo de roadmap y el sistema lo sincroniza. (Detalle técnico
para el equipo: `roadmap.yml` + `roadmap:sync` en el monorepo de QA.)

## Si el Tablero dice "no disponible"

- **Falta el token de GitHub:** un admin debe setear `GITHUB_TOKEN` en el backend
  (ver abajo). Sin eso, el portal no puede leer el tablero.
- **No se encontró el tablero del cliente:** todavía no se creó el GitHub Project
  de ese cliente. El equipo lo crea con `projects:bootstrap`.

## Para el admin: encender el Tablero (una sola vez)

El backend lee GitHub Projects con un token de **solo lectura**:

1. Creá un **PAT fine-grained** con permiso de **lectura de Projects**
   (`read:project`).
2. En el backend (Vercel u donde corra), seteá las variables:
   - `GITHUB_TOKEN` = el PAT.
   - `GITHUB_PROJECT_OWNER` = `fridaKhalo` (o la cuenta/organización dueña de los
     Projects; es el default).
3. Redeploy. El portal descubre el tablero de cada cliente por su título
   (`Cliente: <nombre>`) — no hay que mapear nada a mano.

El token nunca se expone al navegador: sólo el backend lo usa.
