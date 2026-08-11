-- ============================================================
-- MIGRACIÓN 001 — ESQUEMA SQLITE (PRUEBAS INICIALES)
-- ============================================================
-- SQLite con la MISMA ESTRUCTURA necesaria que el esquema
-- autoritativo PostgreSQL (esquema_BD_POS_v4_completo.sql).
--
-- ADAPTACIONES DE TIPO (documentadas para la migración a PG):
--   UUID/TIMESTAMPTZ/JSONB/INET  →  TEXT (ISO-8601 / JSON / IP)
--   BOOLEAN                      →  INTEGER 0/1
--   DECIMAL/NUMERIC              →  REAL (precisión aceptable en pruebas)
--   BIGSERIAL                    →  INTEGER PRIMARY KEY AUTOINCREMENT
--
-- LOS TRIGGERS DE NEGOCIO (folio, internal_code, descuento de stock,
-- QoS, base_quantity, updated_at) viven en PostgreSQL. Aquí solo se
-- replican las TABLAS + constraints + índices; cuando una fase de
-- negocio necesite un trigger en SQLite, se agrega en una migración
-- aparte (NUNCA se reimplementa esa lógica en JS).
-- ============================================================

-- 1) TENANTS Y LICENCIAS
CREATE TABLE tenants (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name VARCHAR(255) NOT NULL,
    license_key VARCHAR(255) NOT NULL UNIQUE,
    license_expires_at TEXT NOT NULL,
    max_devices INTEGER NOT NULL DEFAULT 2,
    max_branches INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 2) CONFIGURACIÓN DEL NEGOCIO
CREATE TABLE tenant_settings (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    business_name VARCHAR(255),
    business_address TEXT,
    business_phone VARCHAR(20),
    business_email VARCHAR(255),
    business_rfc VARCHAR(13),
    tax_rate REAL NOT NULL DEFAULT 16.00,
    currency VARCHAR(3) NOT NULL DEFAULT 'MXN',
    ticket_header TEXT DEFAULT '',
    ticket_footer TEXT DEFAULT 'Gracias por su compra',
    logo_url VARCHAR(500),
    timezone VARCHAR(50) NOT NULL DEFAULT 'America/Mexico_City',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 3) SUCURSALES
CREATE TABLE branches (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    address TEXT,
    phone VARCHAR(20),
    branch_code VARCHAR(10) NOT NULL DEFAULT '01',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(tenant_id, branch_code),
    UNIQUE(tenant_id, name)
);

-- 4) SERVIDORES LOCALES
CREATE TABLE local_servers (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
    device_name VARCHAR(255) NOT NULL DEFAULT 'Servidor Principal',
    mac_address VARCHAR(17),
    local_ip VARCHAR(15),
    discovery_port INTEGER NOT NULL DEFAULT 5000,
    api_port INTEGER NOT NULL DEFAULT 3000,
    api_version VARCHAR(10) DEFAULT '1.0.0',
    last_seen_at TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 5) USUARIOS
CREATE TABLE users (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    pin_hash VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(20),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 6) PERMISOS (25 códigos del PRD)
CREATE TABLE permissions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    code VARCHAR(100) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    module VARCHAR(50) NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO permissions (code, name, module) VALUES
('products:read', 'Ver productos', 'products'),
('products:create', 'Crear productos', 'products'),
('products:update', 'Editar productos', 'products'),
('products:delete', 'Eliminar productos', 'products'),
('categories:read', 'Ver categorías', 'categories'),
('categories:manage', 'Gestionar categorías', 'categories'),
('sales:create', 'Crear ventas', 'sales'),
('sales:read_own', 'Ver ventas propias', 'sales'),
('sales:read_all', 'Ver todas las ventas', 'sales'),
('sales:update', 'Editar ventas', 'sales'),
('sales:cancel', 'Cancelar ventas', 'sales'),
('customers:read', 'Ver clientes', 'customers'),
('customers:manage', 'Gestionar clientes', 'customers'),
('cashier:cut_own', 'Corte de caja propio', 'cashier'),
('cashier:cut_all', 'Corte de caja global', 'cashier'),
('reports:read', 'Ver reportes', 'reports'),
('users:manage', 'Gestionar usuarios', 'users'),
('settings:manage', 'Configurar sistema', 'settings'),
('inventory:read', 'Ver inventario', 'inventory'),
('inventory:adjust', 'Ajustar inventario', 'inventory'),
('inventory:purchase', 'Entradas de mercancía', 'inventory'),
('suppliers:manage', 'Gestionar proveedores', 'inventory'),
('print:delegate', 'Imprimir en otro dispositivo', 'devices'),
('scale:read', 'Leer báscula remota', 'devices'),
('qos:manage', 'Gestionar calidad de servicio', 'sales'),
('discounts:manage', 'Gestionar descuentos', 'products'),
('prices:manage', 'Gestionar precios', 'products');

