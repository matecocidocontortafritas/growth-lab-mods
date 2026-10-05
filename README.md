# Growth Lab Mods

Mods de [Claude Code](https://claude.com/claude-code) para tiendas online: tus ventas de **Tiendanube**, tu tráfico de **Google Analytics** y tus campañas de **Meta Ads**, en paneles al costado de la conversación.

Un *mod* es un pequeño programa que va dentro de Claude Code y le agrega cosas que solo con instrucciones no se pueden hacer, como un panel propio. Lo mejor: **mirar estos paneles no gasta tokens**, porque los datos los trae el mod directo de tus conectores, sin pasar por Claude.

| Mod | Comando | Qué muestra |
| --- | --- | --- |
| [pedidos](plugins/pedidos) | `/pedidos` | Los pedidos de hoy de tu Tiendanube y cuánto vendiste. |
| [tablero](plugins/tablero) | `/tablero` | Ventas + tráfico + Meta Ads juntos, con MER y conversión, para hoy, 7 o 30 días. |

---

## Así se ven

Los números de estos ejemplos son inventados.

### `/pedidos`

```text
┌ Pedidos de hoy ──────────────────────────────────────────────┐
│ Vendido hoy: $1.284.500                                      │
│ 14 pedidos · pendiente $212.000 · 1 cancelados               │
│ Actualizado 17:42 · se refresca cada 5 min                   │
│                                                              │
│ 17:31 #10482   $118.000 pagado     María G.                  │
│ 17:05 #10481    $85.000 pendiente  Lucía P.                  │
│ 16:48 #10480   $210.500 pagado     Sofía R.                  │
│ 16:12 #10479    $64.000 pagado     Carla M.                  │
│ …                                                            │
│                                                              │
│ [ Actualizar ] r                                             │
└──────────────────────────────────────────────────────────────┘
```

### `/tablero`

```text
┌ Tablero ─────────────────────────────────────────────────────┐
│ [ Hoy ] h  [ 7 días ] 7  [ 30 días ] 3                       │
│ 2026-09-29 → 2026-10-05 · vs período anterior · act. 17:42   │
│                                                              │
│ VENTAS · Tiendanube                                          │
│ Cobrado     $8.940.000 ▲12%                                  │
│ Pedidos     96 ▲8%                                           │
│ Ticket      $93.125                                          │
│                                                              │
│ TRÁFICO · Analytics                                          │
│ Sesiones    11.204 ▼3%                                       │
│ Usuarios    9.870 ▼1%                                        │
│ Conversión  0,86%                                            │
│ Paid Social 6.210 · Direct 2.104 · Organic Search 1.380      │
│                                                              │
│ META ADS · Mi tienda                                         │
│ Gasto       $1.120.000 ▲5%                                   │
│ Compras     61 ▲10%                                          │
│ ROAS Meta   6,8x                                             │
│ MER         8,0x                                             │
│ MER = cobrado en Tiendanube ÷ gasto en Meta                  │
│                                                              │
│ [ Actualizar ] r                                             │
└──────────────────────────────────────────────────────────────┘
```

- **▲ / ▼** comparan con el período anterior del mismo largo. En **Hoy** se compara contra **ayer completo**, así que a media tarde es normal que todo dé abajo.
- **Conversión** = pedidos de Tiendanube ÷ sesiones de Analytics.
- **ROAS Meta** es el que informa Meta (lo que Meta se atribuye). **MER** es lo que cobraste de verdad en Tiendanube dividido lo que gastaste en Meta: el "ROAS real" del negocio.
- Si una fuente falla o falta configurarla, ese bloque te dice qué hacer y los otros se siguen mostrando.

---

## Instalación paso a paso

Son 5 pasos. Si ya tenés algo hecho, salteá ese paso.

### Paso 1 · Tener Claude Code actualizado

Los mods necesitan **Claude Code 2.1.287 o más nuevo**.

- **App de escritorio** (pestaña Code): se actualiza sola. No tenés que hacer nada.
- **Terminal**: fijate tu versión y actualizá si hace falta:

  ```bash
  claude --version
  ```

  ```bash
  claude update
  ```

  > Si `claude update` da `EACCES: permission denied`, Claude Code se instaló alguna vez con `sudo`. Mirá [Problemas frecuentes](#problemas-frecuentes).

### Paso 2 · Conectar tus cuentas (los MCP)

Los mods no se conectan a nada por su cuenta: usan los **conectores (MCP)** que ya tengas en Claude. Conectá los que quieras usar. `/pedidos` solo necesita Tiendanube.

#### Tiendanube (para `/pedidos` y `/tablero`)

Es el conector **oficial** de Tiendanube.

1. Entrá a [claude.ai](https://claude.ai) → **Configuración** → **Conectores**.
2. Buscá **Tiendanube** en el directorio y tocá **Conectar**.
   Si no aparece: **Agregar conector personalizado** y pegá `https://admin-mcp.tiendanube.com`.
3. Iniciá sesión con tu tienda y aceptá los permisos.

Guía oficial: [¿Cómo conectar mi Tiendanube a Claude?](https://ayuda.tiendanube.com/es_CO/conectores-de-ia/como-conectar-mi-tiendanube-a-claude)

#### Google Analytics (para `/tablero`)

Es el MCP **oficial** de Google: [googleanalytics/google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp). Este se instala en tu compu, y es el paso más largo:

1. Instalá [pipx](https://pipx.pypa.io/stable/installation/) y [gcloud](https://cloud.google.com/sdk/docs/install).
2. En un proyecto de Google Cloud, habilitá la **Google Analytics Admin API** y la **Google Analytics Data API**.
3. Iniciá sesión con permiso de solo lectura:

   ```bash
   gcloud auth application-default login --scopes https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/cloud-platform
   ```

   Anotá la ruta del archivo de credenciales que te muestra al final.
4. Agregalo a Claude Code, reemplazando la ruta y el ID de tu proyecto:

   ```bash
   claude mcp add analytics-mcp -s user -e "GOOGLE_APPLICATION_CREDENTIALS=RUTA_A_TUS_CREDENCIALES.json" -e "GOOGLE_PROJECT_ID=ID_DE_TU_PROYECTO" -- pipx run analytics-mcp
   ```

Para los detalles, seguí el README del repo de Google.

#### Meta Ads (para `/tablero`)

> **Estado:** hoy el bloque de Meta funciona con MCP de Meta Ads que tengan la herramienta `get_account_summary`. El soporte para el **MCP oficial de Meta** (`https://mcp.facebook.com/ads`) está en camino. Mientras tanto, si lo conectás, el bloque de Meta te va a avisar que no encontró la herramienta, y Tiendanube y Analytics se siguen viendo igual.

Para conectar el MCP oficial de Meta:

1. [claude.ai](https://claude.ai) → **Configuración** → **Conectores** → **Agregar conector personalizado**.
2. Pegá `https://mcp.facebook.com/ads`.
3. Iniciá sesión con Facebook y aceptá los permisos de tu cuenta publicitaria.

> Abrí una **sesión nueva** de Claude Code después de conectar algo, así la ve.

### Paso 3 · Instalar los mods

Dentro de Claude Code (terminal o pestaña Code de la app), escribí:

```text
/plugin marketplace add matecocidocontortafritas/growth-lab-mods
```

Y después instalá los que quieras:

```text
/plugin install pedidos@growth-lab-mods
```

```text
/plugin install tablero@growth-lab-mods
```

### Paso 4 · Configurar tus cuentas (solo `/tablero`)

`/pedidos` no necesita configuración: encuentra solo tu Tiendanube.

Para `/tablero`, escribí `/config`, buscá **tablero** y completá:

| Campo | Qué poner | ¿De dónde lo saco? |
| --- | --- | --- |
| **Propiedad de Google Analytics** | El número de tu propiedad GA4, ej. `123456789` | Preguntale a Claude: *"listame mis propiedades de Google Analytics con su ID"* |
| **Cuenta publicitaria de Meta** | El ID de tu cuenta, ej. `act_123456789` | Preguntale a Claude: *"listame mis cuentas publicitarias de Meta con su ID"* |
| **Nombre a mostrar de la cuenta de Meta** | Opcional. Cómo querés que aparezca, ej. `Mi tienda` | — |

Los campos de **Herramienta…** dejalos vacíos: el mod encuentra solo tus conectores. Solo hacen falta si tenés, por ejemplo, dos tiendas conectadas y querés elegir una.

### Paso 5 · Permisos (solo si usás modo automático)

Si usás Claude Code en **modo automático**, un revisor chequea cada herramienta que se usa contra lo que vos pediste. Como el panel llama a los conectores por su cuenta, el revisor lo frena y en el panel vas a ver:

```text
Claude Code no dejó consultar Tiendanube. Si usás modo automático, agregá este permiso
en ~/.claude/settings.json → permissions.allow: "mcp__xxxx__list_orders" (README → Permisos).
```

Agregá cada nombre que te muestre el panel a la lista `permissions.allow` de tu `~/.claude/settings.json`. Por ejemplo:

```json
{
  "permissions": {
    "allow": [
      "mcp__xxxx__list_orders",
      "mcp__analytics-mcp__run_report",
      "mcp__xxxx__get_account_summary"
    ]
  }
}
```

- Son herramientas **de solo lectura**: consultan pedidos, tráfico y métricas. No crean, cambian ni borran nada.
- Si `settings.json` ya tiene otras cosas, agregá el bloque `permissions` sin borrar lo demás y fijate que queden bien las comas.
- Claude no puede agregarse permisos a sí mismo en modo automático: este paso lo tenés que hacer vos.
- Si **no** usás modo automático, no hace falta. Claude Code te va a preguntar la primera vez, y podés elegir que no vuelva a preguntar.

---

## Uso

| Acción | Cómo |
| --- | --- |
| Abrir pedidos | `/pedidos` |
| Abrir el tablero | `/tablero` |
| Actualizar | Botón **Actualizar** o tecla `r` |
| Cambiar período del tablero | Botones **Hoy / 7 días / 30 días**, o teclas `h`, `7`, `3` |
| Cerrar | La ✕ del panel |

Con el panel abierto, `/pedidos` se actualiza solo cada 5 minutos y `/tablero` cada 10.

---

## ¿Es seguro?

Un mod corre dentro de Claude Code con tus mismos permisos, así que **instalá mods solo de gente en la que confíes** y revisalos antes.

Estos mods:

- **Solo leen** datos: usan `list_orders` (Tiendanube), `run_report` (Analytics) y `get_account_summary` (Meta).
- **No se conectan a internet** por su cuenta, **no leen tus archivos** y **no leen tus claves**: todo pasa por los conectores que vos ya autorizaste.

No hace falta creernos: Claude Code tiene un comando que te muestra qué hace un mod antes de instalarlo, sin ejecutarlo. Bajá este repo y corré:

```bash
claude plugin validate plugins/tablero
```

En la línea `calls:` vas a ver exactamente qué usa: herramientas (`$.tool.call`, `$.tool.list`), reloj, comandos y el panel. Nada de `$.http`, `$.fs` ni `$.env`.

---

## Problemas frecuentes

| Veo esto | Qué hacer |
| --- | --- |
| `/pedidos` o `/tablero` no aparecen | Revisá tu versión de Claude Code (Paso 1) y que el mod esté activo en `/plugin`. |
| "No encontré el conector de …" | Conectá ese MCP (Paso 2) y abrí una **sesión nueva**. |
| "Claude Code no dejó consultar …" | Falta el permiso de modo automático (Paso 5). Agregá el nombre exacto que te muestra el panel. |
| "Falta tu propiedad de Analytics" o "Falta tu cuenta de Meta" | Completá `/config` → tablero (Paso 4). |
| Los números de **Hoy** dan todos abajo | Es normal: se comparan contra **ayer completo**. Mirá 7 o 30 días para ver tendencia. |
| `claude update` da `EACCES: permission denied` | Claude Code se instaló con `sudo`. Devolvé las carpetas a tu usuario y volvé a actualizar: `sudo chown -R -h "$(id -u)" ~/.local/share/claude ~/.local/bin/claude ~/.cache/claude ~/.local/state/claude` |
| 30 días tarda en cargar | Trae todos los pedidos del período y del anterior para comparar. Unos segundos es normal. |

---

## Para desarrolladores

```text
.claude-plugin/marketplace.json   el catálogo que lee /plugin marketplace add
plugins/pedidos/                  el mod /pedidos
plugins/tablero/                  el mod /tablero
  .claude-plugin/plugin.json      nombre, descripción y opciones de /config (userConfig)
  hooks/register.tsx              el código del mod
  hooks/*.test.tsx                tests
  types/index.d.ts                los tipos del estado del panel
```

Para correr los tests y validar:

```bash
claude plugin test plugins/tablero
```

```bash
claude plugin validate plugins/tablero
```

¿Querés cambiar algo? Abrí Claude Code en la carpeta del mod y pedíselo con tus palabras, por ejemplo: *"agregá al tablero los productos más vendidos"*. Claude Code ya sabe escribir mods.

---

Hecho por [Growth Lab](https://github.com/matecocidocontortafritas) con Claude Code · Licencia [MIT](LICENSE)
