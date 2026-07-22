/**
 * MARCI BUSES — backend de checkout (Webpay Plus / Transbank)
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

const EVENTS = {
  "bts-world-tour-arirang": { title: "BTS World Tour Arirang — Estadio Nacional", price: 9990 },
  "jamiroquai-claro-arena": { title: "Jamiroquai — Claro Arena", price: 10990 },
  "slayer-reign-in-blood": { title: "Slayer: Reign in Blood — Santa Laura USEK", price: 9990 },
  "rosalia-lux-tour": { title: "Rosalía: LUX Tour 2026 — Movistar Arena", price: 9990 },
};

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

  return new WebpayPlus.Transaction(
    new Options(IntegrationCommerceCodes.WEBPAY_PLUS, IntegrationApiKeys.WEBPAY, Environment.Integration)
  );
}

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

    const buyOrder = "MB" + Date.now();
    const sessionId = "session-" + Date.now();
    const returnUrl = `${req.protocol}://${req.get("host")}/webpay/return`;

    const tx = getWebpayTransaction();
    const response = await tx.create(buyOrder, sessionId, amount, returnUrl);

    res.json({ url: response.url, token: response.token });
  } catch (err) {
    console.error("Error creando transacción Webpay:", err);
    res.status(500).json({ error: "No se pudo crear la transacción." });
  }
});

app.post("/api/webpay/commit", async (req, res) => {
  try {
    const { token_ws } = req.body;
    if (!token_ws) return res.status(400).json({ error: "Falta token_ws." });

    const tx = getWebpayTransaction();
    const result = await tx.commit(token_ws);

    res.json(result);
  } catch (err) {
    console.error("Error confirmando transacción Webpay:", err);
    res.status(500).json({ error: "No se pudo confirmar la transacción." });
  }
});

function resultPage({ titulo, mensaje, ok }) {
  const color = ok ? "#0a8f8a" : "#b3413b";
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titulo} | Marci Buses</title>
<style>
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f3f6f8;
       display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;}
  .card{max-width:460px;width:100%;background:#fff;border-radius:14px;padding:44px 32px;text-align:center;
        box-shadow:0 20px 50px -20px rgba(11,36,57,.35);}
  h1{font-size:26px;margin:0 0 12px;color:${color};}
  p{color:#4a5b6c;margin:0 0 26px;line-height:1.6;}
  a{display:inline-block;background:#0f2c46;color:#fff;text-decoration:none;
    padding:14px 28px;border-radius:999px;font-weight:600;}
</style></head><body>
  <div class="card">
    <h1>${titulo}</h1>
    <p>${mensaje}</p>
    <a href="${SITE_URL}">Volver al sitio</a>
  </div>
<script>if(${ok ? "true" : "false"}){try{localStorage.removeItem('marcibuses_cart_v1');}catch(e){}}</script>
</body></html>`;
}

async function handleWebpayReturn(req, res) {
  const params = { ...req.query, ...req.body };
  const tokenWs = params.token_ws;
  const tokenCanceled = params.TBK_TOKEN;

  if (tokenCanceled && !tokenWs) {
    return res.send(resultPage({
      titulo: "Pago cancelado",
      mensaje: "Cancelaste el pago en Webpay. Tu carrito sigue disponible en el sitio.",
      ok: false
    }));
  }
  if (!tokenWs) {
    return res.send(resultPage({
      titulo: "No se encontró información de pago",
      mensaje: "Vuelve al sitio e intenta nuevamente.",
      ok: false
    }));
  }

  try {
    const tx = getWebpayTransaction();
    const result = await tx.commit(tokenWs);

    const approved = result.response_code === 0 || result.status === "AUTHORIZED";
    if (approved) {
      return res.send(resultPage({
        titulo: "¡Pago exitoso!",
        mensaje: `Tu reserva quedó confirmada${result.buy_order ? ` (orden ${result.buy_order})` : ""}. Te enviaremos la confirmación por email.`,
        ok: true
      }));
    }
    return res.send(resultPage({
      titulo: "El pago no se pudo completar",
      mensaje: "Intenta nuevamente o contáctanos por WhatsApp.",
      ok: false
    }));
  } catch (err) {
    console.error("Error confirmando transacción Webpay:", err);
    return res.send(resultPage({
      titulo: "Error al confirmar el pago",
      mensaje: "Si el dinero fue descontado, contáctanos y lo verificamos manualmente.",
      ok: false
    }));
  }
}
app.post("/webpay/return", handleWebpayReturn);
app.get("/webpay/return", handleWebpayReturn);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Servidor de checkout Marci Buses escuchando en puerto ${PORT}`);
  console.log(`Modo Transbank: ${process.env.TBK_ENV === "production" ? "PRODUCCIÓN" : "INTEGRACIÓN (pruebas)"}`);
});