-- 7) ROLES
CREATE TABLE roles (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 8) PERMISOS POR ROL
CREATE TABLE role_permissions (
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (role_id, permission_id)
);

-- 9) ASIGNACIÓN DE ROL A USUARIO
CREATE TABLE user_roles (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, role_id)
);

-- 10) DISPOSITIVOS REGISTRADOS
CREATE TABLE device_registrations (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    local_server_id TEXT REFERENCES local_servers(id) ON DELETE SET NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    device_id VARCHAR(255) NOT NULL,
    device_name VARCHAR(255),
    device_type VARCHAR(20) NOT NULL CHECK (device_type IN ('TABLET', 'DESKTOP', 'PHONE')),
    role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(tenant_id, device_id)
);

-- 11) CAPABILITIES DE DISPOSITIVO
CREATE TABLE device_capabilities (
    device_id VARCHAR(255) PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    can_sell INTEGER NOT NULL DEFAULT 1,
    can_print INTEGER NOT NULL DEFAULT 0,
    printer_type VARCHAR(20) CHECK (printer_type IN ('USB', 'WIFI', 'BLUETOOTH', 'NONE')),
    printer_protocol VARCHAR(20) CHECK (printer_protocol IN ('ESC_POS_USB', 'ESC_POS_WIFI', 'ESC_POS_BLUETOOTH', 'RAW_TCP_9100')),
    printer_address VARCHAR(255),
    printer_width INTEGER NOT NULL DEFAULT 48,
    printer_dpi INTEGER NOT NULL DEFAULT 203,
    can_scale INTEGER NOT NULL DEFAULT 0,
    scale_brand VARCHAR(20) CHECK (scale_brand IN ('TORREY', 'RHINO', 'TOLEDO', 'GENERIC')),
    scale_protocol VARCHAR(20) CHECK (scale_protocol IN ('ASCII', 'CH340', 'STANDARD', 'TOLEDO', 'METTLER', 'SARTORIUS', 'CUS')),
    scale_port VARCHAR(20),
    scale_baud_rate INTEGER NOT NULL DEFAULT 9600,
    scale_data_bits INTEGER NOT NULL DEFAULT 8,
    scale_parity VARCHAR(10) NOT NULL DEFAULT 'NONE',
    scale_stop_bits INTEGER NOT NULL DEFAULT 1,
    is_server INTEGER NOT NULL DEFAULT 0,
    local_ip VARCHAR(15),
    api_port INTEGER NOT NULL DEFAULT 3000,
    ticket_template TEXT,
    auto_print INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_device_caps_tenant ON device_capabilities(tenant_id);
CREATE INDEX idx_device_caps_print ON device_capabilities(tenant_id, can_print) WHERE can_print = 1;
CREATE INDEX idx_device_caps_scale ON device_capabilities(tenant_id, can_scale) WHERE can_scale = 1;

-- 12) ESTADO EN TIEMPO REAL DE DISPOSITIVOS (Heartbeats)
CREATE TABLE device_status (
    device_id VARCHAR(255) PRIMARY KEY REFERENCES device_registrations(device_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    is_online INTEGER NOT NULL DEFAULT 1,
    last_heartbeat TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    current_scale_weight REAL,
    scale_unit VARCHAR(10) DEFAULT 'kg',
    scale_is_stable INTEGER DEFAULT 0,
    app_version VARCHAR(20),
    battery_level INTEGER,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_device_status_online ON device_status(tenant_id, is_online, last_heartbeat);

-- 13) PROVEEDORES
CREATE TABLE suppliers (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    contact_name VARCHAR(255),
    phone VARCHAR(20),
    email VARCHAR(255),
    address TEXT,
    rfc VARCHAR(13),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 14) UNIDADES DE MEDIDA (seed del esquema autoritativo)
CREATE TABLE measurement_units (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(100) NOT NULL,
    symbol VARCHAR(10) NOT NULL,
    unit_type VARCHAR(20) NOT NULL CHECK (unit_type IN ('MASS', 'COUNT', 'VOLUME', 'LENGTH')),
    is_fractional INTEGER NOT NULL DEFAULT 0,
    decimal_places INTEGER NOT NULL DEFAULT 0 CHECK (decimal_places BETWEEN 0 AND 6),
    is_system_default INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT uq_measurement_units_code UNIQUE (tenant_id, code)
);

CREATE INDEX idx_measurement_units_tenant ON measurement_units(tenant_id);
CREATE INDEX idx_measurement_units_type ON measurement_units(unit_type);

INSERT INTO measurement_units (code, name, symbol, unit_type, is_fractional, decimal_places, is_system_default) VALUES
('kg', 'Kilogramo', 'kg', 'MASS', 1, 3, 1),
('g', 'Gramo', 'g', 'MASS', 1, 3, 1),
('piece', 'Pieza', 'pz', 'COUNT', 0, 0, 1),
('box', 'Caja', 'cja', 'COUNT', 0, 0, 1),
('bag', 'Bolsa', 'bol', 'COUNT', 0, 0, 1),
('dozen', 'Docena', 'doc', 'COUNT', 0, 0, 1),
('pack', 'Paquete', 'pq', 'COUNT', 0, 0, 1),
('liter', 'Litro', 'L', 'VOLUME', 1, 3, 1),
('ml', 'Mililitro', 'ml', 'VOLUME', 1, 3, 1),
('meter', 'Metro', 'm', 'LENGTH', 1, 3, 1),
('cm', 'Centímetro', 'cm', 'LENGTH', 1, 3, 1);

-- 15) CATEGORÍAS
CREATE TABLE categories (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    prefix VARCHAR(4) NOT NULL,
    color VARCHAR(7) NOT NULL DEFAULT '#3B82F6',
    display_order INTEGER NOT NULL DEFAULT 0,
    product_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 16) TIPOS DE PRECIO
