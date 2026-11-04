/* =============================================================
   PRUEBA DE LA MFA Y DE "ENTRAR COMO" CONTRA LA BASE REAL  (api/superadmin.js + SQL 19)

   Ejecuta el MANEJADOR REAL de api/superadmin.js (el mismo que corre en Vercel) contra la base real y dice PASA o FALLA por cada
   escenario. Es el mismo motor que supabase/probar-superadmin.mjs (que prueba lo de siempre, sin el SQL 19), pero con los grupos:

     MFA        crea superadmins de prueba @prueba-superadmin.example.com, enrola un factor TOTP REAL por las rutas de Supabase Auth
                (/auth/v1/factors), calcula el codigo con node:crypto (RFC 6238, sin dependencias) y lo verifica para obtener una sesion
                aal2. Comprueba: sin MFA (aal1) las 21 acciones dan 403 con el codigo estable "mfa_requerida"; con MFA (aal2) pasan;
                mi_estado dice la verdad; un no-superadmin recibe el MISMO 403 con aal1 y con aal2; tokens con el aal manipulado dan
                401; dueno, cajero y cocina siguen entrando sin MFA.
     LECTURAS   ver_pedidos, ver_menu, ver_config y ver_resumen de un restaurante de prueba: solo superadmin, paginan, respetan limites,
                rechazan ids malos, NO escriben, no devuelven secretos ni tokens, y dejan UNA fila de auditoria sin datos personales.
                Tambien la constancia (una por ventana) de un superadmin rechazado por no tener MFA.

   REQUIERE el SQL 19 (supabase/19-superadmin-lectura.sql) ademas del 10, 11 y 16, y que el proyecto tenga habilitado el MFA con TOTP
   (Authentication -> Sign In / Providers -> Multi-Factor; viene activo por defecto). Si falta el SQL 19, el script lo dice y no hace nada.

   QUE TOCA EN LA BASE REAL
     * Solo filas de restaurantes "mr16-prueba*" (sin clientes reales; con 125 pedidos de prueba que se borran al terminar) y usuarios
       "*@prueba-superadmin.example.com" con sus factores TOTP (se borran al terminar, aun con Ctrl+C o si algo falla; al empezar barre
       los restos). NUNCA toca los datos del demo ni la cuenta de Carlos.
     * La tabla de auditoria: quedan unas pocas constancias (superadmins de prueba, restaurantes mr16-*). Es de solo agregar a proposito
       y NO se puede borrar: se pueden ignorar (restaurante_slug "mr16-prueba...").
     * Los secretos TOTP, los codigos y los tokens viven SOLO en memoria: no se imprimen ni se guardan.

   USO (PowerShell, desde la raiz del repo) - ver docs/multirestaurante.md seccion 23
     $k = Read-Host "Llave SECRETA (UNA sola vez: clic derecho O Ctrl+V)" -AsSecureString
     $env:SUPABASE_SERVICE_ROLE_KEY = [System.Net.NetworkCredential]::new('', $k).Password
     node supabase/probar-superadmin-mfa.mjs
     Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY

   Sale con codigo 1 si algo FALLA.
============================================================= */
process.env.PROBAR_SA_GRUPOS = "mfa,lecturas";
await import("./probar-superadmin.mjs");
