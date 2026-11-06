# TRAZA — Sistema de control y conciliación de pagos (DEMO)

Laboratorio local en español para registrar facturas, asignar pagos por tramos a intermediarios, guardar comprobantes, confirmar por separado lo recibido por el proveedor y revisar la cuenta de cada intermediario. Conserva los 28 escenarios del laboratorio.

## Manual visual

La [guía visual paso a paso](https://franchute10.github.io/traza/manual.html) explica el flujo con dibujos, ejemplos y vocabulario pensado para personas que vienen de trabajar en Excel. También está enlazada desde el menú lateral de TRAZA.

## Iniciar la DEMO

No requiere instalar dependencias ni conectar servicios externos. Desde esta carpeta ejecuta:

```powershell
python -m http.server 4173 --bind 127.0.0.1
```

Abre <http://127.0.0.1:4173>. Detén el servidor con `Ctrl+C`. También se puede abrir `index.html` directamente; el servidor local facilita las rutas, el historial del navegador y las descargas CSV.

Si el puerto 4173 ya está ocupado, inicia el servidor con `python -m http.server 4174 --bind 127.0.0.1` y abre <http://127.0.0.1:4174>.

Las pruebas de reglas de negocio se ejecutan con:

```powershell
node --test tests/domain.test.cjs
```

## Flujo de trabajo

1. Registra una factura y revisa el perfil DEMO del proveedor en **Administración**.
2. Asigna todo o parte del saldo a un intermediario. Si faltan datos, guarda un borrador; la solicitud solo se envía con el perfil completo.
3. En **Portal de intermediario**, la persona revisa la instantánea de destino y confirma que la recibió. Puede registrar varios intentos, con o sin evidencia.
4. Un aprobador revisa el comprobante y confirma aparte, por correo, llamada o mensajería, cuánto recibió el proveedor y a qué factura lo aplicó.
5. Registra cada devolución como movimiento separado. Una devolución al ordenante sin confirmación del proveedor no cuenta como pago.
6. Revisa **Estado de cuenta de intermediarios**: principal con fondos propios, anticipos aplicados o pendientes de regularización, comisiones, abonos y saldo por moneda.
7. Resuelve alertas y diferencias antes de registrar la conciliación final.

Las devoluciones que revierten una recepción se concilian contra la confirmación, el intento y la moneda exactos, incluso si la misma confirmación se distribuyó entre varios intentos. Los anticipos quedan vinculados a su factura e intento; el estado de cuenta separa lo entregado, aplicado, comprometido y pendiente de regularizar. Un saldo negativo se muestra como importe por recuperar o compensar. Si la moneda bancaria difiere de la factura/asignación, la solicitud exige el importe de destino y el tratamiento de conversión.

La DEMO está disponible públicamente en <https://franchute10.github.io/traza/> para que se pueda consultar y compartir. No conecta bancos, billeteras, correo, mensajería ni pagos reales. Todos los nombres, perfiles, cuentas, referencias y archivos de ejemplo son ficticios. No uses datos financieros reales, personales o confidenciales.

## Escenarios destacados

- **OBL-015 / FC-441 · S/ 15:** Juan reportó un intento con evidencia y luego una devolución al ordenante. El proveedor confirmó S/ 0, el saldo pendiente sigue en S/ 15 y la deuda de principal con Juan es S/ 0 porque no hubo anticipo.
- **OBL-016 / FC-442 · S/ 320:** la empresa entregó un anticipo a Juan, el dinero regresó al ordenante y el proveedor no confirmó recepción. El anticipo de S/ 320 queda pendiente de regularización; no se atribuye un pago al proveedor.
- Los 28 escenarios están en **Herramientas del laboratorio → 28 escenarios**.

## Almacenamiento y alcance

La aplicación usa `localStorage` en el perfil de navegador y dispositivo donde se abre. Los cambios no se sincronizan entre personas, navegadores o equipos. Borrar el almacenamiento del navegador elimina esos cambios. El selector de rol solo simula vistas; no ofrece autenticación ni controla permisos de forma segura.

Los archivos adjuntos de la DEMO se guardan localmente en el navegador con un límite de 900 KB por archivo. No se envían a un servidor. Si el navegador no tiene espacio, el formulario conserva lo ingresado y muestra cómo exportar la DEMO, reducir adjuntos o liberar espacio antes de volver a intentar. La persistencia local y los roles simulados no deben utilizarse para operar pagos reales ni compartir datos sensibles.

## Siguiente fase multiusuario

Para convertir el laboratorio en un sistema multiusuario se necesitarían, como mínimo:

- un backend con API y validaciones del lado del servidor;
- una base de datos central con migraciones, respaldos y reglas transaccionales;
- autenticación real, roles y permisos por organización y por registro;
- almacenamiento privado de archivos, control de acceso y trazabilidad;
- auditoría centralizada, manejo seguro de secretos, despliegue y monitoreo;
- revisión de seguridad y pruebas de concurrencia antes de incorporar operaciones reales.

Esta fase no está implementada. El prototipo permanece local y no se conecta a servicios financieros.
