/**
 * src/modules/products/product-text.ts — Normalización de texto de búsqueda.
 *
 * ────────────────────────────────────────────────────────────────────────
 * El buscador de productos (`GET /products?q=`) debe encontrar "Azúcar"
 * escribiendo "azucar", "AZUCAR" o "Azúcar". Para eso:
 *
 *   - La BD guarda `products.name_normalized` (minúsculas y sin acentos),
 *     mantenida por triggers (migración 009).
 *   - Aquí se normaliza el término que escribe el usuario con la MISMA
 *     regla, para comparar `name_normalized LIKE '%termino%'`.
 *
 * IMPORTANTE: esta función debe producir el mismo resultado que la cadena
 * de `replace()` de la migración 009 (español: á é í ó ú ü ñ ç). Si se
 * agregan caracteres allá, hay que agregarlos aquí también.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * Minúsculas, sin acentos y con espacios colapsados.
 *
 * ```
 * normalizeSearchText('  Azúcar   Estándar ') // 'azucar estandar'
 * normalizeSearchText('PIÑA')                 // 'pina'
 * ```
 */
export function normalizeSearchText(input: string): string {
  return input
    .normalize('NFD')
    /* Marcas diacríticas combinantes (U+0300–U+036F): tildes, diéresis, etc. */
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}
