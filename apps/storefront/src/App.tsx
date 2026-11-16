import { useEffect, useMemo, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";
type Product = { id: string; sku: string; name: string; description: string | null; price: string; taxRate: string; availableStock: number };
type Store = { displayName: string; primaryColor: string; logoUrl?: string | null; supportEmail?: string | null; supportPhone?: string | null };
type OrderResult = { order: { id: string; orderNumber: string; grandTotal: string; reservationExpiresAt: string }; trackingToken: string; checkout: { status: string; message: string } };

function resolveStoreSlug() {
  const configured = import.meta.env.VITE_STORE_SLUG as string | undefined;
  if (configured) return configured;
  const querySlug = new URLSearchParams(window.location.search).get("store");
  if (querySlug) return querySlug;
  const host = window.location.hostname;
  return host.endsWith(".usms.in") ? host.split(".")[0] : "";
}

export default function App() {
  const slug = useMemo(resolveStoreSlug, []);
  const [store, setStore] = useState<Store | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [order, setOrder] = useState<OrderResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function loadStore() {
    if (!slug) {
      setError("Open this page using your shop address, or add ?store=your-shop-slug while testing locally.");
      setLoading(false);
      return;
    }
    try {
      const response = await fetch(`${API_URL}/api/v1/storefront/${encodeURIComponent(slug)}`);
      const data = await response.json() as { store?: Store; products?: Product[]; error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "Could not load this store.");
      setStore(data.store ?? null);
      setProducts(data.products ?? []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Store is temporarily unavailable.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadStore(); }, [slug]);

  const cartItems = products.filter((product) => (cart[product.id] ?? 0) > 0);
  const subtotal = cartItems.reduce((sum, product) => sum + Number(product.price) * cart[product.id], 0);
  const tax = cartItems.reduce((sum, product) => sum + Number(product.price) * cart[product.id] * Number(product.taxRate) / 100, 0);
  const total = subtotal + tax;

  function changeQuantity(product: Product, delta: number) {
    setCart((current) => {
      const next = Math.max(0, Math.min(product.availableStock, (current[product.id] ?? 0) + delta));
      return { ...current, [product.id]: next };
    });
  }

  async function checkout(event: React.FormEvent) {
    event.preventDefault();
    if (!cartItems.length || !customerName.trim() || !customerPhone.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/v1/storefront/${encodeURIComponent(slug)}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          customerName,
          customerPhone,
          items: cartItems.map((product) => ({ productId: product.id, quantity: cart[product.id] })),
        }),
      });
      const data = await response.json() as OrderResult & { error?: { message?: string } };
      if (!response.ok) throw new Error(data.error?.message ?? "Checkout could not be completed.");
      setOrder(data);
      setCart({});
      await loadStore();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="store-shell" style={{ "--store-color": store?.primaryColor ?? "#b7f18b" } as React.CSSProperties}>
    <header className="store-header">
      <a className="store-brand" href="#"><span className="store-mark">{store?.displayName?.slice(0, 1) ?? "U"}</span><span>{store?.displayName ?? "USMS Store"}</span></a>
      <div className="store-header-right"><span className="live-dot" /> LIVE STORE <a className="cart-pill" href="#cart">Cart · {cartItems.reduce((n, p) => n + cart[p.id], 0)}</a></div>
    </header>
    <section className="store-hero">
      <div className="hero-copy"><span className="store-eyebrow">YOUR LOCAL STORE, ONLINE</span><h1>Good finds.<br/><em>Right around you.</em></h1><p>Shop directly from {store?.displayName ?? "your neighbourhood store"}. Product availability is connected to the same inventory used at the physical counter.</p><a className="store-cta" href="#catalog">Explore products <span>↘</span></a></div>
      <div className="hero-art"><div className="hero-orbit orbit-one"/><div className="hero-orbit orbit-two"/><div className="hero-bag">US<span>+</span></div><div className="hero-sticker">LOCAL<br/>PICKS</div></div>
      <div className="hero-foot"><span>01 / SHOP LOCAL</span><span>LIVE INVENTORY · DIRECT FROM THE STORE</span></div>
    </section>
    {order && <section className="order-success"><span className="store-eyebrow">ORDER RESERVED</span><h2>You're almost there.</h2><p>Order <b>{order.order.orderNumber}</b> is reserved. {order.checkout.message}</p><p className="tracking">Keep your tracking code safe: <code>{order.trackingToken}</code></p><button onClick={() => setOrder(null)}>Continue shopping</button></section>}
    <section className="catalog-section" id="catalog">
      <div className="section-head"><div><span className="store-eyebrow">THE SHOP FLOOR</span><h2>Made available <em>for you.</em></h2></div><span className="product-count">{products.length.toString().padStart(2, "0")} PRODUCTS</span></div>
      {loading ? <p className="state-message">Loading your store…</p> : error && !products.length ? <p className="state-message error">{error}</p> : products.length ? <div className="product-grid">{products.map((product, index) => <article className="product-card" key={product.id}>
        <div className={`product-visual visual-${index % 4}`}><span className="product-number">0{index + 1}</span><span className="product-glyph">{product.name.slice(0, 1).toUpperCase()}</span><span className="stock-tag">{product.availableStock > 0 ? `${product.availableStock} IN STOCK` : "SOLD OUT"}</span></div>
        <div className="product-info"><div><h3>{product.name}</h3><p>{product.description || product.sku}</p></div><strong>₹{Number(product.price).toFixed(2)}</strong></div>
        <button className="add-button" disabled={product.availableStock <= 0 || (cart[product.id] ?? 0) >= product.availableStock} onClick={() => changeQuantity(product, 1)}>{product.availableStock <= 0 ? "Out of stock" : "Add to bag"} <span>＋</span></button>
        {(cart[product.id] ?? 0) > 0 && <div className="quantity-control"><button onClick={() => changeQuantity(product, -1)}>−</button><b>{cart[product.id]}</b><button onClick={() => changeQuantity(product, 1)}>＋</button></div>}
      </article>)}</div> : <p className="state-message">This store has not added any products yet.</p>}
      {error && products.length > 0 && <p className="inline-error">{error}</p>}
    </section>
    <section className="checkout-section" id="cart">
      <div><span className="store-eyebrow">YOUR BAG</span><h2>Ready when <em>you are.</em></h2><p>Orders reserve stock for 15 minutes while payment setup is completed.</p></div>
      <form className="checkout-card" onSubmit={checkout}>
        <div className="checkout-row"><span>{cartItems.reduce((n, p) => n + cart[p.id], 0)} items</span><b>₹{total.toFixed(2)}</b></div>
        {cartItems.length ? cartItems.map((product) => <div className="cart-line" key={product.id}><span>{product.name} × {cart[product.id]}</span><b>₹{(Number(product.price) * cart[product.id]).toFixed(2)}</b></div>) : <p className="empty-cart">Your bag is waiting for something good.</p>}
        <label>Your name<input value={customerName} onChange={(e) => setCustomerName(e.target.value)} required placeholder="Full name"/></label>
        <label>Mobile number<input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} required inputMode="tel" placeholder="10-digit mobile number"/></label>
        <button className="checkout-button" disabled={!cartItems.length || submitting}>{submitting ? "Reserving stock…" : "Reserve order · ₹" + total.toFixed(2)}</button>
        <small>Secure stock reservation · Payment gateway integration pending</small>
      </form>
    </section>
    <footer className="store-footer"><span>{store?.displayName ?? "USMS Store"}</span><span>POWERED BY USMS · ONE STORE, ONE LIVE INVENTORY</span>{store?.supportPhone && <a href={`tel:${store.supportPhone}`}>{store.supportPhone}</a>}</footer>
  </main>;
}