CREATE TABLE price_types (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(tenant_id, code)
);

-- 17) PRODUCTOS
-- NOTA: los UNIQUE parciales (solo si barcode/código NO es NULL) se
-- definen como índices únicos parciales, igual que en PostgreSQL.
CREATE TABLE products (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    barcode VARCHAR(100),
    internal_code VARCHAR(20),
    sku VARCHAR(100),
    base_unit_id TEXT NOT NULL REFERENCES measurement_units(id),
    sale_unit_id TEXT NOT NULL REFERENCES measurement_units(id),
    unit_conversion REAL NOT NULL DEFAULT 1,
    price REAL NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    stock REAL NOT NULL DEFAULT 0,
    min_stock REAL NOT NULL DEFAULT 0,
    max_stock REAL,
    is_scale_enabled INTEGER NOT NULL DEFAULT 0,
    allow_fractional_sale INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT chk_products_conversion_positive CHECK (unit_conversion > 0),
    CONSTRAINT chk_products_stock_non_negative CHECK (stock >= 0)
);

CREATE UNIQUE INDEX uq_products_barcode ON products(tenant_id, barcode) WHERE barcode IS NOT NULL;
CREATE UNIQUE INDEX uq_products_internal_code ON products(tenant_id, internal_code) WHERE internal_code IS NOT NULL;
CREATE UNIQUE INDEX uq_products_sku ON products(tenant_id, sku) WHERE sku IS NOT NULL;
CREATE INDEX idx_products_tenant ON products(tenant_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_name ON products(tenant_id, name);
CREATE INDEX idx_products_barcode ON products(tenant_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_active ON products(tenant_id, is_active);

-- 18) PRECIOS POR TIPO (histórico con vigencia)
CREATE TABLE product_prices (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price_type_id TEXT NOT NULL REFERENCES price_types(id) ON DELETE CASCADE,
    price REAL NOT NULL,
    min_quantity REAL NOT NULL DEFAULT 1,
    start_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now')),
    end_date TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(product_id, price_type_id, start_date)
);

CREATE INDEX idx_product_prices_product ON product_prices(product_id);
CREATE INDEX idx_product_prices_active ON product_prices(product_id, is_active, start_date, end_date) WHERE is_active = 1;

-- 19) TIPOS DE DESCUENTO
CREATE TABLE discount_types (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    value_type VARCHAR(1) NOT NULL CHECK (value_type IN ('P', 'F')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 20) DESCUENTOS POR PRODUCTO
CREATE TABLE product_discounts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    discount_type_id TEXT NOT NULL REFERENCES discount_types(id) ON DELETE CASCADE,
    discount_value REAL NOT NULL,
    minimum_quantity REAL NOT NULL DEFAULT 1,
    start_date TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d','now')),
    end_date TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_product_discounts_product ON product_discounts(product_id);

-- 21) DESCUENTO - TIPOS DE PRECIO APLICABLES
CREATE TABLE product_discount_price_types (
    product_discount_id TEXT NOT NULL REFERENCES product_discounts(id) ON DELETE CASCADE,
    price_type_id TEXT NOT NULL REFERENCES price_types(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (product_discount_id, price_type_id)
);

-- 22) UBICACIONES DE INVENTARIO
CREATE TABLE inventory_locations (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(tenant_id, code)
);

