import Database from "@tauri-apps/plugin-sql";

export interface Product {
  id: number;
  name: string;
  price: number;
  cost: number;
  barcode: string;
  stock: number;
  category?: string;
  company?: string;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  total_udhar: number;
}

export interface Sale {
  id: number;
  total: number;
  cash: number;
  change_amt: number;
  customer_id: number | null;
  type: string;
  created_at: string;
  profit?: number;
}

export interface SaleItem {
  id: number;
  sale_id: number;
  product_id?: number;
  product_name: string;
  qty: number;
  price: number;
  cost?: number;
}

export interface KhataEntry {
  id: number;
  customer_id: number;
  amount: number;
  note: string;
  type: string;
  created_at: string;
}

// ---------- Helpers ----------
export function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeLike(q: string) {
  return q.replace(/[\\%_]/g, (c) => "\\" + c);
}

// ---------- Custom Barcode ----------
// ⚠️ DEPRECATED: Ab isko kahin call mat karo.
// Scanner se asal barcode aayega, warna barcode blank rahega.
// Ye function sirf is liye rakha hai taake purana import na toote.
export function generateCustomBarcode(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
  return `MAD-${ts}${rand}`.slice(0, 14);
}

export function normalizeBarcode(b: string): string {
  return (b || "").trim().toUpperCase().replace(/[\s-]/g, "");
}

// ✅ FIX: Barcode khaali hai to khaali hi rahe - nakli MAD- mat banao
// Scanner se aayega to wahi save hoga, warna blank rahega
export async function ensureBarcode(productId: number, barcode: string): Promise<string> {
  const db = await getDb();
  const code = normalizeBarcode(barcode);
  if (!code) return "";
  await db.execute("UPDATE products SET barcode = $1 WHERE id = $2", [code, productId]);
  return code;
}

// ---------- DB Singleton ----------
let dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = initDb();
  return dbPromise;
}

async function initDb(): Promise<Database> {
  const db = await Database.load("sqlite:madina.db");

  await db.execute(`PRAGMA journal_mode = WAL`);
  await db.execute(`PRAGMA synchronous = NORMAL`);
  await db.execute(`PRAGMA busy_timeout = 5000`);
  await db.execute(`PRAGMA cache_size = -64000`);
  await db.execute(`PRAGMA foreign_keys = ON`);

  await db.execute(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, price REAL, cost REAL, barcode TEXT, stock INTEGER,
    category TEXT DEFAULT 'General', company TEXT DEFAULT ''
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, phone TEXT, total_udhar REAL DEFAULT 0
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total REAL, cash REAL, change_amt REAL,
    customer_id INTEGER, type TEXT DEFAULT 'cash',
    profit REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER, product_id INTEGER, product_name TEXT, qty INTEGER, price REAL, cost REAL DEFAULT 0
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS khata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER, amount REAL, note TEXT,
    type TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  async function addColumnIfMissing(table: string, column: string, def: string) {
    try {
      const cols = await db.select<{ name: string }[]>(`PRAGMA table_info(${table})`);
      const exists = cols.some((c) => c.name === column);
      if (!exists) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
      }
    } catch { /* ignore */ }
  }

  await addColumnIfMissing("sales", "created_at", "TEXT DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing("sales", "cash", "REAL DEFAULT 0");
  await addColumnIfMissing("sales", "change_amt", "REAL DEFAULT 0");
  await addColumnIfMissing("sales", "customer_id", "INTEGER");
  await addColumnIfMissing("sales", "type", "TEXT DEFAULT 'cash'");
  await addColumnIfMissing("sales", "total", "REAL DEFAULT 0");
  await addColumnIfMissing("sales", "profit", "REAL DEFAULT 0");
  await addColumnIfMissing("customers", "total_udhar", "REAL DEFAULT 0");
  await addColumnIfMissing("customers", "phone", "TEXT");
  await addColumnIfMissing("khata", "created_at", "TEXT DEFAULT CURRENT_TIMESTAMP");
  await addColumnIfMissing("khata", "note", "TEXT DEFAULT ''");
  await addColumnIfMissing("khata", "type", "TEXT DEFAULT 'udhar'");
  await addColumnIfMissing("products", "category", "TEXT DEFAULT 'General'");
  await addColumnIfMissing("products", "company", "TEXT DEFAULT ''");
  await addColumnIfMissing("sale_items", "product_id", "INTEGER");
  await addColumnIfMissing("sale_items", "cost", "REAL DEFAULT 0");

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_products_name ON products(name)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_khata_customer ON khata(customer_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)`);
  await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode_unique ON products(barcode) WHERE barcode IS NOT NULL AND barcode != ''`);

  return db;
}

