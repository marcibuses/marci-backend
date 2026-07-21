/**
 * MARCI BUSES — backend de checkout (Webpay Plus / Transbank)
 * ------------------------------------------------------------
 * Este servidor hace 3 cosas:
 *  1) Recibe el carrito desde el sitio y calcula el total EN EL SERVIDOR
 *     (nunca confiar en el monto que manda el navegador).
 *  2) Crea la transacción en Transbank (WebpayPlus.Transaction.create).
 *  3) Confirma la transacción cuando Transbank redirige de vuelta
 *     (WebpayPlus.Transaction.commit) y muestra el resultado.
 *
 * Por defecto corre en modo INTEGRACIÓN (sandbox de pruebas de Transbank),
 * usando las credenciales públicas de prueba que trae el propio SDK.
 * Para cobrar de verdad, sigue los pasos del README.md de esta carpeta.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const {
  WebpayPlus,
  Options,
  IntegrationApiKeys,
  IntegrationCommerceCodes,
  Environment,
} = require("transbank-sdk");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || "http://localhost:8080";

/* ------------------------------------------------------------------
   Catálogo de eventos — DEBE coincidir con EVENTS_CONFIG en js/main.js
   Se repite aquí a propósito: el precio real que se cobra sale de este
   archivo (servidor), nunca del navegador del cliente.
   ------------------------------------------------------------------ */
const EVENTS = {
  "bts-world-tour-arirang": { title: "BTS World Tour Arirang — Estadio Nacional", price: 9990 },
  "jamiroquai-claro-arena": { title: "Jamiroquai — Claro Arena", price: 10990 },
  "slayer-reign-in-blood": { title: "Slayer: Reign in Blood — Santa Laura USEK", price: 9990 },
  "rosalia-lux-tour": { title: "Rosalía: LUX Tour 2026 — Movistar Arena", price: 9990 },
};

/* ------------------------------------------------------------------
   Configuración de Transbank
   - Modo por defecto: INTEGRATION (pruebas, no cobra dinero real)
   - Modo producción: se activa solo si defines las 3 variables de
     entorno TBK_COMMERCE_CODE, TBK_API_KEY y TBK_ENV=production
   ------------------------------------------------------------------ */
function getWebpayTransaction() {
  const isProduction = process.env.TBK_ENV === "production";

  if (isProduction) {
    if (!process.env.TBK_COMMERCE_CODE || !process.env.TBK_API_KEY) {
      throw new Error(
        "Faltan TBK_COMMERCE_CODE / TBK_API_KEY en .env para correr en producción."
      );
    }
    return new WebpayPlus.Transaction(
      new Options(process.env.TBK_COMMERCE_CODE, process.env.TBK_API_KEY, Environment.Production)
    );
  }

  // Sandbox / integración — credenciales públicas de prueba de Transbank
  return new WebpayPlus.Transaction(
    new Options(IntegrationCommerceCodes.WEBPAY_PLUS, IntegrationApiKeys.WEBPAY, Environment.Integration)
  );
}

/* ------------------------------------------------------------------
   POST /api/webpay/create
   Body: { items: [{ id, qty }, ...] }
   ------------------------------------------------------------------ */
app.post("/api/webpay/create", async (req, res) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Carrito vacío o inválido." });
    }

    let amount = 0;
    for (const { id, qty } of items) {
      const ev = EVENTS[id];
      if (!ev || !Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ error: `Item inválido: ${id}` });
      }
      amount += ev.price * qty;
    }

    const buyOrder = "MB" + Date.now(); // identificador único de la orden
    const sessionId = "session-" + Date.now();
    // OJO: el returnUrl apunta a ESTE mismo backend (no a un archivo .html estático),
    // porque Transbank vuelve con un POST y solo un servidor puede leer ese body.
    const returnUrl = `${req.protocol}://${req.get("host")}/webpay/return`;

    const tx = getWebpayTransaction();
    const response = await tx.create(buyOrder, sessionId, amount, returnUrl);

    // Guarda buyOrder/monto en tu base de datos aquí, asociado al token,
    // para poder verificar la compra cuando Transbank confirme el pago.

    res.json({ url: response.url, token: response.token });
  } catch (err) {
    console.error("Error creando transacción Webpay:", err);
    res.status(500).json({ error: "No se pudo crear la transacción." });
  }
});

/* ------------------------------------------------------------------
   POST /api/webpay/commit
   Body: { token_ws }
   Transbank redirige al usuario de vuelta a tu returnUrl con
   token_ws en el body (POST). Esa página debe llamar a este endpoint
   para confirmar el pago antes de mostrar "compra exitosa".
   ------------------------------------------------------------------ */
app.post("/api/webpay/commit", async (req, res) => {
  try {
    const { token_ws } = req.body;
    if (!token_ws) return res.status(400).json({ error: "Falta token_ws." });

    const tx = getWebpayTransaction();
    const result = await tx.commit(token_ws);

    // result.status === "AUTHORIZED" y result.response_code === 0 → pago aprobado
    res.json(result);
  } catch (err) {
    console.error("Error confirmando transacción Webpay:", err);
    res.status(500).json({ error: "No se pudo confirmar la transacción." });
  }
});

/* ------------------------------------------------------------------
   POST /webpay/return  (y GET, por si el usuario cancela)
   Transbank redirige aquí (POST) con token_ws si el pago se realizó,
   o con TBK_TOKEN si el usuario canceló en Webpay. Confirmamos server-side
   y recién ahí mandamos al navegador a la página de resultado, vía
   redirect 303 con query params simples (nunca el token ni datos sensibles).
   ------------------------------------------------------------------ */
async function handleWebpayReturn(req, res) {
  const params = { ...req.query, ...req.body };
  const tokenWs = params.token_ws;
  const tokenCanceled = params.TBK_TOKEN;

  if (tokenCanceled && !tokenWs) {
    return res.redirect(303, `${SITE_URL}/checkout-retorno.html?status=cancelado`);
  }
  if (!tokenWs) {
    return res.redirect(303, `${SITE_URL}/checkout-retorno.html?status=error`);
  }

  try {
    const tx = getWebpayTransaction();
    const result = await tx.commit(tokenWs);

    // Aquí es el lugar para guardar el resultado en tu base de datos
    // (result.status, result.buy_order, result.amount, result.card_detail, etc.)

    const approved = result.response_code === 0 || result.status === "AUTHORIZED";
    const status = approved ? "aprobado" : "rechazado";
    return res.redirect(
      303,
      `${SITE_URL}/checkout-retorno.html?status=${status}&order=${encodeURIComponent(result.buy_order || "")}`
    );
  } catch (err) {
    console.error("Error confirmando transacción Webpay:", err);
    return res.redirect(303, `${SITE_URL}/checkout-retorno.html?status=error`);
  }
}
app.post("/webpay/return", handleWebpayReturn);
app.get("/webpay/return", handleWebpayReturn);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Servidor de checkout Marci Buses escuchando en puerto ${PORT}`);
  console.log(`Modo Transbank: ${process.env.TBK_ENV === "production" ? "PRODUCCIÓN" : "INTEGRACIÓN (pruebas)"}`);
});