-- 23) LOTES DE INVENTARIO (FIFO con caducidad)
CREATE TABLE inventory_lots (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
    lot_number VARCHAR(100),
    quantity REAL NOT NULL DEFAULT 0,
    expiry_date TEXT,
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_inventory_lots_product ON inventory_lots(product_id, location_id);
CREATE INDEX idx_inventory_lots_fifo ON inventory_lots(product_id, location_id, received_at, expiry_date) WHERE is_active = 1 AND quantity > 0;
CREATE INDEX idx_inventory_lots_expiry ON inventory_lots(expiry_date) WHERE is_active = 1;

-- 24) MOVIMIENTOS DE INVENTARIO
CREATE TABLE inventory_movements (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    location_id TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT,
    lot_id TEXT REFERENCES inventory_lots(id) ON DELETE SET NULL,
    movement_type VARCHAR(20) NOT NULL CHECK (movement_type IN ('IN', 'OUT', 'ADJUSTMENT', 'RETURN', 'CANCEL')),
    quantity REAL NOT NULL,
    inventory_before REAL NOT NULL,
    inventory_after REAL NOT NULL,
    reference_type VARCHAR(20),
    reference_id TEXT,
    expiry_date TEXT,
    notes TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_inventory_movements_product ON inventory_movements(product_id, created_at);
CREATE INDEX idx_inventory_movements_reference ON inventory_movements(reference_type, reference_id);

-- 25) ALERTAS DE INVENTARIO
CREATE TABLE inventory_alerts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    location_id TEXT REFERENCES inventory_locations(id) ON DELETE SET NULL,
    alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('LOW_STOCK', 'EXPIRY_WARNING', 'EXPIRED', 'AGED_STOCK')),
    severity VARCHAR(10) NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
    message TEXT,
    is_resolved INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT,
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_inventory_alerts_unresolved ON inventory_alerts(tenant_id, is_resolved, alert_type) WHERE is_resolved = 0;
CREATE INDEX idx_inventory_alerts_product ON inventory_alerts(product_id);