// ---------- Bulk Import - FIXED: Partial index wala ON CONFLICT ----------
export async function bulkImportProducts(
  rows: { name: string; price: number; cost: number; barcode: string; stock: number; category?: string; company?: string }[]
) {
  const db = await getDb();
  await db.execute("BEGIN TRANSACTION");
  try {
    for (const r of rows) {
      if (!r.name?.trim()) continue;
      const code = normalizeBarcode(r.barcode || "");
      // ✅ FIX: Barcode khaali hai to khaali hi rahe - nakli MAD- mat banao
      // ✅ ON CONFLICT me WHERE barcode != '' zaroori hai - warna partial index match nahi hota
      await db.execute(
        `INSERT INTO products (name, price, cost, barcode, stock, category, company)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(barcode) WHERE barcode != '' DO UPDATE SET
           name=excluded.name, price=excluded.price, cost=excluded.cost,
           stock=excluded.stock, category=excluded.category, company=excluded.company`,
        [r.name.trim(), r.price || 0, r.cost || 0, code, r.stock || 0, r.category || "General", r.company || ""]
      );
    }
    await db.execute("COMMIT");
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
}

// ---------- Search - FIXED: DB side bhi dash hatao ----------
export async function searchProductsFast(q: string, limit = 100): Promise<Product[]> {
  const db = await getDb();
  const term = q.trim();
  if (!term) {
    return db.select<Product[]>("SELECT * FROM products ORDER BY id DESC LIMIT $1", [limit]);
  }
  const code = normalizeBarcode(term);
  // ✅ REPLACE - "MAD-123" aur "MAD123" dono milenge
  const exact = await db.select<Product[]>("SELECT * FROM products WHERE REPLACE(UPPER(barcode), '-', '') = $1 LIMIT 1", [code]);
  if (exact.length > 0) return exact;

  if (/^[0-9A-Z-]+$/.test(code)) {
    const prefix = await db.select<Product[]>(
      "SELECT * FROM products WHERE REPLACE(UPPER(barcode), '-', '') LIKE $1 ESCAPE '\\' LIMIT $2",
      [`${escapeLike(code)}%`, limit]
    );
    if (prefix.length > 0) return prefix;
  }

  const like = `%${escapeLike(term)}%`;
  return db.select<Product[]>(
    "SELECT * FROM products WHERE name LIKE $1 ESCAPE '\\' OR category LIKE $1 ESCAPE '\\' ORDER BY name LIMIT $2",
    [like, limit]
  );
}

// ---------- Atomic Sale - FIXED: Stock kam ho to rollback ----------
export async function saveSaleAtomic(args: {
  items: { product_id: number; product_name: string; qty: number; price: number; cost: number }[];
  total: number; cash: number; change_amt: number;
  customer_id: number | null; type: string; profit: number;
  khataAmount?: number; khataNote?: string;
}): Promise<number> {
  const db = await getDb();
  await db.execute("BEGIN TRANSACTION");
  try {
    const res = await db.execute(
      "INSERT INTO sales (total, cash, change_amt, customer_id, type, profit, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [args.total, args.cash, args.change_amt, args.customer_id, args.type, args.profit, nowLocal()]
    );
    const saleId = Number(res.lastInsertId ?? 0);
    if (!saleId) throw new Error("Sale insert failed");

    for (const it of args.items) {
      await db.execute(
        "INSERT INTO sale_items (sale_id, product_id, product_name, qty, price, cost) VALUES ($1,$2,$3,$4,$5,$6)",
        [saleId, it.product_id, it.product_name, it.qty, it.price, it.cost]
      );
      // ✅ rowsAffected check - 0 matlab stock kam tha, poori sale wapis lo
      const upd = await db.execute(
        "UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1",
        [it.qty, it.product_id]
      );
      if ((upd.rowsAffected ?? 1) === 0) throw new Error(`Stock kam hai: ${it.product_name}`);
    }

    if (args.type === "udhar" && args.customer_id && (args.khataAmount ?? 0) > 0) {
      await db.execute(
        "INSERT INTO khata (customer_id, amount, note, type, created_at) VALUES ($1,$2,$3,'udhar',$4)",
        [args.customer_id, args.khataAmount, args.khataNote || "", nowLocal()]
      );
      await db.execute(
        "UPDATE customers SET total_udhar = total_udhar + $1 WHERE id = $2",
        [args.khataAmount, args.customer_id]
      );
    }

    await db.execute("COMMIT");
    return saleId;
  } catch (e) {
    await db.execute("ROLLBACK");
    throw e;
  }
}

export async function getDashboardStats() {
  const db = await getDb();
  const prodCount = await db.select<{ c: number }[]>("SELECT COUNT(*) as c FROM products");
  const stockVal = await db.select<{ v: number }[]>("SELECT COALESCE(SUM(price * stock), 0) as v FROM products");
  const today = await db.select<{ s: number; p: number; b: number }[]>(
    "SELECT COALESCE(SUM(total),0) as s, COALESCE(SUM(profit),0) as p, COUNT(*) as b FROM sales WHERE date(created_at) = date('now','localtime')"
  );
  const low = await db.select<{ c: number }[]>("SELECT COUNT(*) as c FROM products WHERE stock <= 5");
  const udhar = await db.select<{ u: number }[]>("SELECT COALESCE(SUM(total_udhar),0) as u FROM customers");
  return {
    products: prodCount[0]?.c ?? 0,
    stockValue: stockVal[0]?.v ?? 0,
    todaySale: today[0]?.s ?? 0,
    todayProfit: today[0]?.p ?? 0,
    todayBills: today[0]?.b ?? 0,
    lowStock: low[0]?.c ?? 0,
    udhar: udhar[0]?.u ?? 0,
  };
}

export async function getOrCreateCustomer(name: string, phone = ""): Promise<number> {
  const db = await getDb();
  const clean = name.trim();
  const found = await db.select<Customer[]>("SELECT * FROM customers WHERE LOWER(name) = LOWER($1) LIMIT 1", [clean]);
  if (found.length > 0) return found[0].id;
  const res = await db.execute("INSERT INTO customers (name, phone, total_udhar) VALUES ($1,$2,0)", [clean, phone]);
  return Number(res.lastInsertId ?? 0);
}

export async function getAllCategories(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select<{ category: string }[]>(
    "SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != '' ORDER BY category"
  );
  const fromDb = rows.map(r => r.category);
  const defaults = ["General", "Mobile Accessories", "Manyari", "Cosmetics", "Other"];
  return [...new Set([...defaults, ...fromDb])];
}