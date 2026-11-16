import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { listPendingSales } from "./offlineQueue";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
type Shop = { tenantId: string; shopName: string; slug: string; role: string };
type Branch = { id: string; name: string; code: string; isDefault: boolean };
type Product = { id: string; sku: string; name: string; price: string; taxRate: string; availableStock: number; description?: string };
type CartLine = { productId: string; quantity: number };
type Party = { id: string; name: string; phone?: string | null };
type Receipt = { id: string; receiptNumber: string; supplierName?: string | null; grandTotal: string; createdAt: string };
type Sale = { id: string; orderNumber: string; status: string; channel: string; grandTotal: string; items: Array<{ productId: string; quantity: number }> };
type Overview = { today: { posSalesCount: number; posRevenue: string; purchaseSpend: string }; inventory: { available: number; low_stock: number }; online: { pendingOrders: number } };
type StoreSettings = { displayName: string; primaryColor: string; supportEmail?: string | null; supportPhone?: string | null; isPublished: boolean };
type GatewaySettings = { keyId: string; mode: "test" | "live"; isEnabled: boolean };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authMessage, setAuthMessage] = useState("");
  const [shops, setShops] = useState<Shop[]>([]);
  const [tenantId, setTenantId] = useState(localStorage.getItem("usms.activeTenant") ?? "");
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [shopName, setShopName] = useState("");
  const [slug, setSlug] = useState("");
  const [branchName, setBranchName] = useState("Main Branch");
  const [newSku, setNewSku] = useState("");
  const [newName, setNewName] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [newTax, setNewTax] = useState("0");
  const [stockProductId, setStockProductId] = useState("");
  const [stockDelta, setStockDelta] = useState("10");
  const [customers, setCustomers] = useState<Party[]>([]);
  const [suppliers, setSuppliers] = useState<Party[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierPhone, setNewSupplierPhone] = useState("");
  const [purchaseProductId, setPurchaseProductId] = useState("");
  const [purchaseSupplierId, setPurchaseSupplierId] = useState("");
  const [purchaseQuantity, setPurchaseQuantity] = useState("1");
  const [purchaseCost, setPurchaseCost] = useState("");
  const [returnSaleId, setReturnSaleId] = useState("");
  const [returnProductId, setReturnProductId] = useState("");
  const [returnQuantity, setReturnQuantity] = useState("1");
  const [storeSettings, setStoreSettings] = useState<StoreSettings | null>(null);
  const [storeDisplayName, setStoreDisplayName] = useState("");
  const [storeColor, setStoreColor] = useState("#2563eb");
  const [storeSupportPhone, setStoreSupportPhone] = useState("");
  const [storeSupportEmail, setStoreSupportEmail] = useState("");
  const [gatewaySettings, setGatewaySettings] = useState<GatewaySettings | null>(null);
  const [gatewayKeyId, setGatewayKeyId] = useState("");
  const [gatewayKeySecret, setGatewayKeySecret] = useState("");
  const [gatewayWebhookSecret, setGatewayWebhookSecret] = useState("");
  const [gatewayMode, setGatewayMode] = useState<"test" | "live">("test");

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return; }
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    void listPendingSales().then((rows) => setPendingCount(rows.length)).catch(() => setPendingCount(null));
  }, []);

  async function api<T>(path: string, init: RequestInit = {}, selectedTenant?: string): Promise<T> {
    if (!session?.access_token) throw new Error("Your session has expired. Please sign in again.");
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${session.access_token}`);
    if (selectedTenant) headers.set("X-USMS-Tenant", selectedTenant);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const response = await fetch(API_URL + path, { ...init, headers });
    const data = await response.json() as T & { error?: { message?: string } };
    if (!response.ok) throw new Error(data.error?.message ?? `Request failed (${response.status}).`);
    return data;
  }

  async function loadShops() {
    if (!session) return;
    try {
      const data = await api<{ shops: Shop[] }>("/api/v1/me/shops");
      setShops(data.shops);
      const saved = localStorage.getItem("usms.activeTenant");
      const chosen = data.shops.find((shop) => shop.tenantId === saved) ?? data.shops[0];
      if (chosen && chosen.tenantId !== tenantId) setTenantId(chosen.tenantId);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load shops."); }
  }

  async function loadBusinessData(selectedTenant = tenantId) {
    if (!session || !selectedTenant) return;
    setLoading(true);
    try {
      const [branchData, productData, customerData, supplierData, receiptData, salesData, reportData, storeData, gatewayData] = await Promise.all([
        api<{ branches: Branch[] }>("/api/v1/business/branches", {}, selectedTenant),
        api<{ products: Product[] }>("/api/v1/business/products", {}, selectedTenant),
        api<{ customers: Party[] }>("/api/v1/business/customers", {}, selectedTenant),
        api<{ suppliers: Party[] }>("/api/v1/business/suppliers", {}, selectedTenant),
        api<{ receipts: Receipt[] }>("/api/v1/business/purchases/receipts", {}, selectedTenant),
        api<{ sales: Sale[] }>("/api/v1/business/sales", {}, selectedTenant),
        api<Overview>("/api/v1/business/reports/overview", {}, selectedTenant),
        api<{ settings: StoreSettings }>("/api/v1/business/storefront", {}, selectedTenant),
        api<{ razorpay: GatewaySettings | null }>("/api/v1/business/payments/razorpay", {}, selectedTenant),
      ]);
      setBranches(branchData.branches);
      const chosenBranch = branchData.branches.find((branch) => branch.isDefault) ?? branchData.branches[0];
      setBranchId(chosenBranch?.id ?? "");
      setProducts(productData.products);
      setStockProductId((current) => current || productData.products[0]?.id || "");
      setCustomers(customerData.customers);
      setSuppliers(supplierData.suppliers);
      setReceipts(receiptData.receipts);
      setSales(salesData.sales);
      setOverview(reportData);
      setStoreSettings(storeData.settings);
      setStoreDisplayName(storeData.settings?.displayName ?? "");
      setStoreColor(storeData.settings?.primaryColor ?? "#2563eb");
      setStoreSupportPhone(storeData.settings?.supportPhone ?? "");
      setStoreSupportEmail(storeData.settings?.supportEmail ?? "");
      setGatewaySettings(gatewayData.razorpay);
      setGatewayKeyId(gatewayData.razorpay?.keyId ?? "");
      setGatewayMode(gatewayData.razorpay?.mode ?? "test");
      setPurchaseProductId((current) => current || productData.products[0]?.id || "");
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load shop data."); }
    finally { setLoading(false); }
  }

  useEffect(() => { if (session) void loadShops(); else { setShops([]); setProducts([]); } }, [session]);
  useEffect(() => {
    if (tenantId && session) {
      localStorage.setItem("usms.activeTenant", tenantId);
      void loadBusinessData(tenantId);
    }
  }, [tenantId, session]);


  useEffect(() => {
    if (!session || !tenantId) return;
    const controller = new AbortController();
    async function streamInventory() {
      try {
        const response = await fetch(API_URL + "/api/v1/business/events", {
          headers: { Authorization: `Bearer ${session!.access_token}`, "X-USMS-Tenant": tenantId },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          if (frames.some((frame) => frame.startsWith("data: "))) void loadBusinessData(tenantId);
        }
      } catch (e) {
        if (!controller.signal.aborted) console.warn("Inventory live updates disconnected.", e);
      }
    }
    void streamInventory();
    return () => controller.abort();
  }, [session, tenantId]);

  async function authenticate(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setError(""); setAuthMessage("");
    const result = authMode === "signin"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password });
    if (result.error) setError(result.error.message);
    else if (authMode === "signup" && !result.data.session) setAuthMessage("Account created. Check your email to confirm it, then sign in.");
    else setAuthMessage("Authentication successful.");
  }

  async function createShop(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      const data = await api<{ tenant: { id: string }; branch: Branch }>("/api/v1/onboarding/shop", {
        method: "POST",
        body: JSON.stringify({ shopName, slug, branchName }),
      });
      setShops((current) => [...current, { tenantId: data.tenant.id, shopName, slug, role: "owner" }]);
      setTenantId(data.tenant.id);
      setMessage("Shop created. Add products and opening stock to get started.");
    } catch (e) { setError(e instanceof Error ? e.message : "Shop setup failed."); }
  }

  async function addProduct(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await api("/api/v1/business/products", { method: "POST", body: JSON.stringify({ branchId, sku: newSku, name: newName, price: newPrice, taxRate: newTax }) }, tenantId);
      setNewSku(""); setNewName(""); setNewPrice(""); setNewTax("0");
      await loadBusinessData();
      setMessage("Product added. Now set its opening stock.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add product."); }
  }

  async function adjustStock(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await api("/api/v1/business/inventory/adjustments", {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ branchId, productId: stockProductId, delta: Number(stockDelta), note: "Stock received / manual opening balance" }),
      }, tenantId);
      await loadBusinessData();
      setMessage("Inventory updated successfully.");
    } catch (e) { setError(e instanceof Error ? e.message : "Stock update failed."); }
  }




  async function saveGateway(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      const data = await api<{ razorpay: GatewaySettings }>("/api/v1/business/payments/razorpay", {
        method: "PUT",
        body: JSON.stringify({ keyId: gatewayKeyId, keySecret: gatewayKeySecret, webhookSecret: gatewayWebhookSecret, mode: gatewayMode }),
      }, tenantId);
      setGatewaySettings(data.razorpay);
      setGatewayKeySecret(""); setGatewayWebhookSecret("");
      setMessage("Razorpay account settings saved securely. Configure the webhook URL in your Razorpay Dashboard before accepting live payments.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save payment settings."); }
  }

  async function saveStorefront(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      const data = await api<{ settings: StoreSettings }>("/api/v1/business/storefront", {
        method: "PUT",
        body: JSON.stringify({ displayName: storeDisplayName, primaryColor: storeColor, supportPhone: storeSupportPhone, supportEmail: storeSupportEmail, isPublished: storeSettings?.isPublished ?? false }),
      }, tenantId);
      setStoreSettings(data.settings);
      setMessage(data.settings.isPublished ? "Your online store is now published." : "Your online store has been unpublished.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update your online store."); }
  }


  async function toggleStorefrontPublish() {
    setError(""); setMessage("");
    try {
      const data = await api<{ settings: StoreSettings }>("/api/v1/business/storefront", {
        method: "PUT",
        body: JSON.stringify({ displayName: storeDisplayName, primaryColor: storeColor, supportPhone: storeSupportPhone, supportEmail: storeSupportEmail, isPublished: !storeSettings?.isPublished }),
      }, tenantId);
      setStoreSettings(data.settings);
      setMessage(data.settings.isPublished ? "Your online store is now published." : "Your online store has been unpublished.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not change store publishing status."); }
  }

  async function addCustomer(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await api("/api/v1/business/customers", { method: "POST", body: JSON.stringify({ name: newCustomerName, phone: newCustomerPhone }) }, tenantId);
      setNewCustomerName(""); setNewCustomerPhone(""); await loadBusinessData(); setMessage("Customer saved.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save customer."); }
  }
  async function addSupplier(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await api("/api/v1/business/suppliers", { method: "POST", body: JSON.stringify({ name: newSupplierName, phone: newSupplierPhone }) }, tenantId);
      setNewSupplierName(""); setNewSupplierPhone(""); await loadBusinessData(); setMessage("Supplier saved.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save supplier."); }
  }
  async function receivePurchase(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await api("/api/v1/business/purchases/receipts", {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ branchId, supplierId: purchaseSupplierId || undefined, items: [{ productId: purchaseProductId, quantity: Number(purchaseQuantity), unitCost: purchaseCost, taxRate: newTax }] }),
      }, tenantId);
      setPurchaseQuantity("1"); setPurchaseCost(""); await loadBusinessData(); setMessage("Goods received. Shared stock has been increased.");
    } catch (e) { setError(e instanceof Error ? e.message : "Goods receipt failed."); }
  }
  async function processReturn(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try {
      await api(`/api/v1/business/sales/${returnSaleId}/returns`, {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ items: [{ productId: returnProductId, quantity: Number(returnQuantity) }], restock: true, reason: "Customer return" }),
      }, tenantId);
      setReturnSaleId(""); setReturnProductId(""); setReturnQuantity("1"); await loadBusinessData();
      setMessage("Return recorded and accepted units returned to stock. Refund settlement remains a separate step.");
    } catch (e) { setError(e instanceof Error ? e.message : "Return could not be processed."); }
  }

  const cartTotal = useMemo(() => cart.reduce((sum, line) => {
    const product = products.find((item) => item.id === line.productId);
    return sum + (product ? Number(product.price) * line.quantity * (1 + Number(product.taxRate) / 100) : 0);
  }, 0), [cart, products]);

  function addToCart(product: Product) {
    setCart((current) => {
      const line = current.find((item) => item.productId === product.id);
      if (line) return current.map((item) => item.productId === product.id ? { ...item, quantity: Math.min(product.availableStock, item.quantity + 1) } : item);
      return product.availableStock > 0 ? [...current, { productId: product.id, quantity: 1 }] : current;
    });
  }

  async function completeSale() {
    setError(""); setMessage("");
    if (!branchId || !cart.length) return;
    try {
      const data = await api<{ order: { orderNumber: string; grandTotal: string } }>("/api/v1/pos/sales", {
        method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ branchId, items: cart }),
      }, tenantId);
      setCart([]);
      await loadBusinessData();
      setMessage(`Sale ${data.order.orderNumber} completed · ₹${data.order.grandTotal}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Sale could not be completed."); }
  }

  if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
    return <main className="setup-screen"><div className="setup-card"><span className="brand-mark">U</span><p className="eyebrow">USMS BUSINESS PLATFORM</p><h1>Connect your identity provider.</h1><p>Configure <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in <code>apps/pos/.env</code>, then restart the app.</p></div></main>;
  }
  if (!authReady) return <main className="setup-screen"><div className="setup-card">Loading secure session…</div></main>;
  if (!session) return <main className="auth-screen"><section className="auth-aside"><span className="brand-mark">U</span><p className="eyebrow">ONE STORE. ONE SYSTEM.</p><h1>Run your store<br/><em>without limits.</em></h1><p>Billing, stock and your own online shop — finally working together.</p><div className="auth-aside-foot">USMS · BUSINESS APP</div></section><form className="auth-card" onSubmit={authenticate}><span className="eyebrow">WELCOME TO USMS</span><h2>{authMode === "signin" ? "Sign in to your shop" : "Create your account"}</h2><p>Access your business workspace securely.</p><label>Email address<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="you@yourshop.com"/></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder="At least 8 characters"/></label><button className="primary-button">{authMode === "signin" ? "Sign in" : "Create account"} <span>↗</span></button><button type="button" className="text-button" onClick={() => setAuthMode(authMode === "signin" ? "signup" : "signin")}>{authMode === "signin" ? "New to USMS? Create an account" : "Already registered? Sign in"}</button>{error && <p className="error-text">{error}</p>}{authMessage && <p className="success-text">{authMessage}</p>}</form></main>;

  if (!shops.length) return <main className="setup-screen"><form className="setup-card" onSubmit={createShop}><span className="brand-mark">U</span><p className="eyebrow">LET'S SET UP YOUR BUSINESS</p><h1>Your shop starts here.</h1><p>Create your business workspace and we'll prepare its own online store.</p><label>Business / shop name<input value={shopName} onChange={(e) => setShopName(e.target.value)} required placeholder="e.g. Shree Mart"/></label><label>Store website address<input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} required minLength={3} placeholder="shree-mart"/><small>https://{slug || "your-shop"}.usms.in</small></label><label>First branch name<input value={branchName} onChange={(e) => setBranchName(e.target.value)} required/></label><button className="primary-button">Create my shop ↗</button>{error && <p className="error-text">{error}</p>}</form></main>;

  const activeShop = shops.find((shop) => shop.tenantId === tenantId);
  return <main className="business-app">
    <aside className="sidebar"><div className="side-brand"><span className="brand-mark">U</span><span>USMS<small>BUSINESS</small></span></div><div className="side-label">WORKSPACE</div><a className="side-link active" href="#overview">▦ Overview</a><a className="side-link" href="#products">▤ Products & stock</a><a className="side-link" href="#billing">▣ Point of sale</a><div className="side-bottom"><div className="online-indicator"><span/> API CONNECTED WHEN ONLINE</div><button className="side-logout" onClick={() => void supabase?.auth.signOut()}>↪ Sign out</button></div></aside>
    <section className="main-panel"><header className="business-topbar"><div><span className="eyebrow">BUSINESS WORKSPACE</span><h2>{activeShop?.shopName ?? "Your shop"}</h2></div><div className="topbar-actions"><select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{shops.map((shop) => <option key={shop.tenantId} value={shop.tenantId}>{shop.shopName}</option>)}</select><span className="user-avatar">{session.user.email?.slice(0,1).toUpperCase()}</span></div></header>
      {error && <div className="alert error-alert">{error}</div>}{message && <div className="alert success-alert">{message}</div>}
      <section id="overview" className="welcome-row"><div><p className="eyebrow">YOUR BUSINESS, AT A GLANCE</p><h1>Good evening.</h1><p>Everything your physical and online store needs, in one place.</p></div><div className="branch-chip">⌖ {branches.find((b) => b.id === branchId)?.name ?? "Loading branch"}</div></section>
      <section className="metric-grid"><article><span>PRODUCTS</span><strong>{products.length}</strong><small>In your catalogue</small></article><article><span>AVAILABLE STOCK</span><strong>{products.reduce((sum,p) => sum + p.availableStock,0)}</strong><small>Across this shop</small></article><article><span>LOW STOCK</span><strong>{products.filter((p) => p.availableStock > 0 && p.availableStock <= 5).length}</strong><small>5 units or fewer</small></article><article><span>OFFLINE QUEUE</span><strong>{pendingCount ?? "—"}</strong><small>Pending local sales</small></article></section>
      <section className="management-grid" id="products"><div className="panel-card"><div className="panel-heading"><div><span className="eyebrow">CATALOGUE</span><h3>Products & inventory</h3></div><span className="muted">{products.length} ITEMS</span></div>{loading ? <p>Loading products…</p> : <div className="product-table"><div className="table-head"><span>PRODUCT</span><span>PRICE</span><span>AVAILABLE</span></div>{products.map((product) => <div className="table-row" key={product.id}><div><b>{product.name}</b><small>{product.sku}</small></div><span>₹{Number(product.price).toFixed(2)}</span><strong className={product.availableStock <= 5 ? "low-stock" : ""}>{product.availableStock}</strong></div>)}</div>}
        <form className="inline-form" onSubmit={addProduct}><h4>Add a product</h4><div className="form-grid"><input value={newSku} onChange={(e)=>setNewSku(e.target.value)} required placeholder="SKU / barcode"/><input value={newName} onChange={(e)=>setNewName(e.target.value)} required placeholder="Product name"/><input value={newPrice} onChange={(e)=>setNewPrice(e.target.value)} required type="number" min="0" step="0.01" placeholder="Price ₹"/><input value={newTax} onChange={(e)=>setNewTax(e.target.value)} type="number" min="0" max="100" step="0.01" placeholder="Tax %"/></div><button className="secondary-button" disabled={!branchId}>Save product</button></form>
        <form className="inline-form stock-form" onSubmit={adjustStock}><h4>Receive / adjust stock</h4><div className="form-grid"><select value={stockProductId} onChange={(e)=>setStockProductId(e.target.value)} required><option value="">Select product</option>{products.map((p)=><option key={p.id} value={p.id}>{p.name} · {p.availableStock} available</option>)}</select><input type="number" step="1" value={stockDelta} onChange={(e)=>setStockDelta(e.target.value)} required placeholder="Quantity change (+/-)"/></div><button className="secondary-button" disabled={!stockProductId}>Update stock</button></form>
      </div>
      <div className="panel-card pos-card" id="billing"><div className="panel-heading"><div><span className="eyebrow">COUNTER BILLING</span><h3>Quick sale</h3></div><span className="live-label">● LIVE STOCK</span></div><div className="pos-products">{products.filter((p)=>p.availableStock>0).slice(0,8).map((product)=><button key={product.id} className="pos-product" onClick={()=>addToCart(product)}><span>{product.name}</span><b>₹{Number(product.price).toFixed(2)}</b><small>{product.availableStock} available · Add +</small></button>)}</div><div className="sale-summary"><h4>Current bill <span>{cart.reduce((n,l)=>n+l.quantity,0)} items</span></h4>{cart.map((line)=>{const product=products.find((p)=>p.id===line.productId);return <div className="bill-line" key={line.productId}><span>{product?.name} × {line.quantity}</span><b>₹{((Number(product?.price??0)*line.quantity)*(1+Number(product?.taxRate??0)/100)).toFixed(2)}</b><button onClick={()=>setCart((current)=>current.filter((x)=>x.productId!==line.productId))}>×</button></div>})}<div className="bill-total"><span>Estimated total</span><strong>₹{cartTotal.toFixed(2)}</strong></div><button className="primary-button" disabled={!cart.length || loading} onClick={()=>void completeSale()}>Complete sale · ₹{cartTotal.toFixed(2)} ↗</button><small>Server verifies final prices and available stock before billing.</small></div></div></section>

      <section className="support-grid">
        <div className="panel-card"><div className="panel-heading"><div><span className="eyebrow">RELATIONSHIPS</span><h3>Customers & suppliers</h3></div></div>
          <form className="inline-form" onSubmit={addCustomer}><h4>Add customer</h4><div className="form-grid"><input value={newCustomerName} onChange={(e)=>setNewCustomerName(e.target.value)} required placeholder="Customer name"/><input value={newCustomerPhone} onChange={(e)=>setNewCustomerPhone(e.target.value)} placeholder="Mobile number"/></div><button className="secondary-button">Save customer</button></form>
          <form className="inline-form" onSubmit={addSupplier}><h4>Add supplier</h4><div className="form-grid"><input value={newSupplierName} onChange={(e)=>setNewSupplierName(e.target.value)} required placeholder="Supplier name"/><input value={newSupplierPhone} onChange={(e)=>setNewSupplierPhone(e.target.value)} placeholder="Mobile number"/></div><button className="secondary-button">Save supplier</button></form>
          <div className="mini-lists"><span>{customers.length} customers</span><span>{suppliers.length} suppliers</span></div>
        </div>
        <div className="panel-card"><div className="panel-heading"><div><span className="eyebrow">PURCHASING</span><h3>Receive goods</h3></div></div>
          <form className="inline-form" onSubmit={receivePurchase}><div className="form-grid"><select value={purchaseProductId} onChange={(e)=>setPurchaseProductId(e.target.value)} required><option value="">Product</option>{products.map((p)=><option key={p.id} value={p.id}>{p.name}</option>)}</select><select value={purchaseSupplierId} onChange={(e)=>setPurchaseSupplierId(e.target.value)}><option value="">Supplier (optional)</option>{suppliers.map((s)=><option key={s.id} value={s.id}>{s.name}</option>)}</select><input type="number" min="1" step="1" value={purchaseQuantity} onChange={(e)=>setPurchaseQuantity(e.target.value)} required placeholder="Quantity"/><input type="number" min="0" step="0.01" value={purchaseCost} onChange={(e)=>setPurchaseCost(e.target.value)} required placeholder="Unit cost ₹"/></div><button className="secondary-button" disabled={!purchaseProductId || !branchId}>Save goods receipt</button></form>
          <div className="mini-records">{receipts.slice(0,4).map((receipt)=><div key={receipt.id}><b>{receipt.receiptNumber}</b><span>{receipt.supplierName ?? "Direct purchase"} · ₹{Number(receipt.grandTotal).toFixed(2)}</span></div>)}</div>
        </div>
        <div className="panel-card"><div className="panel-heading"><div><span className="eyebrow">RETURNS</span><h3>Process a product return</h3></div></div>
          <form className="inline-form" onSubmit={processReturn}><select value={returnSaleId} onChange={(e)=>{setReturnSaleId(e.target.value);setReturnProductId("");}} required><option value="">Select completed sale</option>{sales.filter((s)=>["confirmed","fulfilled"].includes(s.status)).map((s)=><option key={s.id} value={s.id}>{s.orderNumber} · ₹{Number(s.grandTotal).toFixed(2)}</option>)}</select><select value={returnProductId} onChange={(e)=>setReturnProductId(e.target.value)} required><option value="">Select returned product</option>{sales.find((s)=>s.id===returnSaleId)?.items.map((item)=><option key={item.productId} value={item.productId}>{products.find((p)=>p.id===item.productId)?.name ?? item.productId} · sold {item.quantity}</option>)}</select><input type="number" min="1" step="1" value={returnQuantity} onChange={(e)=>setReturnQuantity(e.target.value)} required placeholder="Return quantity"/><button className="secondary-button" disabled={!returnSaleId || !returnProductId}>Accept & restock return</button></form>
          <small className="muted">Accepted units are restocked. Refund processing is not yet connected to a payment provider.</small>
        </div>

        <div className="panel-card"><div className="panel-heading"><div><span className="eyebrow">ONLINE PRESENCE</span><h3>Your individual store website</h3></div><span className={storeSettings?.isPublished ? "live-label" : "muted"}>{storeSettings?.isPublished ? "● PUBLISHED" : "NOT PUBLISHED"}</span></div>
          <form className="inline-form" onSubmit={saveStorefront}><label className="store-setting-label">Store display name<input value={storeDisplayName} onChange={(e)=>setStoreDisplayName(e.target.value)} required placeholder="Shop name"/></label><div className="form-grid"><label className="store-setting-label">Brand colour<input type="color" value={storeColor} onChange={(e)=>setStoreColor(e.target.value)}/></label><label className="store-setting-label">Support phone<input value={storeSupportPhone} onChange={(e)=>setStoreSupportPhone(e.target.value)} placeholder="Customer support"/></label></div><label className="store-setting-label">Support email<input type="email" value={storeSupportEmail} onChange={(e)=>setStoreSupportEmail(e.target.value)} placeholder="support@yourshop.com"/></label><button className="secondary-button">Save store settings</button><button type="button" className="secondary-button" onClick={()=>void toggleStorefrontPublish()}>{storeSettings?.isPublished ? "Unpublish store" : "Publish online store"}</button></form>
          <p className="store-url">https://{activeShop?.slug ?? "your-shop"}.usms.in</p>
        </div>

        <div className="panel-card"><div className="panel-heading"><div><span className="eyebrow">PAYMENTS</span><h3>Razorpay account</h3></div><span className={gatewaySettings?.isEnabled ? "live-label" : "muted"}>{gatewaySettings?.isEnabled ? "● CONNECTED" : "NOT CONNECTED"}</span></div>
          <p className="muted">Each shop connects its own Razorpay merchant account. Settlements go to that merchant account, not through USMS.</p>
          <form className="inline-form" onSubmit={saveGateway}><label className="store-setting-label">Mode<select value={gatewayMode} onChange={(e)=>setGatewayMode(e.target.value as "test" | "live")}><option value="test">Test mode</option><option value="live">Live mode</option></select></label><label className="store-setting-label">Razorpay Key ID<input value={gatewayKeyId} onChange={(e)=>setGatewayKeyId(e.target.value)} required placeholder="rzp_test_…"/></label><label className="store-setting-label">Razorpay Key Secret<input type="password" value={gatewayKeySecret} onChange={(e)=>setGatewayKeySecret(e.target.value)} required placeholder="Paste merchant key secret"/></label><label className="store-setting-label">Webhook Secret<input type="password" value={gatewayWebhookSecret} onChange={(e)=>setGatewayWebhookSecret(e.target.value)} required placeholder="Webhook secret from Razorpay"/></label><button className="secondary-button">Save payment credentials</button></form>
          <small className="muted">Credentials are encrypted before storage and are never returned to the browser. Use test keys until webhook and payment tests are complete.</small>
        </div>
        <div className="panel-card"><div className="panel-heading"><div><span className="eyebrow">DAILY SNAPSHOT</span><h3>Business overview</h3></div></div>
          <div className="report-list"><div><span>Today's POS revenue</span><b>₹{Number(overview?.today.posRevenue ?? 0).toFixed(2)}</b></div><div><span>POS sales today</span><b>{overview?.today.posSalesCount ?? 0}</b></div><div><span>Purchase spend today</span><b>₹{Number(overview?.today.purchaseSpend ?? 0).toFixed(2)}</b></div><div><span>Online orders awaiting payment</span><b>{overview?.online.pendingOrders ?? 0}</b></div></div>
        </div>
      </section>
      <footer className="business-footer"><span>USMS · Unified Store Management System</span><span>Shop ID · {tenantId.slice(0,8)}</span></footer>
    </section>
  </main>;
}