-- 26) CLIENTES
CREATE TABLE customers (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(255),
    address TEXT,
    rfc VARCHAR(13),
    credit_limit REAL NOT NULL DEFAULT 0,
    current_balance REAL NOT NULL DEFAULT 0,
    loyalty_points INTEGER NOT NULL DEFAULT 0,
    loyalty_points_value REAL NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 27) TRANSACCIONES DE CRÉDITO
CREATE TABLE customer_credits (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
    amount REAL NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('SALE', 'PAYMENT', 'ADJUSTMENT')),
    notes TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_customer_credits_customer ON customer_credits(customer_id, created_at);

-- 28) VENTAS
-- folio_display es GENERATED (igual que PG): folio_prefix-000001
CREATE TABLE sales (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
    local_server_id TEXT REFERENCES local_servers(id) ON DELETE SET NULL,
    device_id VARCHAR(255) NOT NULL,
    seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    folio_number INTEGER NOT NULL,
    folio_prefix VARCHAR(10) NOT NULL DEFAULT 'V',
    folio_display TEXT GENERATED ALWAYS AS (folio_prefix || '-' || printf('%06d', folio_number)) STORED,
    subtotal REAL NOT NULL DEFAULT 0,
    discount REAL NOT NULL DEFAULT 0,
    tax REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED'
        CHECK (status IN ('COMPLETED', 'CANCELLED', 'REFUNDED')),
    payment_state VARCHAR(20) NOT NULL DEFAULT 'PAID'
        CHECK (payment_state IN ('PAID', 'PENDING', 'PARTIAL')),
    cancelled_at TEXT,
    cancelled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    cancel_reason TEXT,
    cloud_sync_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    cloud_synced_at TEXT,
    cloud_id TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CONSTRAINT uq_sales_folio UNIQUE (tenant_id, folio_prefix, folio_number)
);

CREATE INDEX idx_sales_tenant ON sales(tenant_id);
CREATE INDEX idx_sales_seller ON sales(seller_id, created_at);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_created ON sales(tenant_id, created_at);
CREATE INDEX idx_sales_status ON sales(tenant_id, status);
CREATE INDEX idx_sales_payment ON sales(tenant_id, payment_state) WHERE payment_state != 'PAID';
CREATE INDEX idx_sales_cloud ON sales(tenant_id, cloud_sync_status) WHERE cloud_sync_status = 'PENDING';

-- 29) PAGOS DE VENTA
CREATE TABLE sale_payments (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    method VARCHAR(20) NOT NULL CHECK (method IN ('CASH', 'CARD', 'TRANSFER', 'CREDIT', 'VOUCHER')),
    amount REAL NOT NULL,
    reference_code VARCHAR(100),
    change_amount REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);
CREATE INDEX idx_sale_payments_method ON sale_payments(tenant_id, method, created_at);

-- 30) ÍTEMS DE VENTA
CREATE TABLE sale_items (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    product_name VARCHAR(255) NOT NULL,
    product_barcode VARCHAR(100),
    product_base_unit_id TEXT NOT NULL REFERENCES measurement_units(id),
    product_sale_unit_id TEXT NOT NULL REFERENCES measurement_units(id),
    product_unit_conversion REAL NOT NULL DEFAULT 1,
    price_type_id TEXT REFERENCES price_types(id) ON DELETE SET NULL,
    quantity REAL NOT NULL,
    base_quantity REAL NOT NULL,
    alternate_quantity REAL,
    unit_id TEXT NOT NULL REFERENCES measurement_units(id),
    unit_price REAL NOT NULL,
    discount_applied REAL NOT NULL DEFAULT 0,
    subtotal REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

-- 31) CALIDAD DE SERVICIO (QoS)
CREATE TABLE service_quality_events (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sale_id TEXT NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
    customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
    rating VARCHAR(20) CHECK (rating IN ('EXCELLENT', 'GOOD', 'AVERAGE', 'POOR', 'TERRIBLE')),
    comment TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'COMPLETED', 'EXPIRED')),
    displayed_at TEXT,
    responded_at TEXT,
    expires_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now', '+5 minutes')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_qos_pending ON service_quality_events(tenant_id, status) WHERE status = 'PENDING';
CREATE INDEX idx_qos_expired ON service_quality_events(expires_at) WHERE status = 'PENDING';

-- 32) CORTES DE CAJA
CREATE TABLE cashier_cuts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL,
    local_server_id TEXT REFERENCES local_servers(id) ON DELETE SET NULL,
    device_id VARCHAR(255) NOT NULL,
    seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    cut_type VARCHAR(10) NOT NULL CHECK (cut_type IN ('TURN', 'DAILY')),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    total_sales REAL NOT NULL DEFAULT 0,
    total_transactions INTEGER NOT NULL DEFAULT 0,
    cash_amount REAL NOT NULL DEFAULT 0,
    card_amount REAL NOT NULL DEFAULT 0,
    transfer_amount REAL NOT NULL DEFAULT 0,
    credit_amount REAL NOT NULL DEFAULT 0,
    expected_cash REAL NOT NULL DEFAULT 0,
    counted_cash REAL NOT NULL DEFAULT 0,
    difference REAL NOT NULL DEFAULT 0,
    status VARCHAR(10) NOT NULL DEFAULT 'CLOSED' CHECK (status IN ('OPEN', 'CLOSED')),
    cloud_sync_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    cloud_synced_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_cashier_cuts_tenant ON cashier_cuts(tenant_id, created_at);
CREATE INDEX idx_cashier_cuts_seller ON cashier_cuts(seller_id, created_at);

-- 33) RELACIÓN CORTE-VENTAS
CREATE TABLE cashier_cut_sales (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    cashier_cut_id TEXT NOT NULL REFERENCES cashier_cuts(id) ON DELETE CASCADE,
    sale_id TEXT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(cashier_cut_id, sale_id)
);

CREATE INDEX idx_cashier_cut_sales_cut ON cashier_cut_sales(cashier_cut_id);
CREATE INDEX idx_cashier_cut_sales_sale ON cashier_cut_sales(sale_id);

-- 34) RETIROS DE CAJA
CREATE TABLE cashier_withdrawals (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    cashier_cut_id TEXT NOT NULL REFERENCES cashier_cuts(id) ON DELETE CASCADE,
    amount REAL NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 35) ENTRADAS DE MERCANCÍA
CREATE TABLE purchase_orders (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    supplier_id TEXT REFERENCES suppliers(id) ON DELETE SET NULL,
    location_id TEXT REFERENCES inventory_locations(id) ON DELETE SET NULL,
    invoice_number VARCHAR(100),
    total_cost REAL NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'COMPLETED'
        CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELLED')),
    notes TEXT,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    cloud_sync_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE purchase_order_items (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    lot_id TEXT REFERENCES inventory_lots(id) ON DELETE SET NULL,
    quantity REAL NOT NULL,
    unit_cost REAL NOT NULL,
    total_cost REAL NOT NULL,
    expiry_date TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 36) COLA DE IMPRESIÓN
CREATE TABLE print_jobs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    source_device_id VARCHAR(255) NOT NULL,
    target_device_id VARCHAR(255) NOT NULL,
    sale_id TEXT REFERENCES sales(id) ON DELETE SET NULL,
    cashier_cut_id TEXT REFERENCES cashier_cuts(id) ON DELETE SET NULL,
    job_type VARCHAR(20) NOT NULL CHECK (job_type IN ('SALE_TICKET', 'CUT_TICKET', 'TEST', 'Z_REPORT')),
    content TEXT NOT NULL,
    content_format VARCHAR(10) NOT NULL DEFAULT 'ESC_POS' CHECK (content_format IN ('ESC_POS', 'JSON')),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PRINTING', 'COMPLETED', 'FAILED')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    error_message TEXT,
    printed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_print_jobs_pending ON print_jobs(target_device_id, status) WHERE status IN ('PENDING', 'FAILED');
CREATE INDEX idx_print_jobs_tenant ON print_jobs(tenant_id, created_at);

-- 37) COMANDOS DE SINCRONIZACIÓN (Command-Based Sync)
CREATE TABLE sync_commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    command_id TEXT NOT NULL UNIQUE,
    command_type VARCHAR(20) NOT NULL CHECK (command_type IN ('CREATE', 'UPDATE', 'DELETE')),
    entity_type VARCHAR(50) NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT NOT NULL,          -- JSONB → TEXT en SQLite
    source VARCHAR(10) NOT NULL DEFAULT 'LOCAL' CHECK (source IN ('LOCAL', 'REMOTE')),
    sequence_number INTEGER,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'PROCESSING', 'SYNCED', 'FAILED', 'ACKED')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 5,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    processed_at TEXT,
    acked_at TEXT
);

CREATE INDEX idx_sync_commands_status ON sync_commands(status, created_at);
CREATE INDEX idx_sync_commands_tenant ON sync_commands(tenant_id);
CREATE INDEX idx_sync_commands_entity ON sync_commands(entity_type, entity_id);
CREATE INDEX idx_sync_commands_source ON sync_commands(source, status) WHERE source = 'LOCAL' AND status = 'PENDING';

-- 38) CONFLICTOS DE SINCRONIZACIÓN
CREATE TABLE sync_conflicts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type VARCHAR(50) NOT NULL,
    entity_id TEXT NOT NULL,
    local_payload TEXT NOT NULL,
    server_payload TEXT NOT NULL,
    resolution VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (resolution IN ('PENDING', 'LOCAL_WINS', 'SERVER_WINS', 'MERGED')),
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_sync_conflicts_pending ON sync_conflicts(tenant_id, resolution) WHERE resolution = 'PENDING';

-- 39) LOG DE AUDITORÍA
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL,
    user_id TEXT,
    device_id VARCHAR(255),
    action VARCHAR(50) NOT NULL,
    table_name VARCHAR(50),
    record_id TEXT,
    old_values TEXT,
    new_values TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);
CREATE INDEX idx_audit_action ON audit_log(action, table_name);

-- 40) TICKETS ALMACENADOS
CREATE TABLE stored_tickets (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sale_id TEXT REFERENCES sales(id) ON DELETE CASCADE,
    cashier_cut_id TEXT REFERENCES cashier_cuts(id) ON DELETE CASCADE,
    ticket_type VARCHAR(20) NOT NULL CHECK (ticket_type IN ('SALE', 'CUT', 'REFUND')),
    content TEXT NOT NULL,
    content_format VARCHAR(10) NOT NULL DEFAULT 'ESC_POS' CHECK (content_format IN ('ESC_POS', 'JSON')),
    printed_at TEXT,
    reprinted_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_stored_tickets_sale ON stored_tickets(sale_id);
CREATE INDEX idx_stored_tickets_cut ON stored_tickets(cashier_cut_id);

-- 41) SESIONES ACTIVAS
CREATE TABLE active_sessions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    device_id VARCHAR(255) NOT NULL,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    local_server_id TEXT REFERENCES local_servers(id) ON DELETE SET NULL,
    jwt_token_hash VARCHAR(255) NOT NULL,
    expires_at TEXT NOT NULL,
    ip_address TEXT,
    is_valid INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_active_sessions_device ON active_sessions(tenant_id, device_id, is_valid);
CREATE INDEX idx_active_sessions_expires ON active_sessions(expires_at);
